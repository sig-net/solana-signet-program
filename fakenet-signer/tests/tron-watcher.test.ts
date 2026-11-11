import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseSolidifiedBlock,
  parseTransactionInfo,
  type SolidifiedBlock,
  type TronReader,
  type TronReceipt,
} from '../src/modules/tron/TronClient';
import { TronSolidityView } from '../src/modules/tron/TronExpiry';
import {
  tronExecutionOutcome,
  tronExecutionResult,
  tronSchemaRejection,
} from '../src/modules/tron/TronVerdicts';
import {
  TronWatcher,
  type TronOutcomeKind,
  type TronWatch,
} from '../src/modules/tron/TronWatcher';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/tron/nile'
);
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

function must<T>(value: T | null | undefined, what: string): T {
  assert.ok(value !== null && value !== undefined, `${what} is absent`);
  return value;
}

const BLOCK_95 = must(
  parseSolidifiedBlock(fixture('solid-block-71896095')),
  'block 71896095'
);
const BLOCK_96 = must(
  parseSolidifiedBlock(fixture('solid-block-71896096')),
  'block 71896096'
);
const INCLUDED_TXID =
  'b4e8076ad07087c23b857a4649686954f235b57425bce5205295a5f5e9274e88';
const ABSENT_TXID = 'ab'.repeat(32);
const SLOT_MS = 3_000n;

function nileReader(
  head: bigint,
  receipts: Map<string, TronReceipt> = new Map()
): TronReader & { blockReads: bigint[] } {
  const blockReads: bigint[] = [];
  const block = (number: bigint): SolidifiedBlock | null => {
    if (number > head) return null;
    if (number === BLOCK_95.number) return BLOCK_95;
    if (number === BLOCK_96.number) return BLOCK_96;
    return {
      number,
      timestamp: BLOCK_95.timestamp + (number - BLOCK_95.number) * SLOT_MS,
      refSlice: new Uint8Array(8),
      txids: [],
    };
  };
  return {
    blockReads,
    getTransactionInfoSolidity: async (txid) => receipts.get(txid) ?? null,
    getNowBlockSolidity: async () => must(block(head), 'the head'),
    getBlockSolidity: async (number) => {
      blockReads.push(number);
      return block(number);
    },
  };
}

const REFERENCED_95 = {
  refBlockBytes: Uint8Array.from([0x0c, 0x1f]),
  refBlockHash: Uint8Array.from(Buffer.from('1de35fa4b5b31af5', 'hex')),
};

const SUCCESS_RECEIPT = must(
  parseTransactionInfo(fixture('receipt-success')),
  'the success receipt'
);

function receipt(fields: Partial<TronReceipt>): TronReceipt {
  return { ...SUCCESS_RECEIPT, ...fields };
}

const FAILURE_MEMBERS = [
  'FAILED',
  'REVERT',
  'BAD_JUMP_DESTINATION',
  'OUT_OF_MEMORY',
  'PRECOMPILED_CONTRACT',
  'STACK_TOO_SMALL',
  'STACK_TOO_LARGE',
  'ILLEGAL_OPERATION',
  'STACK_OVERFLOW',
  'OUT_OF_ENERGY',
  'OUT_OF_TIME',
  'JVM_STACK_OVER_FLOW',
  'UNKNOWN',
  'TRANSFER_FAILED',
  'INVALID_CODE',
];

test('Tron receipts classify every vendor member in both carriers, as the MPC does', () => {
  const cases: [string, 'succeeded' | 'failed'][] = [
    ['SUCESS', 'succeeded'],
    ['SUCCESS', 'succeeded'],
    ...FAILURE_MEMBERS.map((value): [string, 'failed'] => [value, 'failed']),
  ];
  for (const [value, expected] of cases) {
    assert.equal(tronExecutionResult({ result: value }), expected, value);
    assert.equal(tronExecutionResult({ receiptResult: value }), expected);
  }
  assert.equal(
    tronExecutionResult({ result: 'REVERT', receiptResult: 'SUCCESS' }),
    'failed'
  );
});

test('an unset, unknown or missing Tron result attests nothing (keep polling)', () => {
  assert.throws(
    () => tronExecutionResult({ receiptResult: 'DEFAULT' }),
    /unset/
  );
  assert.throws(
    () => tronExecutionResult({ receiptResult: 'WEIRD' }),
    /unclassifiable/
  );
  assert.throws(() => tronExecutionResult({}), /no execution result/);
});

