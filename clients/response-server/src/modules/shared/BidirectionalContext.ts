import type * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import type { PendingTransaction, ServerConfig } from '../../types';

export interface BidirectionalHandlerContext {
  program: Program;
  wallet: anchor.Wallet;
  config: ServerConfig;
  pendingTransactions: Map<string, PendingTransaction>;
}
