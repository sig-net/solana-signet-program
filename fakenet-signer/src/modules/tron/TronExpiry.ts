import type { SolidifiedBlock, TronReader } from './TronClient';

export interface TronTxWindow {
  expiration: bigint;
  refBlockBytes: Uint8Array;
  refBlockHash: Uint8Array;
}

export type TronExpiryVerdict =
  | { kind: 'included' }
  | { kind: 'absent'; boundary: bigint };

export const MAX_WALK_SPAN = 28_800n;

export function isWindowClosed(
  window: TronTxWindow,
  head: Pick<SolidifiedBlock, 'timestamp'>
): boolean {
  return head.timestamp >= window.expiration;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

interface BlockHeader {
  timestamp: bigint;
  refSlice: Uint8Array;
}

export class TronSolidityCache {
  readonly headers = new Map<bigint, BlockHeader>();
  readonly membership = new Map<string, Map<bigint, boolean>>();

  prune(head: bigint, scanning: string[]): void {
    const floor = head > MAX_WALK_SPAN ? head - MAX_WALK_SPAN : 0n;
    for (const number of this.headers.keys()) {
      if (number < floor) this.headers.delete(number);
    }
    for (const [txid, blocks] of this.membership) {
      if (!scanning.includes(txid)) {
        this.membership.delete(txid);
        continue;
      }
      for (const number of blocks.keys()) {
        if (number < floor) blocks.delete(number);
      }
    }
  }
}

export class TronSolidityView {
  constructor(
    private readonly reader: TronReader,
    private readonly head: bigint,
    private readonly cache: TronSolidityCache = new TronSolidityCache(),
    readonly spanCap: bigint = MAX_WALK_SPAN
  ) {}

  private async header(number: bigint): Promise<BlockHeader | null> {
    return this.cache.headers.get(number) ?? (await this.fetchedBlock(number));
  }

  private async fetchedBlock(number: bigint): Promise<SolidifiedBlock | null> {
    const block = await this.reader.getBlockSolidity(number);
    if (block !== null) {
      this.cache.headers.set(number, {
        timestamp: block.timestamp,
        refSlice: block.refSlice,
      });
    }
    return block;
  }

  private absentBelowHead(number: bigint): Error {
    return new Error(
      `solidified block ${number} below the scan head ${this.head} is absent: ` +
        'pruned history or a lagging instance'
    );
  }

  private async requireHeader(number: bigint): Promise<BlockHeader> {
    const header = await this.header(number);
    if (header === null) throw this.absentBelowHead(number);
    return header;
  }

  private async contains(txid: string, number: bigint): Promise<boolean> {
    const hit = this.cache.membership.get(txid)?.get(number);
    if (hit !== undefined) return hit;
    const block = await this.fetchedBlock(number);
    if (block === null) throw this.absentBelowHead(number);
    const resident = block.txids.includes(txid);
    let blocks = this.cache.membership.get(txid);
    if (blocks === undefined) {
      blocks = new Map();
      this.cache.membership.set(txid, blocks);
    }
    blocks.set(number, resident);
    return resident;
  }

  async firstAtOrAfter(timestamp: bigint): Promise<bigint> {
    let lo = 0n;
    let hi = this.head;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if ((await this.requireHeader(mid)).timestamp >= timestamp) {
        hi = mid;
      } else {
        lo = mid + 1n;
      }
    }
    const header = await this.header(lo);
    if (header === null || header.timestamp < timestamp) {
      throw new Error(`nothing solidified at or past ${timestamp}`);
    }
    return lo;
  }

  async refBlockStart(window: TronTxWindow, boundary: bigint): Promise<bigint> {
    const residue = BigInt(
      ((window.refBlockBytes[0] ?? 0) << 8) | (window.refBlockBytes[1] ?? 0)
    );
    const floor = boundary > MAX_WALK_SPAN ? boundary - MAX_WALK_SPAN : 0n;
    const back = ((boundary % 65_536n) + 65_536n - residue) % 65_536n;
    const candidate = boundary - back;
    const unresolved = () =>
      new Error(`TaPoS reference unresolved within ${floor}..=${boundary}`);
    if (candidate < floor) throw unresolved();
    if (
      !bytesEqual(
        (await this.requireHeader(candidate)).refSlice,
        window.refBlockHash
      )
    ) {
      throw unresolved();
    }
    return candidate;
  }

  async verdict(
    txid: string,
    window: TronTxWindow
  ): Promise<TronExpiryVerdict> {
    const boundary = await this.firstAtOrAfter(window.expiration);
    const start = await this.refBlockStart(window, boundary);
    if (boundary - start > this.spanCap) {
      throw new Error(
        `packable span ${start}..=${boundary} exceeds the ${this.spanCap}-block walk cap`
      );
    }
    const id = txid.replace(/^0x/, '').toLowerCase();
    for (let number = start; number <= boundary; number++) {
      if (await this.contains(id, number)) return { kind: 'included' };
    }
    return { kind: 'absent', boundary };
  }
}
