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
import { ChainSignatureServer } from '../src/server/ChainSignatureServer';
import {
  TransactionFailureReason,
  type PendingTransaction,
  type ServerConfig,
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
const UNSIGNED_TX = ethers.getBytes(
  ethers.Transaction.from({
    type: 2,
    chainId: 1,
    nonce: NONCE,
    to: '0x' + '11'.repeat(20),
    gasLimit: 21_000,
    maxFeePerGas: 1,
    maxPriorityFeePerGas: 1,
    value: 0,
    data: '0x',
  }).unsignedSerialized
);
const BOOL_SCHEMA = '[{"name":"ok","type":"bool"}]';

// The MPC signs whatever nonce a request declares. A nonce state fixes the
// finalised height at signing and the first block from which the sender's
// transaction count shows the nonce taken by another transaction. The
// finalised height at the monitor's poll is 200.
interface NonceState {
  name: string;
  signingHeight: number;
  spentFrom: number;
}
const SPENT_BEFORE_SIGNING: NonceState = {
  name: 'a nonce already spent when the request arrives',
  signingHeight: 200,
  spentFrom: 0,
};
const TAKEN_AFTER_SIGNING: NonceState = {
  name: 'a fresh nonce taken after signing',
  signingHeight: 100,
  spentFrom: 150,
};

/** Mocks a finalised chain where the sender's nonce is taken at `spentFrom`. */
function mockChain(t: TestContext, row: NonceState): void {
  let finalisedReads = 0;
  t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
    number: finalisedReads++ === 0 ? row.signingHeight : 200,
  }));
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionReceipt',
    async () => null
  );
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionCount',
    async (_address: string, height: number) =>
      height >= row.spentFrom ? NONCE + 1 : NONCE
  );
}

for (const row of [
  { ...SPENT_BEFORE_SIGNING, attestations: [] },
  {
    ...TAKEN_AFTER_SIGNING,
    attestations: [
      { output: '0x', blockHeight: 150n, kind: OutputKind.unviable },
    ],
  },
]) {
  test(`Midnight signs ${row.name} and attests only the MPC's verdict`, async (t) => {
    mockChain(t, row);
    t.mock.method(
      MidnightMonitor.prototype,
      'buildSerializedTransaction',
      () => UNSIGNED_TX
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
        _requestId: Uint8Array,
        serializedOutput: Uint8Array,
        _sender: string,
        blockHeight: bigint,
        kind: OutputKind
      ) => {
        attestations.push({
          output: ethers.hexlify(serializedOutput),
          blockHeight,
          kind,
        });
      }
    );
    const request: MidnightSigningRequest = {
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
      // Read only by buildSerializedTransaction, which is mocked above.
      signetRequest: {} as MidnightSigningRequest['signetRequest'],
    };

    const server = new ChainSignatureServer(CONFIG);
    await server['handleMidnightSigningRequest'](request);
    await server['runTransactionMonitorTick']();

    assert.equal(signed.mock.callCount(), 1);
    assert.deepEqual(attestations, row.attestations);
  });
}

for (const source of ['solana', 'polkadot'] as const) {
  for (const row of [
    {
      ...SPENT_BEFORE_SIGNING,
      verdict: {
        status: 'fatal_error',
        reason: 'nonce_spent_before_signing',
      },
    },
    {
      ...TAKEN_AFTER_SIGNING,
      verdict: {
        status: 'error',
        reason: TransactionFailureReason.Replaced,
        blockHeight: 150n,
      },
    },
  ]) {
    test(`${source} signs ${row.name} and resolves the MPC's verdict`, async (t) => {
      mockChain(t, row);
      const pendingTransactions = new Map<string, PendingTransaction>();
      const signed = t.mock.fn(async () => undefined);

      await handleEthereumBidirectional(
        {
          sender: 'unused',
          serializedTransaction: UNSIGNED_TX,
          caip2Id: 'eip155:1',
          keyVersion: 0,
          path: 'path',
          algo: 'ecdsa',
          dest: 'ethereum',
          params: '',
          outputDeserializationSchema: Buffer.from(BOOL_SCHEMA),
          respondSerializationSchema: Buffer.from(BOOL_SCHEMA),
        },
        { sendSignatures: signed, config: CONFIG, pendingTransactions, source },
        '0x' + '44'.repeat(32)
      );

      assert.equal(signed.mock.callCount(), 1);
      const [pending] = pendingTransactions.values();
      assert.ok(pending, 'the signed request is monitored');
      assert.equal(pending.signedAtBlock, row.signingHeight);
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
  }
}
