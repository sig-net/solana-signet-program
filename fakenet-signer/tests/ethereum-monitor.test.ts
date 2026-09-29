import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { EthereumMonitor } from '../src/modules/ethereum/EthereumMonitor';
import { TransactionFailureReason, type ServerConfig } from '../src/types';

const CONFIG: ServerConfig = {
  solanaRpcUrl: 'http://unused.invalid',
  evmRpcUrl: 'http://unused.invalid',
  mpcRootKey: '0x' + '01'.repeat(32),
  isDevnet: false,
  bitcoinNetwork: 'regtest',
};
const ADDRESS = '0x' + '11'.repeat(20);
const HASH = '0x' + '22'.repeat(32);

test('the signing block is the finalised height, whatever the nonce', async (t) => {
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getBlock',
    async (tag: string) => {
      assert.equal(tag, 'finalized');
      return { number: 100 };
    }
  );
  const nonceReads = t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionCount',
    async () => 8
  );
  assert.equal(await EthereumMonitor.getSigningBlock('eip155:1', CONFIG), 100);
  assert.equal(nonceReads.mock.callCount(), 0);
});

for (const consumedAt of [1001, 1050, 1100]) {
  test(`finds a sibling's nonce consumption at ${consumedAt} without querying before the signing block`, async (t) => {
    const queried: number[] = [];
    const sibling = '0x' + '55'.repeat(32);
    EthereumMonitor.recordSignedTransaction({
      hash: HASH,
      from: ADDRESS,
      nonce: 7,
      unsignedTransaction: '0x01',
    });
    EthereumMonitor.recordSignedTransaction({
      hash: sibling,
      from: ADDRESS,
      nonce: 7,
      unsignedTransaction: '0x02',
    });
    t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
      number: 1100,
    }));
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getTransactionReceipt',
      async (hash: string) =>
        hash === sibling ? { status: 1, blockNumber: consumedAt } : null
    );
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getTransactionCount',
      async (_address: string, height: number) => {
        queried.push(height);
        assert.ok(height >= 1000 && height <= 1100);
        return height >= consumedAt ? 8 : 7;
      }
    );
    assert.deepEqual(
      await EthereumMonitor.waitForTransactionAndGetOutput(
        HASH,
        'eip155:1',
        [],
        ADDRESS,
        7,
        1000,
        CONFIG
      ),
      {
        status: 'error',
        reason: TransactionFailureReason.Replaced,
        blockHeight: BigInt(consumedAt),
      }
    );
    assert.ok(queried.length > 0 && queried.length <= 10);
  });
}

test('a sibling over the same unsigned bytes is not a displacing sibling', async (t) => {
  const request = '0x' + '66'.repeat(32);
  const resigned = '0x' + '77'.repeat(32);
  for (const hash of [request, resigned]) {
    EthereumMonitor.recordSignedTransaction({
      hash,
      from: ADDRESS,
      nonce: 7,
      unsignedTransaction: '0x03',
    });
  }
  t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
    number: 200,
  }));
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionReceipt',
    async (hash: string) =>
      hash === resigned ? { status: 1, blockNumber: 150 } : null
  );
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionCount',
    async (_address: string, height: number) => (height >= 150 ? 8 : 7)
  );
  assert.deepEqual(
    await EthereumMonitor.waitForTransactionAndGetOutput(
      request,
      'eip155:1',
      [],
      ADDRESS,
      7,
      100,
      CONFIG
    ),
    { status: 'fatal_error', reason: 'nonce_consumed_without_sibling' }
  );
});

test('a nonce spent at the signing block produces no unviable attestation', async (t) => {
  t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
    number: 200,
  }));
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionReceipt',
    async () => null
  );
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionCount',
    async () => 8
  );
  assert.deepEqual(
    await EthereumMonitor.waitForTransactionAndGetOutput(
      HASH,
      'eip155:1',
      [],
      ADDRESS,
      7,
      100,
      CONFIG
    ),
    {
      status: 'fatal_error',
      reason: 'nonce_spent_before_signing',
    }
  );
});

test('missing historical state leaves replacement pending', async (t) => {
  t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
    number: 200,
  }));
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionReceipt',
    async () => null
  );
  t.mock.method(
    ethers.JsonRpcProvider.prototype,
    'getTransactionCount',
    async (_address: string, height: number) => {
      if (height !== 200) throw new Error('historical state unavailable');
      return 8;
    }
  );
  assert.deepEqual(
    await EthereumMonitor.waitForTransactionAndGetOutput(
      HASH,
      'eip155:1',
      [],
      ADDRESS,
      7,
      100,
      CONFIG
    ),
    { status: 'pending' }
  );
});

for (const row of [
  {
    height: 200,
    expected: {
      status: 'error',
      reason: TransactionFailureReason.Reverted,
      blockHeight: 200n,
    },
  },
  { height: 201, expected: { status: 'pending' } },
]) {
  test(`reverted receipt at ${row.height} waits for finality at 200`, async (t) => {
    t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
      number: 200,
    }));
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getTransactionReceipt',
      async () => ({ status: 0, blockNumber: row.height })
    );
    assert.deepEqual(
      await EthereumMonitor.waitForTransactionAndGetOutput(
        HASH,
        'eip155:1',
        [],
        ADDRESS,
        7,
        100,
        CONFIG
      ),
      row.expected
    );
  });
}

test('a missing signing block produces no attestation', async () => {
  assert.deepEqual(
    await EthereumMonitor.waitForTransactionAndGetOutput(
      HASH,
      'eip155:1',
      [],
      ADDRESS,
      7,
      undefined,
      CONFIG
    ),
    { status: 'fatal_error', reason: 'missing_signing_block' }
  );
});
