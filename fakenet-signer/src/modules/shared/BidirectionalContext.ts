import type * as anchor from '@coral-xyz/anchor';
import type { PendingTransaction, ServerConfig } from '../../types';
import type { ChainSignaturesProgram } from '../../types/program';

export interface BidirectionalHandlerContext {
  program: ChainSignaturesProgram;
  wallet: anchor.Wallet;
  config: ServerConfig;
  pendingTransactions: Map<string, PendingTransaction>;
}
