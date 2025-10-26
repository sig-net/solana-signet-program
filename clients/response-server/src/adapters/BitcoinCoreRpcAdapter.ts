import {
  IBitcoinAdapter,
  BitcoinTransactionInfo,
  UTXO,
} from './IBitcoinAdapter';
import Client from 'bitcoin-core';

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
      const tx = await this.client.command('gettransaction', txid);

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
        error.message.includes('Invalid or non-wallet transaction')
      ) {
        throw new Error(`Transaction ${txid} not found in wallet`);
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
