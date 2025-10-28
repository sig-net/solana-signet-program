import {
  IBitcoinAdapter,
  BitcoinTransactionInfo,
  UTXO,
} from './IBitcoinAdapter';
import Client from 'bitcoin-core';

/**
 * Bitcoin Core RPC Adapter
 *
 * Direct connection to Bitcoin Core node via JSON-RPC.
 * Primarily used for regtest (local development).
 *
 * Network: regtest (local Bitcoin network for testing)
 * Address Format: bcrt1q... (P2WPKH/Bech32)
 * Connection: localhost:18443 (default regtest port)
 *
 * RPC Commands Used:
 * - getrawtransaction: Get transaction details (verbose mode)
 * - getblockcount: Get current block height
 * - scantxoutset: Find UTXOs for an address
 * - sendrawtransaction: Broadcast signed transaction
 * - generatetoaddress: Mine blocks (regtest only)
 * - sendtoaddress: Send BTC to address (regtest only)
 *
 * Units: All RPC amounts use BTC, converted to satoshis for interface:
 * - RPC returns: 0.001 BTC
 * - Interface returns: 100000 satoshis
 * - Conversion: 1 BTC = 100,000,000 satoshis
 *
 * Setup (Docker):
 * 1. Clone: git clone https://github.com/Pessina/bitcoin-regtest.git
 * 2. Run: yarn docker:dev
 * 3. Wait for bitcoind to start on localhost:18443
 * 4. Web UI available at http://localhost:5173
 *
 * @example
 * const adapter = BitcoinCoreRpcAdapter.createRegtestAdapter();
 * await adapter.mineBlocks(10, 'bcrt1q...');
 * const txid = await adapter.fundAddress('bcrt1q...', 1.0);
 */
export class BitcoinCoreRpcAdapter implements IBitcoinAdapter {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.command('getblockchaininfo');
      return true;
    } catch (error) {
      return false;
    }
  }

  async getTransaction(txid: string): Promise<BitcoinTransactionInfo> {
    try {
      // Use getrawtransaction with verbose=true to get ANY transaction
      // (not just wallet transactions like gettransaction does)
      const tx = await this.client.command('getrawtransaction', txid, true);

      return {
        txid: tx.txid,
        confirmed: tx.confirmations > 0,
        blockHeight: tx.blockheight,
        blockHash: tx.blockhash,
        confirmations: tx.confirmations || 0,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('No such mempool or blockchain transaction') ||
          error.message.includes('Invalid or non-wallet transaction'))
      ) {
        throw new Error(`Transaction ${txid} not found`);
      }
      throw error;
    }
  }

  async getCurrentBlockHeight(): Promise<number> {
    return await this.client.command('getblockcount');
  }

  async getAddressUtxos(address: string): Promise<UTXO[]> {
    const result = await this.client.command('scantxoutset', 'start', [
      `addr(${address})`,
    ]);

    return result.unspents.map((utxo: any) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: Math.round(utxo.amount * 100000000),
      status: {
        confirmed: true,
      },
    }));
  }

  async getTransactionHex(txid: string): Promise<string> {
    return await this.client.command('getrawtransaction', txid, false);
  }

  async broadcastTransaction(txHex: string): Promise<string> {
    return await this.client.command('sendrawtransaction', txHex);
  }

  async mineBlocks(count: number, address: string): Promise<string[]> {
    return await this.client.command('generatetoaddress', count, address);
  }

  async fundAddress(address: string, amount: number): Promise<string> {
    // Send BTC to the address
    const txid = await this.client.command('sendtoaddress', address, amount);

    // Mine 1 block to confirm the transaction
    const minerAddress = await this.client.command('getnewaddress');
    await this.client.command('generatetoaddress', 1, minerAddress);

    return txid;
  }

  getClient(): Client {
    return this.client;
  }

  static createRegtestAdapter(): BitcoinCoreRpcAdapter {
    const client = new Client({
      host: 'http://localhost:18443',
      username: 'test',
      password: 'test123',
    });

    return new BitcoinCoreRpcAdapter(client);
  }
}
