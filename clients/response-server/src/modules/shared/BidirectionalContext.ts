import type * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import type { PendingTransaction, ServerConfig } from '../../types';
import { AppLogger } from '../logger/AppLogger';

export interface BidirectionalHandlerContext {
  program: Program;
  wallet: anchor.Wallet;
  config: ServerConfig;
  logger: AppLogger;
  pendingTransactions: Map<string, PendingTransaction>;
}
