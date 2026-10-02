import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { OutputKind, type JsonValue } from '@sig-net/midnight';
import { EthereumMonitor } from '../src/modules/ethereum/EthereumMonitor';
import {
  MidnightMonitor,
  type MidnightSigningRequest,
} from '../src/modules/MidnightMonitor';
import { ChainSignatureServer } from '../src/server/ChainSignatureServer';
import type { PendingTransaction, ServerConfig } from '../src/types';

const CONFIG: ServerConfig = {
  disableSolana: true,
  solanaRpcUrl: 'http://unused.invalid',
  evmRpcUrl: 'http://unused.invalid',
  mpcRootKey: '0x' + '01'.repeat(32),
  isDevnet: false,
  bitcoinNetwork: 'regtest',
  midnightIndexerUrl: 'http://unused.invalid',
  midnightSignetContractAddress: 'unused',
};
const ADDRESS = '0x' + '11'.repeat(20);
const REQUEST_ID = '0x' + '33'.repeat(32);
const EMPTY_SCHEMA = '[]';
const BOOL_SCHEMA = '[{"name":"ok","type":"bool"}]';
const UINT256_SCHEMA = '[{"name":"amount","type":"uint256"}]';
const TRANSFER_CALLDATA = '0x';
const CONTRACT_CALLDATA = '0xa9059cbb00';
const abi = ethers.AbiCoder.defaultAbiCoder();

// The trace and output schema each case feeds the fakenet, and what it
// attests. A `callFrame` of undefined means the transaction must not be
// traced at all. The attested bytes are the Borsh struct the schema derives:
// one member per field in order, a bool as one byte, a uint256 as its 32
// little-endian bytes, an address as 20 bytes and bytesN as N bytes.
const CASES: {
  name: string;
  calldata: string;
  callFrame: JsonValue | undefined;
  outputSchema: string;
  attested: string | undefined;
  error?: RegExp;
}[] = [
  {
    name: 'a plain transfer under an empty schema is not traced and attests an empty output',
    calldata: TRANSFER_CALLDATA,
    callFrame: undefined,
    outputSchema: EMPTY_SCHEMA,
    attested: '0x',
  },
  {
    name: 'a plain transfer under a non-empty schema is refused',
    calldata: TRANSFER_CALLDATA,
    callFrame: undefined,
    outputSchema: BOOL_SCHEMA,
    attested: undefined,
    error: /plain transfer returns nothing/,
  },
  {
    name: 'a contract call attests its uint256 return value little-endian, carried whole',
    calldata: CONTRACT_CALLDATA,
    callFrame: {
      type: 'CALL',
      output:
        '0x0000000000000000000000000000000000000000000000000102030405060708',
    },
    outputSchema: UINT256_SCHEMA,
    attested: '0x0807060504030201' + '00'.repeat(24),
  },
  {
    name: 'a uint256 at its maximum is attested without narrowing',
    calldata: CONTRACT_CALLDATA,
    callFrame: {
      type: 'CALL',
      output: abi.encode(['uint256'], [(1n << 256n) - 1n]),
    },
    outputSchema: UINT256_SCHEMA,
    attested: '0x' + 'ff'.repeat(32),
  },
  {
    name: 'a multi-field return packs one struct member per field in schema order',
    calldata: CONTRACT_CALLDATA,
    callFrame: {
      type: 'CALL',
      output: abi.encode(['bool', 'uint256'], [true, 5n]),
    },
    outputSchema:
      '[{"name":"success","type":"bool"},{"name":"amount","type":"uint256"}]',
    attested: '0x01' + '05' + '00'.repeat(31),
  },
  {
    name: 'address and fixed bytes are attested as their wire bytes',
    calldata: CONTRACT_CALLDATA,
    callFrame: {
      type: 'CALL',
      output: abi.encode(['address', 'bytes4'], [ADDRESS, '0xdeadbeef']),
    },
    outputSchema:
      '[{"name":"who","type":"address"},{"name":"tag","type":"bytes4"}]',
    attested: '0x' + '11'.repeat(20) + 'deadbeef',
  },
  {
    name: 'a void call under an empty schema attests an empty output',
    calldata: CONTRACT_CALLDATA,
    callFrame: { type: 'CALL', output: '0x' },
    outputSchema: EMPTY_SCHEMA,
    attested: '0x',
  },
  {
    name: 'a void call whose frame has no output attests an empty output',
    calldata: CONTRACT_CALLDATA,
    callFrame: { type: 'CALL' },
    outputSchema: EMPTY_SCHEMA,
    attested: '0x',
  },
  {
    // The monitor's own decode refuses the empty return data first, so the
    // execution is retried and the request stays unanswered.
    name: 'a void call under a non-empty schema is refused before attestation',
    calldata: CONTRACT_CALLDATA,
    callFrame: { type: 'CALL', output: '0x' },
    outputSchema: BOOL_SCHEMA,
    attested: undefined,
  },
  {
    name: 'return data under an empty schema is refused',
    calldata: CONTRACT_CALLDATA,
    callFrame: { type: 'CALL', output: abi.encode(['uint256'], [1n]) },
    outputSchema: EMPTY_SCHEMA,
    attested: undefined,
    error: /declares no return values/,
  },
  {
    name: 'a trace reporting an error is refused and nothing is attested',
    calldata: CONTRACT_CALLDATA,
    callFrame: {
      type: 'CALL',
      error: 'execution reverted',
      revertReason: 'InsufficientBalance',
      output: '0x',
    },
    outputSchema: EMPTY_SCHEMA,
    attested: undefined,
  },
];

