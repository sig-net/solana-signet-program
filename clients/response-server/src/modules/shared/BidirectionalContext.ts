import type * as anchor from '@coral-xyz/anchor';
import type pino from 'pino';
import type { Program } from '@coral-xyz/anchor';
import type { PendingTransaction, ServerConfig } from '../../types';

export interface BidirectionalHandlerContext {
  program: Program;
  wallet: anchor.Wallet;
  config: ServerConfig;
  logger: pino.Logger;
  pendingTransactions: Map<string, PendingTransaction>;
}
