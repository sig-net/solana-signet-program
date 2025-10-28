import { IBitcoinAdapter } from './IBitcoinAdapter';
import { MempoolSpaceAdapter } from './MempoolSpaceAdapter';
import { BitcoinCoreRpcAdapter } from './BitcoinCoreRpcAdapter';
import type { BitcoinNetwork } from '../types/index.js';
import pc from 'picocolors';

/**
 * Bitcoin Adapter Factory
 *
 * Automatically selects the appropriate Bitcoin backend based on network:
 *
 * Network Routing:
 * ┌──────────┬──────────────────────┬─────────────────────────────────┐
 * │ Network  │ Backend              │ Connection                      │
 * ├──────────┼──────────────────────┼─────────────────────────────────┤
 * │ regtest  │ Bitcoin Core RPC     │ localhost:18443 (Docker)        │
 * │ testnet  │ mempool.space API    │ mempool.space/testnet4/api      │
 * │ mainnet  │ mempool.space API    │ mempool.space/api               │
 * └──────────┴──────────────────────┴─────────────────────────────────┘
 *
 * Address Formats by Network:
 * - Mainnet: bc1q... (P2WPKH/Bech32)
 * - Testnet: tb1q... (P2WPKH/Bech32)
 * - Regtest: bcrt1q... (P2WPKH/Bech32)
 *
 * All addresses are native SegWit (Bech32) format for lower fees.
 *
 * @example
 * // Auto-select adapter based on network
 * const adapter = await BitcoinAdapterFactory.create('testnet');
 *
 * // Query testnet transaction
 * const tx = await adapter.getTransaction('abc123...');
 * console.log(`Confirmations: ${tx.confirmations}`);
 *
 * // Get UTXOs for testnet address
 * const utxos = await adapter.getAddressUtxos('tb1q...');
 * console.log(`Total: ${utxos.reduce((sum, u) => sum + u.value, 0)} sats`);
 */
export class BitcoinAdapterFactory {
  /**
   * Creates appropriate Bitcoin adapter for the specified network
   *
   * @param network - 'regtest' | 'testnet' | 'mainnet'
   * @returns Configured adapter ready to use
   * @throws Error if regtest backend is not running
   */
  static async create(network: BitcoinNetwork): Promise<IBitcoinAdapter> {
    if (network === 'regtest') {
      const adapter = BitcoinCoreRpcAdapter.createRegtestAdapter();

      const available = await adapter.isAvailable();
      if (!available) {
        throw new Error(
          `❌ Bitcoin regtest is not running!\n\n` +
            `To start bitcoin-regtest with Docker:\n` +
            `  1. Clone: git clone https://github.com/Pessina/bitcoin-regtest.git\n` +
            `  2. Run: yarn docker:dev\n` +
            `  3. Wait for Bitcoin Core to start\n` +
            `  4. Restart this server\n\n` +
            `Expected: bitcoind running on localhost:18443\n` +
            `Web UI: http://localhost:5173\n` +
            `See: https://github.com/Pessina/bitcoin-regtest`
        );
      }

      console.log(pc.green('✅ Using Bitcoin Core RPC adapter ') + pc.magenta(`(${network})`));
      return adapter;
    }

    const adapter = MempoolSpaceAdapter.create(network);

    const available = await adapter.isAvailable();
    if (!available) {
      const url = network === 'testnet'
        ? 'https://mempool.space/testnet4/api'
        : 'https://mempool.space/api';
      console.warn(
        pc.yellow(`⚠️  Warning: mempool.space API at ${pc.cyan(url)} is not responding`)
      );
    }

    console.log(pc.green('✅ Using mempool.space adapter ') + pc.magenta(`(${network})`));
    return adapter;
  }
}
