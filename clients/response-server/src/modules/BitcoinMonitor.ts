import type {
  TransactionStatus,
  TransactionOutputData,
  ServerConfig,
} from '../types';

interface BitcoinTransaction {
  txid: string;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
  };
}

/**
 * Bitcoin transaction monitor using mempool.space API
 *
 * Networks:
 * - Testnet4: https://mempool.space/testnet4/api (isDevnet: true)
 * - Mainnet: https://mempool.space/api (isDevnet: false)
 *
 * Features:
 * - Confirmation monitoring (default: 1 confirmation)
 * - Simple boolean output: { success: true }
 *
 * Note: Transactions are broadcast by the client, not the server.
 *
 * @example
 * // Monitor for confirmations (after client broadcasts)
 * const result = await BitcoinMonitor.waitForTransactionAndGetOutput(
 *   txid,
 *   "bip122:00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
 *   schema,
 *   fromAddress,
 *   0,
 *   config
 * );
 * // result = { status: 'success', success: true, output: { success: true } }
 */
export class BitcoinMonitor {
  private static providerCache = new Map<string, string>();

  static async waitForTransactionAndGetOutput(
    txid: string,
    caip2Id: string,
    config: ServerConfig
  ): Promise<TransactionStatus> {
    const apiBaseUrl = this.getApiBaseUrl(caip2Id, config);
    const requiredConfs = config.bitcoinRequiredConfirmations || 1;
    const networkName = config.isDevnet ? 'Testnet4' : 'Mainnet';

    try {
      const txUrl = `${apiBaseUrl}/tx/${txid}`;
      const response = await fetch(txUrl);

      if (!response.ok) {
        console.log(`⏳ ${networkName} tx ${txid}: not found yet`);
        return { status: 'pending' };
      }

      const tx = (await response.json()) as BitcoinTransaction;

      if (!tx.status?.confirmed) {
        console.log(`⏳ ${networkName} tx ${txid}: in mempool (0 confs)`);
        return { status: 'pending' };
      }

      const tipHeightUrl = `${apiBaseUrl}/blocks/tip/height`;
      const tipResponse = await fetch(tipHeightUrl);
      const currentHeight = parseInt(await tipResponse.text());

      const confirmations = currentHeight - tx.status.block_height! + 1;

      if (confirmations < requiredConfs) {
        console.log(
          `⏳ ${networkName} tx ${txid}: ${confirmations}/${requiredConfs} confirmations`
        );
        return { status: 'pending' };
      }

      console.log(
        `✅ ${networkName} tx ${txid}: ${confirmations} confirmations`
      );
      console.log(`  📦 Block: ${tx.status.block_height}`);
      console.log(`  🔗 Hash: ${tx.status.block_hash?.slice(0, 16)}...`);

      const output: TransactionOutputData = {
        success: true,
      };

      return {
        status: 'success',
        success: true,
        output,
      };
    } catch (error) {
      console.error(`❌ Error checking ${networkName} tx ${txid}:`, error);
      return { status: 'pending' };
    }
  }

  private static getApiBaseUrl(caip2Id: string, config: ServerConfig): string {
    const cacheKey = `${caip2Id}-${config.isDevnet}`;

    if (this.providerCache.has(cacheKey)) {
      return this.providerCache.get(cacheKey)!;
    }

    const baseUrl = config.isDevnet
      ? 'https://mempool.space/testnet4/api'
      : 'https://mempool.space/api';

    this.providerCache.set(cacheKey, baseUrl);
    return baseUrl;
  }
}
