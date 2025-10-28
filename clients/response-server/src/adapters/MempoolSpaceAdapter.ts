import {
  IBitcoinAdapter,
  BitcoinTransactionInfo,
  UTXO,
} from './IBitcoinAdapter';
import type { BitcoinNetwork } from '../types/index.js';

interface MempoolTransaction {
  txid: string;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
  };
}

/**
 * Mempool.space REST API Adapter
 *
 * Public API for Bitcoin testnet and mainnet.
 * No authentication required. Rate limits apply.
 *
 * Network Support:
 * ┌──────────┬─────────────────────────────────┬─────────────────────┐
 * │ Network  │ API Endpoint                    │ Address Format      │
 * ├──────────┼─────────────────────────────────┼─────────────────────┤
 * │ Mainnet  │ mempool.space/api               │ bc1q... (P2WPKH)    │
 * │ Testnet  │ mempool.space/testnet4/api      │ tb1q... (P2WPKH)    │
 * └──────────┴─────────────────────────────────┴─────────────────────┘
 *
 * API Endpoints Used:
 * - GET /tx/{txid} - Transaction details
 * - GET /blocks/tip/height - Current block height
 * - GET /address/{address}/utxo - Unspent outputs
 * - GET /tx/{txid}/hex - Raw transaction hex
 * - POST /tx - Broadcast transaction
 *
 * Units: All amounts returned in SATOSHIS (1 BTC = 100,000,000 sats)
 *
 * Rate Limits (as of 2024):
 * - 10 requests per second (burst)
 * - 1 request per second (sustained)
 * - No API key required
 *
 * Note: Does NOT support regtest (use BitcoinCoreRpcAdapter instead).
 *
 * @example
 * // Create testnet adapter
 * const adapter = MempoolSpaceAdapter.create('testnet');
 *
 * // Get testnet transaction
 * const tx = await adapter.getTransaction('abc123...');
 * console.log(`Confirmations: ${tx.confirmations}`);
 *
 * // Get UTXOs for testnet address
 * const utxos = await adapter.getAddressUtxos('tb1q...');
 * const totalSats = utxos.reduce((sum, u) => sum + u.value, 0);
 * console.log(`Balance: ${totalSats} sats (${totalSats / 100000000} BTC)`);
 */
export class MempoolSpaceAdapter implements IBitcoinAdapter {
  private baseUrl: string;

  private constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  static create(network: BitcoinNetwork): MempoolSpaceAdapter {
    const baseUrl = network === 'testnet'
      ? 'https://mempool.space/testnet4/api'
      : 'https://mempool.space/api';
    return new MempoolSpaceAdapter(baseUrl);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/blocks/tip/height`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getTransaction(txid: string): Promise<BitcoinTransactionInfo> {
    const response = await fetch(`${this.baseUrl}/tx/${txid}`);

    if (!response.ok) {
      throw new Error(`Transaction ${txid} not found`);
    }

    const tx = (await response.json()) as MempoolTransaction;
    const currentHeight = await this.getCurrentBlockHeight();

    const confirmations =
      tx.status.confirmed && tx.status.block_height
        ? currentHeight - tx.status.block_height + 1
        : 0;

    return {
      txid: tx.txid,
      confirmed: tx.status.confirmed,
      blockHeight: tx.status.block_height,
      blockHash: tx.status.block_hash,
      confirmations,
    };
  }

  async getCurrentBlockHeight(): Promise<number> {
    const response = await fetch(`${this.baseUrl}/blocks/tip/height`);
    const height = parseInt(await response.text());
    return height;
  }

  async getAddressUtxos(address: string): Promise<UTXO[]> {
    const response = await fetch(`${this.baseUrl}/address/${address}/utxo`);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch UTXOs for ${address}: ${response.statusText}`
      );
    }

    return (await response.json()) as UTXO[];
  }

  async getTransactionHex(txid: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/tx/${txid}/hex`);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch transaction hex: ${response.statusText}`
      );
    }

    return await response.text();
  }

  async broadcastTransaction(txHex: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/tx`, {
      method: 'POST',
      body: txHex,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to broadcast transaction: ${error}`);
    }

    return await response.text();
  }
}
