import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ethers } from 'ethers';
import {
  buildTronRawTransaction,
  contractAddressFromHex,
  deriveTronAddress,
  OutputKind,
  type SignBidirectionalEvent,
  TRON_CAIP2_ID,
  type TronTxParams,
  TxParamType,
  tronTransactionId,
} from '@sig-net/midnight';
import {
  MidnightMonitor,
  type MidnightSigningRequest,
} from '../src/modules/MidnightMonitor';
import { TronWatcher, type TronWatch } from '../src/modules/tron/TronWatcher';
import { ChainSignatureServer } from '../src/server/ChainSignatureServer';
import { serverConfigSchema, type ServerConfig } from '../src/types';

const MPC_ROOT_KEY = '0x' + '01'.repeat(32);
const CONFIG: ServerConfig = {
  disableSolana: true,
  solanaRpcUrl: 'http://unused.invalid',
  evmRpcUrl: 'http://unused.invalid',
  mpcRootKey: MPC_ROOT_KEY,
  isDevnet: false,
  bitcoinNetwork: 'regtest',
  midnightIndexerUrl: 'http://unused.invalid',
  midnightSignerContractAddress: 'unused',
  midnightResponderContractAddress: 'unused',
  tronRpcUrl: 'http://unused.invalid:9090',
};
const PREDECESSOR = '22'.repeat(32);
const PATH = new Uint8Array(32).fill(0x07);

const TRON_PARAMS: TronTxParams = {
  refBlockBytes: Uint8Array.from([0x0c, 0x1f]),
  refBlockHash: Uint8Array.from(Buffer.from('1de35fa4b5b31af5', 'hex')),
  timestamp: 1_792_220_496_000n,
  expiration: 1_792_220_556_000n,
  feeLimit: 50_000_000n,
  contractAddress: Uint8Array.from([0x41, ...new Uint8Array(20).fill(0xcd)]),
  callValue: 0n,
  calldata: {
    is_some: true,
    value: {
      selector: Uint8Array.from([0xa9, 0x05, 0x9c, 0xbb]),
      noWords: 2n,
      words: [new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22)],
    },
  },
};

function paddedAscii(text: string): Uint8Array {
  const out = new Uint8Array(64);
  out.set(new TextEncoder().encode(text));
  return out;
}

function tronRecord(
  overrides: Partial<SignBidirectionalEvent<TronTxParams>> = {}
): SignBidirectionalEvent<TronTxParams> {
  return {
    keyVersion: 1n,
    sender: contractAddressFromHex(PREDECESSOR),
    path: PATH,
    algo: 0,
    txParamType: TxParamType.tron,
    txParams: TRON_PARAMS,
    executionDest: paddedAscii(TRON_CAIP2_ID),
    signatureDest: 0,
    params: new Uint8Array(64),
    outputDeserializationSchema: new Uint8Array(0),
    respondSerializationSchema: new Uint8Array(0),
    ...overrides,
  };
}

function toRequest(
  record: SignBidirectionalEvent<TronTxParams>
): MidnightSigningRequest {
  const monitor = MidnightMonitor.fromServerConfig(CONFIG, {} as never);
  assert.ok(monitor);
  return monitor['toSigningRequest'](
    PREDECESSOR,
    '33'.repeat(32) as never,
    record
  );
}

function mockMidnight(t: TestContext) {
  const signatures = t.mock.method(
    MidnightMonitor.prototype,
    'postTronSignature',
    async () => {}
  );
  const evmBuilds = t.mock.method(
    MidnightMonitor.prototype,
    'buildSerializedTransaction',
    () => {
      throw new Error('a Tron request must not take the EVM path');
    }
  );
  const watches = t.mock.method(TronWatcher.prototype, 'watch', () => {});
  return { signatures, evmBuilds, watches };
}

test('a Tron record routes to a flat view with no EVM params and its CAIP-2 id', () => {
  const request = toRequest(tronRecord());
  assert.equal(request.evmParams, undefined);
  assert.equal(request.caip2Id, TRON_CAIP2_ID);
  assert.equal(request.calldata.selector, '0xa9059cbb');
  assert.equal(request.calldata.words.length, 2);
});

test('a Tron request is signed over sha256(raw) with the derived key as owner, then watched', async (t) => {
  const { signatures, evmBuilds, watches } = mockMidnight(t);
  const server = new ChainSignatureServer(CONFIG);
  await server['handleMidnightSigningRequest'](toRequest(tronRecord()));

  assert.equal(evmBuilds.mock.callCount(), 0);
  assert.equal(signatures.mock.callCount(), 1);
  const posted = signatures.mock.calls[0]?.arguments[0] as {
    requestId: string;
    signature: ethers.Signature;
    txid: string;
  };

  const owner = deriveTronAddress(
    ethers.SigningKey.computePublicKey(MPC_ROOT_KEY, false),
    PREDECESSOR,
    Buffer.from(PATH).toString('hex')
  );
  const txid = tronTransactionId(
    buildTronRawTransaction(TRON_PARAMS, owner.bytes)
  );
  assert.equal(posted.txid, Buffer.from(txid).toString('hex'));
  assert.equal(posted.requestId, '0x' + '33'.repeat(32));
  assert.ok(posted.signature.yParity === 0 || posted.signature.yParity === 1);
  assert.equal(
    ethers.recoverAddress(txid, posted.signature).toLowerCase(),
    '0x' + Buffer.from(owner.bytes.subarray(1)).toString('hex')
  );

  assert.equal(watches.mock.callCount(), 1);
  const watch = watches.mock.calls[0]?.arguments[0] as TronWatch;
  assert.equal(watch.txid, posted.txid);
  assert.equal(watch.sender, PREDECESSOR);
  assert.equal(watch.window.expiration, TRON_PARAMS.expiration);
});