for (const [index, row] of CASES.entries()) {
  test(`Midnight executed output: ${row.name}`, async (t) => {
    const txHash = ethers.zeroPadValue(ethers.toBeHex(index + 1), 32);
    t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
      number: 200,
    }));
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getTransactionReceipt',
      async () => ({ status: 1, blockNumber: 150 })
    );
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getTransaction',
      async () => ({ hash: txHash, data: row.calldata })
    );
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'send',
      async (method: string, params: unknown[]) => {
        assert.notEqual(row.callFrame, undefined, 'traced a plain transfer');
        assert.equal(method, 'debug_traceTransaction');
        assert.deepEqual(params, [
          txHash,
          {
            tracer: 'callTracer',
            tracerConfig: { onlyTopCall: true },
            timeout: '5s',
          },
        ]);
        return row.callFrame;
      }
    );
    const attestations: { output: string; kind: OutputKind }[] = [];
    t.mock.method(
      MidnightMonitor.prototype,
      'signAndBroadcastResponse',
      async (
        _requestId: Uint8Array,
        serializedOutput: Uint8Array,
        _sender: string,
        _blockHeight: bigint,
        outputKind: OutputKind
      ) => {
        attestations.push({
          output: ethers.hexlify(serializedOutput),
          kind: outputKind,
        });
      }
    );
    const txInfo: PendingTransaction = {
      txHash,
      requestId: REQUEST_ID,
      caip2Id: 'eip155:1',
      outputDeserializationSchema: Buffer.from(row.outputSchema),
      fromAddress: ADDRESS,
      nonce: 7,
      signedAtBlock: 100,
      checkCount: 0,
      namespace: 'eip155',
      prevouts: [],
      sender: 'unused',
      source: 'midnight',
    };

    const result = await EthereumMonitor.waitForTransactionAndGetOutput(
      txHash,
      txInfo.caip2Id,
      txInfo.outputDeserializationSchema,
      txInfo.fromAddress,
      txInfo.nonce,
      txInfo.signedAtBlock,
      CONFIG
    );
    if (result.status === 'success') {
      const pending = new ChainSignatureServer(CONFIG)[
        'handleCompletedTransaction'
      ](txHash, txInfo, result);
      if (row.error) await assert.rejects(pending, row.error);
      else await pending;
    }

    assert.deepEqual(
      attestations,
      row.attested === undefined
        ? []
        : [{ output: row.attested, kind: OutputKind.executed }]
    );
    assert.equal(
      result.status,
      row.attested === undefined && !row.error ? 'pending' : 'success'
    );
  });
}

// The MPC signs a request only when it can attest its output schema. The
// request below is a plain transfer, and its schema varies per row.
const REQUEST: MidnightSigningRequest = {
  predecessor: '22'.repeat(32),
  requestId: new Uint8Array(32).fill(0x33),
  evmParams: {
    evmTo: new Uint8Array(20).fill(0x11),
    evmChainId: 1n,
    evmNonce: 7n,
    evmGasLimit: 21_000n,
    evmMaxFee: 1n,
    evmPriorityFee: 1n,
    evmValue: 0n,
  },
  calldata: { words: [] },
  caip2Id: 'eip155:1',
  keyVersion: 0,
  path: new Uint8Array(32),
  algo: 'ecdsa',
  dest: 'ethereum',
  params: new Uint8Array(0),
  outputDeserializationSchema: new TextEncoder().encode(EMPTY_SCHEMA),
  // Read only by buildSerializedTransaction, which the tests mock.
  signetRequest: {} as MidnightSigningRequest['signetRequest'],
};
const REQUEST_TX = ethers.getBytes(
  ethers.Transaction.from({
    type: 2,
    chainId: 1,
    nonce: 7,
    gasLimit: 21_000,
    maxFeePerGas: 1,
    maxPriorityFeePerGas: 1,
    value: 0,
    data: '0x',
    to: ADDRESS,
  }).unsignedSerialized
);

const SIGNING_CASES: { name: string; outputSchema: string; signed: boolean }[] =
  [
    { name: 'an empty schema', outputSchema: EMPTY_SCHEMA, signed: true },
    {
      name: 'every attested type',
      outputSchema:
        '[{"name":"a","type":"bool"},{"name":"b","type":"uint256"},{"name":"c","type":"address"},{"name":"d","type":"bytes32"}]',
      signed: true,
    },
    {
      name: 'a string output',
      outputSchema: '[{"name":"a","type":"string"}]',
      signed: false,
    },
    {
      name: 'a narrower integer output',
      outputSchema: '[{"name":"a","type":"uint128"}]',
      signed: false,
    },
    {
      name: 'a schema that is not an array of fields',
      outputSchema: '{"name":"a","type":"bool"}',
      signed: false,
    },
    { name: 'a schema that is not JSON', outputSchema: 'nope', signed: false },
  ];

for (const row of SIGNING_CASES) {
  test(`Midnight request with ${row.name} is ${row.signed ? 'signed' : 'dropped unsigned'}`, async (t) => {
    t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
      number: 100,
    }));
    const built = t.mock.method(
      MidnightMonitor.prototype,
      'buildSerializedTransaction',
      () => REQUEST_TX
    );
    const posted = t.mock.method(
      MidnightMonitor.prototype,
      'broadcastSignedTransaction',
      async () => {}
    );

    await new ChainSignatureServer(CONFIG)['handleMidnightSigningRequest']({
      ...REQUEST,
      outputDeserializationSchema: new TextEncoder().encode(row.outputSchema),
    });

    assert.equal(built.mock.callCount(), row.signed ? 1 : 0);
    assert.equal(posted.mock.callCount(), row.signed ? 1 : 0);
  });
}
