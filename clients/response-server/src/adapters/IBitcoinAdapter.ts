/**
 * Bitcoin Transaction Information
 *
 * @property txid - Transaction ID (64-char hex string)
 * @property confirmed - Whether transaction is in a block (not just mempool)
 * @property blockHeight - Block number (undefined if in mempool)
 * @property blockHash - Block hash (undefined if in mempool)
 * @property confirmations - Number of confirmations (0 = mempool)
 */
export interface BitcoinTransactionInfo {
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  confirmations: number;
}

/**
 * Unspent Transaction Output (UTXO)
 *
 * Bitcoin uses UTXOs as inputs for new transactions.
 *
 * Units: Value is always in SATOSHIS (1 BTC = 100,000,000 satoshis)
 *
 * @property txid - Transaction ID containing this output
 * @property vout - Output index in the transaction (0-indexed)
 * @property value - Amount in SATOSHIS (not BTC)
 * @property status - Confirmation status (optional, from mempool.space)
 *
 * @example
 * // UTXO with 0.001 BTC (100,000 satoshis)
 * {
 *   txid: "abc123...",
 *   vout: 0,
 *   value: 100000,  // satoshis
 *   status: { confirmed: true }
 * }
 */
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
 * Unified interface for Bitcoin operations across different networks.
 *
 * Network & Address Formats:
 * ┌──────────┬────────────────────┬─────────────────────┐
 * │ Network  │ Address Prefix     │ Example             │
 * ├──────────┼────────────────────┼─────────────────────┤
 * │ Mainnet  │ bc1q... (P2WPKH)   │ bc1qxy2kgdygjrsq... │
 * │ Testnet  │ tb1q... (P2WPKH)   │ tb1qxy2kgdygjrsq... │
 * │ Regtest  │ bcrt1q... (P2WPKH) │ bcrt1qxy2kgdygj...   │
 * └──────────┴────────────────────┴─────────────────────┘
 *
 * Units: All amounts are in SATOSHIS (1 BTC = 100,000,000 sats)
 *
 * Implementations:
 * - BitcoinCoreRpcAdapter: Uses Bitcoin Core RPC (regtest/local node)
 * - MempoolSpaceAdapter: Uses mempool.space REST API (testnet/mainnet)
 *
 * Network selection is automatic via BitcoinAdapterFactory.create(network).
 */
export interface IBitcoinAdapter {
  /**
   * Retrieves transaction information including confirmation status
   *
   * @param txid - Transaction ID (64-char hex, display format)
   * @returns Transaction info with confirmations
   * @throws Error if transaction not found
   */
  getTransaction(txid: string): Promise<BitcoinTransactionInfo>;

  /**
   * Gets the current blockchain height (latest block number)
   *
   * @returns Current block height
   */
  getCurrentBlockHeight(): Promise<number>;

  /**
   * Checks if the Bitcoin backend is available/responding
   *
   * @returns true if available, false otherwise
   */
  isAvailable(): Promise<boolean>;

  /**
   * Fetches all unspent outputs (UTXOs) for a given address
   *
   * Used for building new transactions (inputs).
   *
   * @param address - Bitcoin address (bc1q.../tb1q.../bcrt1q...)
   * @returns Array of UTXOs with amounts in SATOSHIS
   */
  getAddressUtxos(address: string): Promise<UTXO[]>;

  /**
   * Retrieves raw transaction hex (signed, ready to broadcast)
   *
   * @param txid - Transaction ID
   * @returns Hex-encoded transaction
   */
  getTransactionHex(txid: string): Promise<string>;

  /**
   * Broadcasts a signed transaction to the Bitcoin network
   *
   * @param txHex - Hex-encoded signed transaction
   * @returns Transaction ID of broadcast transaction
   * @throws Error if broadcast fails (e.g., invalid signature, insufficient fees)
   */
  broadcastTransaction(txHex: string): Promise<string>;

  /**
   * Mines blocks (regtest only)
   *
   * @param count - Number of blocks to mine
   * @param address - Address to receive mining rewards
   * @returns Array of block hashes
   */
  mineBlocks?(count: number, address: string): Promise<string[]>;

  /**
   * Sends BTC to an address and mines confirmation (regtest only)
   *
   * @param address - Recipient address
   * @param amount - Amount in BTC (not satoshis)
   * @returns Transaction ID
   */
  fundAddress?(address: string, amount: number): Promise<string>;
}
