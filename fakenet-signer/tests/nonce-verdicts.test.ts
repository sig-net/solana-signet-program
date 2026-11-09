import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ethers } from 'ethers';
import { OutputKind } from '@sig-net/midnight';
import { EthereumMonitor } from '../src/modules/ethereum/EthereumMonitor';
import { handleEthereumBidirectional } from '../src/modules/ethereum/BidirectionalHandler';
import {
  MidnightMonitor,
  type MidnightSigningRequest,
} from '../src/modules/MidnightMonitor';
import { SubstrateMonitor } from '../src/modules/SubstrateMonitor';
import { ChainSignatureServer } from '../src/server/ChainSignatureServer';
import {
  TransactionFailureReason,
  type PendingTransaction,
  type ServerConfig,
  type SignBidirectionalEvent,
} from '../src/types';

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
const NONCE = 7;
const TX_FIELDS = {
  type: 2,
  chainId: 1,
  nonce: NONCE,
  gasLimit: 21_000,
  maxFeePerGas: 1,
  maxPriorityFeePerGas: 1,
  value: 0,
  data: '0x',
};
// The request under test, and a sibling over different unsigned bytes at
// the same nonce that replaces it.
const REQUEST_TX = ethers.getBytes(
  ethers.Transaction.from({ ...TX_FIELDS, to: '0x' + '11'.repeat(20) })
    .unsignedSerialized
);
const SIBLING_TX = ethers.getBytes(
  ethers.Transaction.from({ ...TX_FIELDS, to: '0x' + '99'.repeat(20) })
    .unsignedSerialized
);

// The MPC signs whatever nonce a request declares. A case fixes the
// finalised height when the request is signed, the block that takes its
// nonce, and whether the transaction mined there is a sibling this
// responder signed. The finalised height when the monitor polls is 200.
interface NonceCase {
  name: string;
  signingHeight: number;
  takenAt: number;
  takenBySibling: boolean;
}
const SIBLING_AFTER_SIGNING: NonceCase = {
  name: 'a watched sibling taking the nonce after signing',
  signingHeight: 100,
  takenAt: 150,
  takenBySibling: true,
};
const UNWATCHED_AFTER_SIGNING: NonceCase = {
  name: 'an unwatched transaction taking the nonce after signing',
  signingHeight: 100,
  takenAt: 150,
  takenBySibling: false,
};
const SIBLING_BEFORE_SIGNING: NonceCase = {
  name: 'a sibling that mined before the request was signed',
  signingHeight: 200,
  takenAt: 150,
  takenBySibling: true,
};
const UNWATCHED_BEFORE_SIGNING: NonceCase = {
  name: 'a nonce already spent when the request arrives',
  signingHeight: 200,
  takenAt: 150,
  takenBySibling: false,
};

/**
 * Mocks a finalised chain: the first finalised read (signing the request)
 * sees `signingHeight`, every later one 200. The sender's count shows the
 * nonce taken from `takenAt`, where only a transaction signed over
 * {@link SIBLING_TX} has a receipt.
 */
function mockChain(t: TestContext, row: NonceCase): void {
  let finalisedReads = 0;
  t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
    number: finalisedReads++ === 0 ? row.signingHeight : 200,
  }));
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionCount',
    async (_address: string, height: number) =>
      height >= row.takenAt ? NONCE + 1 : NONCE
  );
  const recorded = t.mock.method(EthereumMonitor, 'recordSignedTransaction');
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionReceipt',
    async (hash: string) =>
      recorded.mock.calls.some(
        ({ arguments: [tx] }) =>
          tx.hash.toLowerCase() === hash.toLowerCase() &&
          tx.unsignedTransaction === ethers.hexlify(SIBLING_TX)
      )
        ? { status: 1, blockNumber: row.takenAt }
        : null
  );
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransaction',
    async (hash: string) => ({ hash, data: '0x' })
  );
}

