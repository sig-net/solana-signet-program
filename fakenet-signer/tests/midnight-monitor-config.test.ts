import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MidnightMonitor } from '../src/modules/MidnightMonitor';
import { OutputCacheStore } from '../src/server/OutputCache';
import type { ServerConfig } from '../src/types';

const BASE: ServerConfig = {
  disableSolana: true,
  solanaRpcUrl: 'http://unused.invalid',
  evmRpcUrl: 'http://unused.invalid',
  mpcRootKey: '0x' + '01'.repeat(32),
  isDevnet: false,
  bitcoinNetwork: 'regtest',
};
const INDEXER = 'http://indexer.invalid/api/v4/graphql';
const SIGNET = 'aa'.repeat(32);
const RESPONDER = 'bb'.repeat(32);

// The Midnight leg needs the indexer, the signet contract (request
// discovery) and the responder (where responses are posted). A partial
// config names what is missing; an absent one stays silent.
const CASES: {
  name: string;
  midnight: Partial<ServerConfig>;
  starts: boolean;
  warning: RegExp | undefined;
}[] = [
  {
    name: 'all three set',
    midnight: {
      midnightIndexerUrl: INDEXER,
      midnightSignetContractAddress: SIGNET,
      midnightResponderContractAddress: RESPONDER,
    },
    starts: true,
    warning: undefined,
  },
  {
    name: 'the responder missing',
    midnight: {
      midnightIndexerUrl: INDEXER,
      midnightSignetContractAddress: SIGNET,
    },
    starts: false,
    warning: /^MidnightMonitor: MIDNIGHT_RESPONDER_CONTRACT_ADDRESS missing/,
  },
  {
    name: 'the indexer and the signet contract missing',
    midnight: { midnightResponderContractAddress: RESPONDER },
    starts: false,
    warning:
      /^MidnightMonitor: MIDNIGHT_INDEXER_URL, MIDNIGHT_SIGNET_CONTRACT_ADDRESS missing/,
  },
  { name: 'nothing set', midnight: {}, starts: false, warning: undefined },
];

for (const row of CASES) {
  test(`Midnight leg with ${row.name}`, (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const monitor = MidnightMonitor.fromServerConfig(
      { ...BASE, ...row.midnight },
      new OutputCacheStore('v1/test')
    );

    assert.equal(monitor !== null, row.starts);
    if (row.warning === undefined) {
      assert.equal(warn.mock.callCount(), 0);
    } else {
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0]?.arguments[0]), row.warning);
    }
    if (monitor !== null) {
      // Discovery reads the signet contract; responses go to the responder.
      assert.equal(monitor['config'].signetContractAddress, SIGNET);
      assert.equal(monitor['config'].responderContractAddress, RESPONDER);
    }
  });
}
