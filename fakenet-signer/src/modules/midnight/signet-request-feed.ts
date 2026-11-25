// The responder's request discovery: poll the central signet signer's
// emitted SignBidirectionalEvent notifications and read each declared
// request from the named caller contract's own request map. A notification
// says only where to look (caller address, requests path, request id): every
// request served comes from the caller's authenticated ledger. The TS
// sibling of the real MPC's Rust indexer (sig-net/mpc,
// chain-signatures/chain-midnight).

import { ContractState } from '@midnight-ntwrk/compact-runtime';
import {
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  isSignetEventNamed,
  lookupSignetRequestAt,
  type RawContractState,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  SignetEventName,
  type SignetEventSource,
  type SignetPublicStateSource,
} from '@sig-net/midnight';

/**
 * A request discovered through a notification event and read from the named
 * caller's own authenticated ledger.
 */
export interface ResolvedSignetRequest {
  /**
   * The contract whose authenticated state the request was read from. Key
   * derivation keys off THIS address, never off a notification field.
   */
  callerAddress: string;
  /** The request id the record is stored under in `callerAddress`'s index. */
  requestId: RequestIdHex;
  /** The authenticated request record to sign. */
  request: SignBidirectionalEvent;
}

/** Everything a {@link SignetRequestFeed} needs. */
export interface SignetRequestFeedConfig {
  /** Address of the central signet signer whose notification events to poll. */
  readonly signerContractAddress: string;
  /**
   * Source of raw contract state for the requester ledgers the feed
   * enumerates. A full `indexerPublicDataProvider` is assignable.
   */
  readonly source: SignetPublicStateSource;
  /**
   * Source of the signet signer's emitted events (discovery), such as
   * `signetEventSourceFromIndexer`.
   */
  readonly eventSource: SignetEventSource;
}

/**
 * The event-polling request feed. Reads the signet signer's emitted
 * notifications and looks each declared request id up in the pointed-at
 * caller's own request map, yielding each found request once. Dedupes by
 * request id across its lifetime: call {@link forget} to re-arm a request
 * whose downstream processing failed.
 */
export class SignetRequestFeed {
  private readonly signerContractAddress: string;
  private readonly source: SignetPublicStateSource;
  private readonly eventSource: SignetEventSource;

  // Request ids already yielded. NOT the security boundary (the caller-ledger
  // read is), just an at-most-once gate so one request is not processed twice.
  private readonly yielded = new Set<RequestIdHex>();

  /**
   * @param config - The signet signer, state and event sources.
   */
  constructor(config: SignetRequestFeedConfig) {
    this.signerContractAddress = config.signerContractAddress;
    this.source = config.source;
    this.eventSource = config.eventSource;
  }

  /**
   * The unique `(callerAddress, requestsPath, requestId)` pointers of the
   * currently emitted notification events, in a deterministic order. Deduped
   * by the FULL triple, so a forged notification cannot shadow a genuine
   * one. Undecodable events are skipped and logged.
   *
   * @returns The deduplicated pointers to look up this cycle.
   */
  private async notificationPointers(): Promise<
    { callerAddress: string; requestsPath: number[]; requestId: RequestIdHex }[]
  > {
    const pointers = new Map<
      string,
      { callerAddress: string; requestsPath: number[]; requestId: RequestIdHex }
    >();
    for await (const event of this.eventSource.streamSignetEvents(
      this.signerContractAddress
    )) {
      if (!isSignetEventNamed(event, SignetEventName.SignBidirectionalEvent))
        continue;
      let pointer;
      try {
        const post = decodeSignBidirectionalEventNotificationPayload(
          event.payload
        );
        const notification = decodeSignBidirectionalNotification(post.event);
        pointer = {
          callerAddress: notification.callerAddress,
          requestsPath: notification.requestsPath,
          requestId: requestIdHex(post.requestId),
        };
      } catch (error) {
        console.warn(
          `SignetRequestFeed: skipping undecodable notification event: ${String(error)}`
        );
        continue;
      }
      pointers.set(
        `${pointer.callerAddress}:${pointer.requestsPath.join(',')}:${pointer.requestId}`,
        pointer
      );
    }
    return [...pointers.values()].sort((a, b) => {
      const byCaller =
        a.callerAddress < b.callerAddress
          ? -1
          : a.callerAddress > b.callerAddress
            ? 1
            : 0;
      if (byCaller !== 0) return byCaller;
      return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
    });
  }

  /**
   * One-shot: every notified request not already yielded and found by id in
   * the pointed-at caller's own request map. A pointer that resolves to
   * nothing yields nothing WITHOUT marking anything, so it is retried next
   * cycle.
   *
   * @returns The newly-discovered authenticated requests this cycle.
   * @throws {Error} When the event source itself fails (e.g. the indexer is
   *   unreachable).
   */
  async poll(): Promise<ResolvedSignetRequest[]> {
    const out: ResolvedSignetRequest[] = [];
    // Per-cycle caller-state cache: null marks a caller whose state could
    // not be read this cycle (not a contract / transient read error).
    const states = new Map<string, RawContractState | null>();
    for (const pointer of await this.notificationPointers()) {
      if (this.yielded.has(pointer.requestId)) continue;
      let raw = states.get(pointer.callerAddress);
      if (raw === undefined) {
        try {
          const read = await this.source.queryContractState(
            pointer.callerAddress
          );
          raw =
            read?.contractState.deserialize({ v9: ContractState }).data ?? null;
        } catch {
          raw = null;
        }
        states.set(pointer.callerAddress, raw);
      }
      if (raw === null) {
        continue; // no state at the named caller: nothing to serve yet
      }
      const request = lookupSignetRequestAt(
        raw,
        pointer.requestsPath,
        pointer.requestId
      );
      if (request === undefined) {
        continue; // forged pointer, or the ledger write has not indexed yet
      }
      this.yielded.add(pointer.requestId);
      out.push({
        callerAddress: pointer.callerAddress,
        requestId: pointer.requestId,
        request,
      });
    }
    return out;
  }

  /**
   * Re-arm `requestId` for redelivery on the next {@link poll} cycle: call
   * when downstream processing of a yielded request failed.
   *
   * @param requestId - The request id to allow through again.
   */
  forget(requestId: RequestIdHex): void {
    this.yielded.delete(requestId);
  }
}
