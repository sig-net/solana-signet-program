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

for (const row of [
  { count: 6, expected: 100 },
  { count: 7, expected: 100 },
  { count: 8, expected: undefined },
]) {
  test(`admission checks nonce 7 against finalised count ${row.count}`, async (t) => {
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getBlock',
      async (tag: string) => {
        assert.equal(tag, 'finalized');
        return { number: 100 };
      }
    );
    t.mock.method(
      ethers.JsonRpcProvider.prototype,
      'getTransactionCount',
      async (address: string, height: number) => {
        assert.equal(address, ADDRESS);
        assert.equal(height, 100);
        return row.count;
      }
    );
    assert.equal(
      await EthereumMonitor.getSigningBlock('eip155:1', ADDRESS, 7, CONFIG),
      row.expected
    );
  });
}

for (const consumedAt of [1001, 1050, 1100]) {
  test(`finds nonce consumption at ${consumedAt} without querying before admission`, async (t) => {
    const queried: number[] = [];
    t.mock.method(ethers.JsonRpcProvider.prototype, 'getBlock', async () => ({
      number: 1100,
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

test('a nonce spent at admission produces no unviable attestation', async (t) => {
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

test('a missing admission boundary produces no attestation', async () => {
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
