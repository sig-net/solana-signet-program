import type {
  TransactionStatus,
  TransactionOutputData,
  ServerConfig,
} from '../types';
import { IBitcoinAdapter } from '../adapters/IBitcoinAdapter';
import { BitcoinAdapterFactory } from '../adapters/BitcoinAdapterFactory';
import pc from 'picocolors';

/**
 * Bitcoin transaction monitor using adapter pattern
 *
 * Supports:
 * - mempool.space API (testnet/mainnet)
 * - Bitcoin Core RPC (regtest)
 *
 * Automatically selects adapter based on network:
 * - regtest → Bitcoin Core RPC adapter (localhost:18443)
 * - testnet → mempool.space API (testnet4)
 * - mainnet → mempool.space API
 *
 * Features:
 * - Simple boolean output: { success: true }
 *
 * Note: Transactions are broadcast by the client, not the server.
 */
export class BitcoinMonitor {
  private static adapterCache = new Map<string, IBitcoinAdapter>();

  static async waitForTransactionAndGetOutput(
    txid: string,
    config: ServerConfig
  ): Promise<TransactionStatus> {
    const adapter = await this.getAdapter(config);
    const requiredConfs = 1;

    try {
      const tx = await adapter.getTransaction(txid);

      if (!tx.confirmed) {
        console.log(pc.yellow(`⏳ ${config.bitcoinNetwork} tx ${pc.cyan(txid)}: in mempool (0 confs)`));
        return { status: 'pending' };
      }

      if (tx.confirmations < requiredConfs) {
        console.log(
          pc.yellow(`⏳ ${config.bitcoinNetwork} tx ${pc.cyan(txid)}: ${pc.white(tx.confirmations.toString())}/${pc.white(requiredConfs.toString())} confirmations`)
        );
        return { status: 'pending' };
      }

      console.log(pc.green(`✅ ${config.bitcoinNetwork} tx ${pc.cyan(txid)}: ${pc.white(tx.confirmations.toString())} confirmation(s)`));

      const output: TransactionOutputData = true;

      return {
        status: 'success',
        success: true,
        output,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        console.log(pc.yellow(`⏳ ${config.bitcoinNetwork} tx ${pc.cyan(txid)}: not found`));
        return { status: 'pending' };
      }

      console.error(pc.red(`❌ Error: ${error instanceof Error ? error.message : error}`));
      return { status: 'pending' };
    }
  }

  private static async getAdapter(
    config: ServerConfig
  ): Promise<IBitcoinAdapter> {
    const network = config.bitcoinNetwork;

    if (this.adapterCache.has(network)) {
      return this.adapterCache.get(network)!;
    }

    const adapter = await BitcoinAdapterFactory.create(network);

    this.adapterCache.set(network, adapter);
    return adapter;
  }
}
