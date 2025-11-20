import type {
  TransactionStatus,
  TransactionOutputData,
  ServerConfig,
  PrevoutRef,
} from '../../types';
import { IBitcoinAdapter } from '../../adapters/IBitcoinAdapter';
import { BitcoinAdapterFactory } from '../../adapters/BitcoinAdapterFactory';
import { AppLogger } from '../logger/AppLogger';

/**
 * Bitcoin transaction monitor using adapter pattern
 *
 * Supports:
 * - mempool.space API (testnet)
 * - Bitcoin Core RPC (regtest)
 *
 * Automatically selects adapter based on network:
 * - regtest → Bitcoin Core RPC adapter (localhost:18443)
 * - testnet → mempool.space API (testnet4)
 *
 * Features:
 * - Structured output object `{ success: true, isFunctionCall: false }`
 *
 * Note: Transactions are broadcast by the client, not the server.
 */
export class BitcoinMonitor {
  private static adapterCache = new Map<string, IBitcoinAdapter>();

  static async waitForTransactionAndGetOutput(
    txid: string,
    prevouts: PrevoutRef[] | undefined,
    config: ServerConfig,
    logger: AppLogger
  ): Promise<TransactionStatus> {
    const adapter = await this.getAdapter(config, logger);
    const colors = AppLogger.colors;
    const requiredConfs = 1;

    try {
      const tx = await adapter.getTransaction(txid);

      if (tx.confirmations < requiredConfs) {
        const conflicted = await this.getConflictedPrevout(
          prevouts,
          adapter,
          logger
        );
        if (conflicted) {
          logger.error(
            {
              txid,
              network: config.bitcoinNetwork,
              conflictedPrevout: conflicted,
            },
            `❌ ${colors.network(config.bitcoinNetwork)} tx ${colors.txid(txid)}: input ${colors.value(`${conflicted.txid}:${conflicted.vout}`)} was spent elsewhere`
          );
          return { status: 'error', reason: 'inputs_spent' };
        }

        const hint = `${tx.confirmations}/${requiredConfs} confirmations`;

        logger.pending(
          {
            txid,
            network: config.bitcoinNetwork,
            confirmations: tx.confirmations,
            requiredConfs,
          },
          `⏳ ${colors.network(config.bitcoinNetwork)} tx ${colors.txid(txid)}: ${colors.hint(hint)}`
        );
        return { status: 'pending' };
      }

      logger.success(
        { txid, network: config.bitcoinNetwork, confirmations: tx.confirmations },
        `✅ ${colors.network(config.bitcoinNetwork)} tx ${colors.txid(txid)}: ${colors.value(tx.confirmations)} confirmation(s)`
      );

      const output: TransactionOutputData = {
        success: true,
        isFunctionCall: false,
      };

      return {
        status: 'success',
        success: true,
        output,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        const conflicted = await this.getConflictedPrevout(
          prevouts,
          adapter,
          logger
        );
        if (conflicted) {
          logger.error(
            {
              txid,
              network: config.bitcoinNetwork,
              conflictedPrevout: conflicted,
            },
            `❌ ${colors.network(config.bitcoinNetwork)} tx ${colors.txid(txid)}: input ${colors.value(`${conflicted.txid}:${conflicted.vout}`)} was spent elsewhere`
          );
          return { status: 'error', reason: 'inputs_spent' };
        }

        logger.pending(
          { txid, network: config.bitcoinNetwork },
          `⏳ ${colors.network(config.bitcoinNetwork)} tx ${colors.txid(txid)}: ${colors.hint('not found')}`
        );
        return { status: 'pending' };
      }

      logger.error(
        {
          txid,
          network: config.bitcoinNetwork,
          error:
            error instanceof Error ? error.message : (error as string | number),
        },
        `❌ Error while monitoring ${colors.txid(txid)}`
      );
      return { status: 'pending' };
    }
  }

  private static async getAdapter(
    config: ServerConfig,
    logger: AppLogger
  ): Promise<IBitcoinAdapter> {
    const network = config.bitcoinNetwork;

    if (this.adapterCache.has(network)) {
      return this.adapterCache.get(network)!;
    }

    const adapter = await BitcoinAdapterFactory.create(network, logger);

    this.adapterCache.set(network, adapter);
    return adapter;
  }

  private static async getConflictedPrevout(
    prevouts: PrevoutRef[] | undefined,
    adapter: IBitcoinAdapter,
    logger: AppLogger
  ): Promise<PrevoutRef | null> {
    if (!prevouts || prevouts.length === 0) {
      return null;
    }

    for (const prev of prevouts) {
      try {
        const spent = await adapter.isPrevoutSpent(prev.txid, prev.vout);
        if (spent) {
          return prev;
        }
      } catch (error) {
        logger.error(
          {
            prevout: prev,
            error:
              error instanceof Error ? error.message : (error as string | number),
          },
          `❌ Error checking prevout ${prev.txid}:${prev.vout}`
        );
      }
    }

    return null;
  }
}