for (const [name, record] of [
  [
    'a non-empty output schema',
    tronRecord({
      outputDeserializationSchema: new TextEncoder().encode('[]'),
    }),
  ],
  [
    'a zero-padded output schema',
    tronRecord({ outputDeserializationSchema: new Uint8Array(16) }),
  ],
  [
    'a non-empty respond schema',
    tronRecord({
      respondSerializationSchema: new TextEncoder().encode('[]'),
    }),
  ],
  [
    'an EVM execution destination',
    tronRecord({ executionDest: paddedAscii('eip155:1') }),
  ],
] as const) {
  test(`a Tron request with ${name} is parked: never signed, never answered`, async (t) => {
    const { signatures, evmBuilds, watches } = mockMidnight(t);
    const server = new ChainSignatureServer(CONFIG);
    await server['handleMidnightSigningRequest'](toRequest(record));
    assert.equal(signatures.mock.callCount(), 0);
    assert.equal(evmBuilds.mock.callCount(), 0);
    assert.equal(watches.mock.callCount(), 0);
  });
}

test('an evmType2 request naming the Tron destination is dropped before signing', async (t) => {
  const { evmBuilds } = mockMidnight(t);
  const server = new ChainSignatureServer(CONFIG);
  await server['handleMidnightSigningRequest']({
    ...toRequest(tronRecord()),
    signetRequest: { txParamType: TxParamType.evmType2 } as never,
  });
  assert.equal(evmBuilds.mock.callCount(), 0);
});

test('without TRON_RPC_URL a Tron request is signed but never watched', async (t) => {
  const { signatures, watches } = mockMidnight(t);
  const server = new ChainSignatureServer({ ...CONFIG, tronRpcUrl: undefined });
  assert.equal(server['tronWatcher'], null);
  await server['handleMidnightSigningRequest'](toRequest(tronRecord()));
  assert.equal(signatures.mock.callCount(), 1);
  assert.equal(watches.mock.callCount(), 0);
});

test('Tron outcomes are attested over an EMPTY output under the watched kind and height', async (t) => {
  const attestations: unknown[][] = [];
  t.mock.method(
    MidnightMonitor.prototype,
    'signAndBroadcastResponse',
    async (...args: unknown[]) => {
      attestations.push(args);
    }
  );
  const server = new ChainSignatureServer(CONFIG);
  const watch: TronWatch = {
    requestId: '0x' + '33'.repeat(32),
    txid: 'ab'.repeat(32),
    sender: PREDECESSOR,
    window: { ...TRON_PARAMS },
    outputDeserializationSchema: new Uint8Array(0),
  };
  await server['attestTronOutcome'](watch, 'executed', 7n);
  await server['attestTronOutcome'](watch, 'failed', 8n);
  await server['attestTronOutcome'](watch, 'unviable', 9n);
  assert.deepEqual(
    attestations.map(([requestId, output, sender, height, kind]) => [
      ethers.hexlify(requestId as Uint8Array),
      ethers.hexlify(output as Uint8Array),
      sender,
      height,
      kind,
    ]),
    [
      [watch.requestId, '0x', PREDECESSOR, 7n, OutputKind.executed],
      [watch.requestId, '0x', PREDECESSOR, 8n, OutputKind.failed],
      [watch.requestId, '0x', PREDECESSOR, 9n, OutputKind.unviable],
    ]
  );
});

test('the Tron leg starts only with an endpoint and a Midnight leg', () => {
  assert.ok(
    new ChainSignatureServer(CONFIG)['tronWatcher'] instanceof TronWatcher
  );
  assert.equal(
    new ChainSignatureServer({ ...CONFIG, tronRpcUrl: undefined })[
      'tronWatcher'
    ],
    null
  );
  assert.equal(
    new ChainSignatureServer({
      ...CONFIG,
      midnightIndexerUrl: undefined,
      midnightSignerContractAddress: undefined,
      midnightResponderContractAddress: undefined,
    })['tronWatcher'],
    null
  );
  assert.equal(
    serverConfigSchema.safeParse({ ...CONFIG, tronRpcUrl: 'not a url' })
      .success,
    false
  );
  assert.equal(
    serverConfigSchema.safeParse({
      ...CONFIG,
      tronRpcUrl: undefined,
      tronApiKey: 'key',
    }).success,
    false
  );
});
