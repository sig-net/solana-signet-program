import type { ServerConfig } from '../../types';
import { CONFIG } from '../../config/Config';
import {
  DEFAULT_TICK_GUARD_RELEASE_MS,
  runTickWithGuardRelease,
} from '../shared/TickGuard';
import { TronClient, type TronReader } from './TronClient';
import {
  TronSolidityView,
  isWindowClosed,
  type TronTxWindow,
} from './TronExpiry';
import { tronExecutionOutcome } from './TronVerdicts';

export interface TronWatch {
  requestId: string;
  txid: string;
  sender: string;
  window: TronTxWindow;
  outputDeserializationSchema: Uint8Array;
}

export type TronOutcomeKind = 'executed' | 'failed' | 'unviable';

export type TronAttest = (
  watch: TronWatch,
  kind: TronOutcomeKind,
  blockHeight: bigint
) => Promise<void>;

export interface TronWatcherConfig {
  reader: TronReader;
  attest: TronAttest;
  pollIntervalMs?: number;
}

export class TronWatcher {
  private readonly reader: TronReader;
  private readonly attest: TronAttest;
  private readonly pollIntervalMs: number;
  private readonly watches = new Map<string, TronWatch>();
  private intervalId: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(config: TronWatcherConfig) {
    this.reader = config.reader;
    this.attest = config.attest;
    this.pollIntervalMs = config.pollIntervalMs ?? CONFIG.POLL_INTERVAL_MS;
  }

  static fromServerConfig(
    config: Pick<ServerConfig, 'tronRpcUrl' | 'tronApiKey'>,
    attest: TronAttest
  ): TronWatcher | null {
    if (!config.tronRpcUrl) return null;
    return new TronWatcher({
      reader: new TronClient({
        endpoint: config.tronRpcUrl,
        apiKey: config.tronApiKey,
      }),
      attest,
    });
  }

  watch(watch: TronWatch): void {
    this.watches.set(watch.requestId, {
      ...watch,
      txid: watch.txid.replace(/^0x/, '').toLowerCase(),
    });
    console.log(
      `TronWatcher: watching ${watch.requestId} (txid ${watch.txid}, expiration ${watch.window.expiration})`
    );
  }

  pendingRequestIds(): string[] {
    return [...this.watches.keys()];
  }

  start(): void {
    console.log(
      `TronWatcher: polling solidified receipts every ${this.pollIntervalMs}ms`
    );
    this.intervalId = setInterval(async () => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        await runTickWithGuardRelease(
          'TronWatcher',
          DEFAULT_TICK_GUARD_RELEASE_MS,
          () => this.tick()
        );
      } catch (error) {
        console.error('TronWatcher: tick error:', error);
      } finally {
        this.ticking = false;
      }
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(): Promise<void> {
    if (this.watches.size === 0) return;
    const resolved = new Set<string>();
    for (const watch of [...this.watches.values()]) {
      if (await this.resolveFromReceipt(watch)) resolved.add(watch.requestId);
    }
    await this.expiryScan(
      [...this.watches.values()].filter(
        (watch) => !resolved.has(watch.requestId)
      )
    );
  }

  private async resolveFromReceipt(watch: TronWatch): Promise<boolean> {
    let receipt;
    try {
      receipt = await this.reader.getTransactionInfoSolidity(watch.txid);
    } catch (error) {
      console.warn(
        `TronWatcher: receipt poll failed for ${watch.requestId} (txid ${watch.txid}):`,
        error
      );
      return false;
    }
    if (receipt === null) return false;

    let outcome;
    try {
      outcome = tronExecutionOutcome(
        receipt,
        watch.outputDeserializationSchema
      );
    } catch (error) {
      console.warn(
        `TronWatcher: ${watch.requestId} (txid ${watch.txid}): ${error instanceof Error ? error.message : String(error)}; polling again`
      );
      return false;
    }

    if (outcome === 'parked') {
      console.error(
        `TronWatcher: ${watch.requestId} (txid ${watch.txid}) executed, but it carries an ` +
          'output schema and Tron output extraction is undefined: parking, the request stays unanswered'
      );
      this.watches.delete(watch.requestId);
      return true;
    }
    if (outcome === 'failed') {
      console.log(
        `TronWatcher: ${watch.requestId} (txid ${watch.txid}) failed at block ${receipt.blockNumber}` +
          ` (${receipt.result ?? receipt.receiptResult}${receipt.resMessage ? `: ${receipt.resMessage}` : ''})`
      );
    }
    return this.post(watch, outcome, receipt.blockNumber);
  }

  private async expiryScan(open: TronWatch[]): Promise<void> {
    if (open.length === 0) return;
    let head;
    try {
      head = await this.reader.getNowBlockSolidity();
    } catch (error) {
      console.warn(
        'TronWatcher: solidity head fetch failed; expiry scan deferred:',
        error
      );
      return;
    }
    const closed = open.filter((watch) => isWindowClosed(watch.window, head));
    if (closed.length === 0) return;

    const view = new TronSolidityView(this.reader, head.number);
    for (const watch of closed) {
      let verdict;
      try {
        verdict = await view.verdict(watch.txid, watch.window);
      } catch (error) {
        console.warn(
          `TronWatcher: expiry walk for ${watch.requestId} (txid ${watch.txid}) failed; deferring: ` +
            (error instanceof Error ? error.message : String(error))
        );
        continue;
      }
      if (verdict.kind === 'included') {
        console.log(
          `TronWatcher: ${watch.requestId} (txid ${watch.txid}) window closed with inclusion; ` +
            'waiting for its solidified receipt'
        );
        continue;
      }
      console.log(
        `TronWatcher: ${watch.requestId} (txid ${watch.txid}) window closed without inclusion; ` +
          `attesting unviable at boundary ${verdict.boundary}`
      );
      await this.post(watch, 'unviable', verdict.boundary);
    }
  }

  private async post(
    watch: TronWatch,
    kind: TronOutcomeKind,
    blockHeight: bigint
  ): Promise<boolean> {
    try {
      await this.attest(watch, kind, blockHeight);
    } catch (error) {
      console.error(
        `TronWatcher: posting ${kind} for ${watch.requestId} failed; retrying next tick:`,
        error
      );
      return false;
    }
    this.watches.delete(watch.requestId);
    return true;
  }
}