test('a Tron success attests executed, a failure failed, and a schema-carrying success parks', () => {
  const schema = new TextEncoder().encode('[{"name":"ok","type":"bool"}]');
  const empty = new Uint8Array(0);
  assert.equal(
    tronExecutionOutcome({ receiptResult: 'SUCCESS' }, empty),
    'executed'
  );
  assert.equal(tronExecutionOutcome({ result: 'REVERT' }, empty), 'failed');
  assert.equal(
    tronExecutionOutcome({ receiptResult: 'OUT_OF_ENERGY' }, schema),
    'failed'
  );
  assert.equal(
    tronExecutionOutcome({ receiptResult: 'SUCCESS' }, schema),
    'parked'
  );
});

test('Tron admission requires empty output and respond schemas', () => {
  const empty = new Uint8Array(0);
  assert.equal(tronSchemaRejection(empty, empty), undefined);
  assert.equal(tronSchemaRejection(empty, new Uint8Array(8)), undefined);
  assert.match(
    tronSchemaRejection(new Uint8Array(8), empty) ?? '',
    /no output schemas/
  );
  assert.match(
    tronSchemaRejection(empty, new TextEncoder().encode('[]')) ?? '',
    /no output schemas/
  );
});

test('the recorded Nile responses parse as the MPC reads them', () => {
  assert.equal(parseTransactionInfo(fixture('receipt-pending')), null);
  assert.equal(
    SUCCESS_RECEIPT.id,
    '24157817b0db1a156e7244d4417cbd7303f32b06449fcbad739f124b6b8e4c82'
  );
  assert.equal(SUCCESS_RECEIPT.blockNumber, 71_896_097n);
  assert.equal(SUCCESS_RECEIPT.result, undefined);
  assert.equal(SUCCESS_RECEIPT.receiptResult, 'SUCCESS');
  assert.equal(tronExecutionResult(SUCCESS_RECEIPT), 'succeeded');

  assert.equal(BLOCK_95.number, 71_896_095n);
  assert.equal(BLOCK_95.timestamp, 1_792_220_496_000n);
  assert.equal(
    Buffer.from(BLOCK_95.refSlice).toString('hex'),
    '1de35fa4b5b31af5'
  );
  assert.equal(BLOCK_95.txids.length, 12);
  assert.ok(BLOCK_96.txids.includes(INCLUDED_TXID));

  const head = parseSolidifiedBlock(fixture('nowblock-solidity'));
  assert.equal(head?.number, 72_266_582n);
  assert.equal(parseSolidifiedBlock({}), null);
});

test('the expiry walk finds the boundary and inclusion over recorded Nile blocks', async () => {
  const window = { ...REFERENCED_95, expiration: BLOCK_96.timestamp };
  const view = () => new TronSolidityView(nileReader(71_896_100n), 71_896_100n);

  assert.deepEqual(await view().verdict(INCLUDED_TXID, window), {
    kind: 'included',
  });
  assert.deepEqual(await view().verdict(ABSENT_TXID, window), {
    kind: 'absent',
    boundary: 71_896_096n,
  });
  assert.deepEqual(
    await view().verdict(ABSENT_TXID, {
      ...window,
      expiration: BLOCK_95.timestamp + 1n,
    }),
    { kind: 'absent', boundary: 71_896_096n }
  );
});

test('the expiry walk defers on a lying reference, a span past the cap, or nothing solidified past the window', async () => {
  const head = 71_896_100n;
  const window = { ...REFERENCED_95, expiration: BLOCK_96.timestamp };
  await assert.rejects(
    new TronSolidityView(nileReader(head), head).verdict(ABSENT_TXID, {
      ...window,
      refBlockHash: new Uint8Array(8).fill(0xee),
    }),
    /TaPoS reference unresolved/
  );
  await assert.rejects(
    new TronSolidityView(nileReader(head), head, 0n).verdict(
      ABSENT_TXID,
      window
    ),
    /walk cap/
  );
  await assert.rejects(
    new TronSolidityView(nileReader(head), head).verdict(ABSENT_TXID, {
      ...window,
      expiration: BLOCK_95.timestamp + 100n * SLOT_MS,
    }),
    /nothing solidified at or past/
  );
});

function watchFor(txid: string, overrides: Partial<TronWatch> = {}): TronWatch {
  return {
    requestId: '0x' + '33'.repeat(32),
    txid,
    sender: '22'.repeat(32),
    window: { ...REFERENCED_95, expiration: BLOCK_96.timestamp },
    outputDeserializationSchema: new Uint8Array(0),
    ...overrides,
  };
}

function recordingWatcher(reader: TronReader) {
  const attestations: { kind: TronOutcomeKind; blockHeight: bigint }[] = [];
  const watcher = new TronWatcher({
    reader,
    attest: async (_watch, kind, blockHeight) => {
      attestations.push({ kind, blockHeight });
    },
  });
  return { watcher, attestations };
}