const BOOL_SCHEMA = '[{"name":"ok","type":"bool"}]';
const REQUEST: MidnightSigningRequest = {
  predecessor: '22'.repeat(32),
  requestId: new Uint8Array(32).fill(0x33),
  evmParams: {
    evmTo: new Uint8Array(20).fill(0x11),
    evmChainId: 1n,
    evmNonce: BigInt(NONCE),
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
  outputDeserializationSchema: new TextEncoder().encode(BOOL_SCHEMA),
  respondSerializationSchema: new TextEncoder().encode(BOOL_SCHEMA),
  // Read only by buildSerializedTransaction, which the tests mock.
  signetRequest: {} as MidnightSigningRequest['signetRequest'],
};
const SIBLING_REQUEST: MidnightSigningRequest = {
  ...REQUEST,
  requestId: new Uint8Array(32).fill(0x66),
  evmParams: { ...REQUEST.evmParams, evmTo: new Uint8Array(20).fill(0x99) },
};

// The MPC attests Unviable for Midnight only when a watched sibling over
// different unsigned bytes takes the nonce while the request is watched,
// at the sibling's block. Any other consumer gets no attestation.
for (const row of [
  {
    ...SIBLING_AFTER_SIGNING,
    attestations: [
      { output: '0x', blockHeight: 150n, kind: OutputKind.unviable },
    ],
  },
  { ...UNWATCHED_AFTER_SIGNING, attestations: [] },
  { ...SIBLING_BEFORE_SIGNING, attestations: [] },
  { ...UNWATCHED_BEFORE_SIGNING, attestations: [] },
]) {
  test(`Midnight signs, then attests the MPC's verdict for ${row.name}`, async (t) => {
    mockChain(t, row);
    t.mock.method(
      MidnightMonitor.prototype,
      'buildSerializedTransaction',
      (request: MidnightSigningRequest) =>
        request === SIBLING_REQUEST ? SIBLING_TX : REQUEST_TX
    );
    const signed = t.mock.method(
      MidnightMonitor.prototype,
      'broadcastSignedTransaction',
      async () => {}
    );
    const attestations: {
      output: string;
      blockHeight: bigint;
      kind: OutputKind;
    }[] = [];
    t.mock.method(
      MidnightMonitor.prototype,
      'signAndBroadcastResponse',
      async (
        requestId: Uint8Array,
        serializedOutput: Uint8Array,
        _sender: string,
        blockHeight: bigint,
        kind: OutputKind
      ) => {
        // The sibling's own execution is attested too, and not under test.
        if (ethers.hexlify(requestId) !== ethers.hexlify(REQUEST.requestId)) {
          return;
        }
        attestations.push({
          output: ethers.hexlify(serializedOutput),
          blockHeight,
          kind,
        });
      }
    );

    const server = new ChainSignatureServer(CONFIG);
    await server['handleMidnightSigningRequest'](REQUEST);
    if (row.takenBySibling) {
      await server['handleMidnightSigningRequest'](SIBLING_REQUEST);
    }
    await server['runTransactionMonitorTick']();

    assert.equal(signed.mock.callCount(), row.takenBySibling ? 2 : 1);
    assert.deepEqual(attestations, row.attestations);
  });
}

const BORSH_SCHEMA = '{"struct":{"ok":"bool"}}';
const EVENT: SignBidirectionalEvent = {
  sender: 'unused',
  serializedTransaction: REQUEST_TX,
  caip2Id: 'eip155:1',
  keyVersion: 0,
  path: 'path',
  algo: 'ecdsa',
  dest: 'ethereum',
  params: '',
  outputDeserializationSchema: Buffer.from('[]'),
  respondSerializationSchema: Buffer.from(BORSH_SCHEMA),
};
const SIBLING_EVENT: SignBidirectionalEvent = {
  ...EVENT,
  serializedTransaction: SIBLING_TX,
};
const DERIVED_KEY = '0x' + '44'.repeat(32);
// The Borsh error response: the 0xdeadbeef prefix and Borsh `{ error: true }`.
const ERROR_RESPONSE = '0xdeadbeef01';

// For Solana and Substrate the MPC answers Failed whatever takes the nonce:
// a sibling at its block, any other consumer at the block that noticed it.
// Both reach the same signed error response.
for (const row of [
  {
    ...SIBLING_AFTER_SIGNING,
    verdict: {
      status: 'error',
      reason: TransactionFailureReason.Replaced,
      blockHeight: 150n,
    },
  },
  {
    ...UNWATCHED_AFTER_SIGNING,
    verdict: {
      status: 'fatal_error',
      reason: 'nonce_consumed_without_sibling',
    },
  },
  {
    ...SIBLING_BEFORE_SIGNING,
    verdict: { status: 'fatal_error', reason: 'nonce_spent_before_signing' },
  },
  {
    ...UNWATCHED_BEFORE_SIGNING,
    verdict: { status: 'fatal_error', reason: 'nonce_spent_before_signing' },
  },
]) {
  test(`solana signs, then resolves the verdict for ${row.name}`, async (t) => {
    mockChain(t, row);
    const pendingTransactions = new Map<string, PendingTransaction>();
    const context = {
      sendSignatures: async () => undefined,
      config: CONFIG,
      pendingTransactions,
      source: 'solana' as const,
    };

    await handleEthereumBidirectional(EVENT, context, DERIVED_KEY);
    const [pending] = pendingTransactions.values();
    if (row.takenBySibling) {
      await handleEthereumBidirectional(SIBLING_EVENT, context, DERIVED_KEY);
    }

    assert.ok(pending, 'the signed request is monitored');
    assert.deepEqual(
      await EthereumMonitor.waitForTransactionAndGetOutput(
        pending.txHash,
        pending.caip2Id,
        pending.outputDeserializationSchema,
        pending.fromAddress,
        pending.nonce,
        pending.signedAtBlock,
        CONFIG
      ),
      row.verdict
    );
  });

  test(`polkadot signs, then answers ${row.name} with the error response`, async (t) => {
    mockChain(t, row);
    t.mock.method(
      SubstrateMonitor.prototype,
      'sendSignatureResponse',
      async () => {}
    );
    const responses: string[] = [];
    t.mock.method(
      SubstrateMonitor.prototype,
      'sendRespondBidirectional',
      async (_requestId: Uint8Array, serializedOutput: Uint8Array) => {
        responses.push(ethers.hexlify(serializedOutput));
      }
    );
    const server = new ChainSignatureServer(CONFIG);
    // Built without its constructor, the monitor opens no websocket.
    server['substrateMonitor'] = Object.create(
      SubstrateMonitor.prototype
    ) as SubstrateMonitor;
    const context = server['getSubstrateBidirectionalContext']();

    await handleEthereumBidirectional(EVENT, context, DERIVED_KEY);
    if (row.takenBySibling) {
      await handleEthereumBidirectional(SIBLING_EVENT, context, DERIVED_KEY);
    }
    await server['runTransactionMonitorTick']();

    // A sibling, when there is one, executed and answers `{ ok: true }`.
    assert.deepEqual(
      responses,
      row.takenBySibling ? [ERROR_RESPONSE, '0x01'] : [ERROR_RESPONSE]
    );
  });
}
