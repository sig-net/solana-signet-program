import type {
  PendingTransaction,
  ServerConfig,
  SignatureResponse,
} from '../../types';

/**
 * Context passed to bidirectional handlers for both Solana and Substrate.
 * Contains chain-agnostic dependencies and a signature sender abstraction.
 */
export interface BidirectionalHandlerContext {
  /**
   * Chain-agnostic signature sender (Solana program or Substrate monitor).
   * Implementations wrap the underlying RPC in the server's timeout guard.
   * Returns a transaction reference when the source chain provides one.
   */
  sendSignatures: (
    requestIds: Uint8Array[],
    signatures: SignatureResponse[],
    label: string
  ) => Promise<string | undefined>;

  /** Server configuration (MPC keys, network settings, etc.) */
  config: ServerConfig;
  pendingTransactions: Map<string, PendingTransaction>;

  /** Source chain: 'solana' or 'polkadot' */
  source: 'solana' | 'polkadot';
}