test('the watcher attests a solidified receipt over its verdict at the receipt block', async () => {
  for (const [result, kind] of [
    [{ receiptResult: 'SUCCESS' }, 'executed'],
    [{ result: 'FAILED', receiptResult: 'REVERT' }, 'failed'],
    [{ result: 'FAILED', receiptResult: 'OUT_OF_ENERGY' }, 'failed'],
  ] as const) {
    const receipts = new Map([
      [INCLUDED_TXID, receipt({ ...result, blockNumber: 71_896_096n })],
    ]);
    const { watcher, attestations } = recordingWatcher(
      nileReader(71_896_100n, receipts)
    );
    watcher.watch(watchFor(INCLUDED_TXID));
    await watcher.tick();
    assert.deepEqual(attestations, [{ kind, blockHeight: 71_896_096n }]);
    assert.deepEqual(watcher.pendingRequestIds(), []);
  }
});

test('the watcher keeps polling with no receipt and an open window, or an unclassifiable receipt', async () => {
  const open = recordingWatcher(nileReader(71_896_095n));
  open.watcher.watch(watchFor(ABSENT_TXID));
  await open.watcher.tick();
  assert.deepEqual(open.attestations, []);
  assert.equal(open.watcher.pendingRequestIds().length, 1);

  const unset = recordingWatcher(
    nileReader(
      71_896_095n,
      new Map([[INCLUDED_TXID, receipt({ receiptResult: 'DEFAULT' })]])
    )
  );
  unset.watcher.watch(watchFor(INCLUDED_TXID));
  await unset.watcher.tick();
  assert.deepEqual(unset.attestations, []);
  assert.equal(unset.watcher.pendingRequestIds().length, 1);
});

test('the watcher parks a schema-carrying success: logged, never answered', async () => {
  const { watcher, attestations } = recordingWatcher(
    nileReader(
      71_896_100n,
      new Map([[INCLUDED_TXID, receipt({ receiptResult: 'SUCCESS' })]])
    )
  );
  watcher.watch(
    watchFor(INCLUDED_TXID, {
      outputDeserializationSchema: new TextEncoder().encode('[]'),
    })
  );
  await watcher.tick();
  await watcher.tick();
  assert.deepEqual(attestations, []);
  assert.deepEqual(watcher.pendingRequestIds(), []);
});

test('the watcher attests unviable at the first solidified block at or past the expiration', async () => {
  const { watcher, attestations } = recordingWatcher(nileReader(71_896_100n));
  watcher.watch(watchFor(ABSENT_TXID));
  await watcher.tick();
  assert.deepEqual(attestations, [
    { kind: 'unviable', blockHeight: 71_896_096n },
  ]);
  assert.deepEqual(watcher.pendingRequestIds(), []);
});

test('a closed window with inclusion keeps waiting for the receipt', async () => {
  const receipts = new Map<string, TronReceipt>();
  const reader = nileReader(71_896_100n, receipts);
  const { watcher, attestations } = recordingWatcher(reader);
  watcher.watch(watchFor(INCLUDED_TXID));
  await watcher.tick();
  assert.deepEqual(attestations, []);
  assert.equal(watcher.pendingRequestIds().length, 1);

  receipts.set(
    INCLUDED_TXID,
    receipt({ receiptResult: 'SUCCESS', blockNumber: 71_896_096n })
  );
  await watcher.tick();
  assert.deepEqual(attestations, [
    { kind: 'executed', blockHeight: 71_896_096n },
  ]);
});

test('a failed post keeps the watch and retries it next tick', async () => {
  let failures = 1;
  const posted: TronOutcomeKind[] = [];
  const watcher = new TronWatcher({
    reader: nileReader(
      71_896_100n,
      new Map([[INCLUDED_TXID, receipt({ receiptResult: 'SUCCESS' })]])
    ),
    attest: async (_watch, kind) => {
      if (failures-- > 0) throw new Error('respondBidirectional timed out');
      posted.push(kind);
    },
  });
  watcher.watch(watchFor(INCLUDED_TXID));
  await watcher.tick();
  assert.equal(watcher.pendingRequestIds().length, 1);
  await watcher.tick();
  assert.deepEqual(posted, ['executed']);
  assert.deepEqual(watcher.pendingRequestIds(), []);
});

test('the Tron leg runs only with an endpoint', () => {
  const attest = async () => {};
  assert.equal(TronWatcher.fromServerConfig({}, attest), null);
  assert.ok(
    TronWatcher.fromServerConfig(
      { tronRpcUrl: 'http://localhost:9090' },
      attest
    ) instanceof TronWatcher
  );
});
