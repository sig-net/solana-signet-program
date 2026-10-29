import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { OutputKind, type JsonValue } from '@sig-net/midnight';
import { EthereumMonitor } from '../src/modules/ethereum/EthereumMonitor';
import { MidnightMonitor } from '../src/modules/MidnightMonitor';
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
const BOOL_SCHEMA = '[{"name":"ok","type":"bool"}]';
const TRANSFER_CALLDATA = '0x';
const CONTRACT_CALLDATA = '0xa9059cbb00';

// The trace and schemas each case feeds the fakenet, and what it attests. A
// `callFrame` of undefined means the transaction must not be traced at all.
// The contract-call row is the MPC's own oracle vector "uint256 decode
// narrows to uint128 response" (chain-ethereum/tests/fixtures/
// midnight_respond_vectors.json in github.com/sig-net/mpc).
const CASES: {
  name: string;
  calldata: string;
  callFrame: JsonValue | undefined;
  outputSchema: string;
  respondSchema: string;
  attested: string | undefined;
}[] = [
  {
    name: 'a plain transfer is not traced and attests the bool default',
    calldata: TRANSFER_CALLDATA,
    callFrame: undefined,
    outputSchema: BOOL_SCHEMA,
    respondSchema: BOOL_SCHEMA,
    attested: '0x01',
  },
  {
    name: 'a contract call attests its decoded return data',
    calldata: CONTRACT_CALLDATA,
    callFrame: {
      type: 'CALL',
      output:
        '0x0000000000000000000000000000000000000000000000000102030405060708',
    },
    outputSchema: '[{"name":"amount","type":"uint256"}]',
    respondSchema: '[{"name":"amount","type":"uint128"}]',
    attested: '0x08070605040302010000000000000000',
  },
  {
    name: 'a void call under an empty output schema attests the bool default',
    calldata: CONTRACT_CALLDATA,
    callFrame: { type: 'CALL', output: '0x' },
    outputSchema: '[]',
    respondSchema: BOOL_SCHEMA,
    attested: '0x01',
  },
  {
    name: 'a void call whose frame has no output attests the bool default',
    calldata: CONTRACT_CALLDATA,
    callFrame: { type: 'CALL' },
    outputSchema: '[]',
    respondSchema: BOOL_SCHEMA,
    attested: '0x01',
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
    outputSchema: '[]',
    respondSchema: BOOL_SCHEMA,
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
      respondSerializationSchema: Buffer.from(row.respondSchema),
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
      await new ChainSignatureServer(CONFIG)['handleCompletedTransaction'](
        txHash,
        txInfo,
        result
      );
    }

    assert.deepEqual(
      attestations,
      row.attested === undefined
        ? []
        : [{ output: row.attested, kind: OutputKind.executed }]
    );
    assert.equal(
      result.status,
      row.attested === undefined ? 'pending' : 'success'
    );
  });
}
