import { IBitcoinAdapter } from './IBitcoinAdapter';
import { MempoolSpaceAdapter } from './MempoolSpaceAdapter';
import { BitcoinCoreRpcAdapter } from './BitcoinCoreRpcAdapter';
import type { BitcoinNetwork } from '../types/index.js';
import pc from 'picocolors';

export class BitcoinAdapterFactory {
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
