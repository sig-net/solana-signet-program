export interface BitcoinTransactionInfo {
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  confirmations: number;
}

export interface UTXO {
  txid: string;
  vout: number;
  value: number;
  status?: {
    confirmed: boolean;
    block_height?: number;
  };
}

/**
 * Bitcoin Client Abstraction Layer
 *
 * Provides a unified interface for interacting with Bitcoin via:
 * - Bitcoin Core RPC (regtest/local node)
 * - Mempool.space REST API (testnet/mainnet)
 */
export interface IBitcoinAdapter {
  // Transaction monitoring
  getTransaction(txid: string): Promise<BitcoinTransactionInfo>;
  getCurrentBlockHeight(): Promise<number>;
  isAvailable(): Promise<boolean>;

  // Transaction building & broadcasting
  getAddressUtxos(address: string): Promise<UTXO[]>;
  getTransactionHex(txid: string): Promise<string>;
  broadcastTransaction(txHex: string): Promise<string>;

  // Regtest-only operations (optional)
  mineBlocks?(count: number, address: string): Promise<string[]>;
  fundAddress?(address: string, amount: number): Promise<string>;
}
