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

export class TronSolidityView {
  private readonly blocks = new Map<bigint, SolidifiedBlock | null>();

  constructor(
    private readonly reader: TronReader,
    private readonly head: bigint,
    readonly spanCap: bigint = MAX_WALK_SPAN
  ) {}

  private async block(number: bigint): Promise<SolidifiedBlock | null> {
    if (!this.blocks.has(number)) {
      this.blocks.set(number, await this.reader.getBlockSolidity(number));
    }
    return this.blocks.get(number) ?? null;
  }

  private async requireBlock(number: bigint): Promise<SolidifiedBlock> {
    const block = await this.block(number);
    if (block === null) {
      throw new Error(
        `solidified block ${number} below the scan head ${this.head} is absent: ` +
          'pruned history or a lagging instance'
      );
    }
    return block;
  }

  async firstAtOrAfter(timestamp: bigint): Promise<bigint> {
    let lo = 0n;
    let hi = this.head;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if ((await this.requireBlock(mid)).timestamp >= timestamp) {
        hi = mid;
      } else {
        lo = mid + 1n;
      }
    }
    const block = await this.block(lo);
    if (block === null || block.timestamp < timestamp) {
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
        (await this.requireBlock(candidate)).refSlice,
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
      if ((await this.requireBlock(number)).txids.includes(id)) {
        return { kind: 'included' };
      }
    }
    return { kind: 'absent', boundary };
  }
}
