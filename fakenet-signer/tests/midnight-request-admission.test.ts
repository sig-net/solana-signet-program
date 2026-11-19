import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AnySignBidirectionalEvent,
  contractAddressFromHex,
  MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH,
  TRON_CAIP2_ID,
  TxParamType,
} from '@sig-net/midnight';
import { MidnightMonitor } from '../src/modules/MidnightMonitor';
import { midnightRequestRejection } from '../src/modules/midnight/request-admission';
import { TronWatcher } from '../src/modules/tron/TronWatcher';
import { ChainSignatureServer } from '../src/server/ChainSignatureServer';
import type { ServerConfig } from '../src/types';

const READ_ADDRESS = 'ab'.repeat(32);

function padded(text: string | Uint8Array, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(typeof text === 'string' ? new TextEncoder().encode(text) : text);
  return out;
}

const FAMILIES = [
  ['EVM', TxParamType.evmType2, 'eip155:1'],
  ['Tron', TxParamType.tron, TRON_CAIP2_ID],
] as const;

function record(
  txParamType: number,
  dest: string,
  overrides: Partial<AnySignBidirectionalEvent> = {}
): AnySignBidirectionalEvent {
  return {
    keyVersion: 1n,
    sender: contractAddressFromHex(READ_ADDRESS),
    path: new Uint8Array(32).fill(0x07),
    algo: 0,
    txParamType,
    txParams: {} as never,
    executionDest: padded(dest, 64),
    signatureDest: 0,
    params: new Uint8Array(64),
    outputDeserializationSchema: new Uint8Array(0),
    respondSerializationSchema: new Uint8Array(0),
    ...overrides,
  } as AnySignBidirectionalEvent;
}

const REFUSALS: [string, Partial<AnySignBidirectionalEvent>, RegExp][] = [
  [
    'a sender other than the address it was read from',
    { sender: contractAddressFromHex('cd'.repeat(32)) },
    /does not match the address it was read from/,
  ],
  ['key_version 0', { keyVersion: 0n }, /key_version 0/],
  [
    'a key_version above the latest',
    { keyVersion: 2n },
    /unsupported key_version 2/,
  ],
  ['a non-ecdsa algo', { algo: 1 }, /unsupported algo/],
  [
    'a signature_dest other than unused',
    { signatureDest: 1 },
    /unsupported signature_dest/,
  ],
  [
    'the reserved response-key path',
    { path: padded(MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH, 32) },
    /path is reserved/,
  ],
  [
    'non-zero params',
    { params: padded(Uint8Array.from([1]), 64) },
    /params is reserved/,
  ],
  [
    'an execution_dest with an interior NUL',
    { executionDest: padded('eip155\0:1', 64) },
    /interior NUL/,
  ],
  [
    'an execution_dest that is not UTF-8',
    { executionDest: padded(Uint8Array.from([0xff]), 64) },
    /not valid UTF-8/,
  ],
];

for (const [family, txParamType, dest] of FAMILIES) {
  test(`a clean ${family} record is admitted`, () => {
    assert.equal(
      midnightRequestRejection(record(txParamType, dest), READ_ADDRESS),
      undefined
    );
    assert.equal(
      midnightRequestRejection(
        record(txParamType, dest),
        '0x' + READ_ADDRESS.toUpperCase()
      ),
      undefined
    );
    assert.equal(
      midnightRequestRejection(
        record(txParamType, dest, { path: new Uint8Array(32) }),
        READ_ADDRESS
      ),
      undefined
    );
  });

  test(`a ${family} record whose execution_dest names the other family is refused`, () => {
    const other = dest === TRON_CAIP2_ID ? 'eip155:1' : TRON_CAIP2_ID;
    assert.match(
      midnightRequestRejection(record(txParamType, other), READ_ADDRESS) ?? '',
      /does not name/
    );
  });

  for (const [name, overrides, reason] of REFUSALS) {
    test(`a ${family} record with ${name} is refused`, () => {
      assert.match(
        midnightRequestRejection(
          record(txParamType, dest, overrides),
          READ_ADDRESS
        ) ?? '',
        reason
      );
    });
  }
}

test('the response-key path with one more byte set is not the reserved path', () => {
  const path = padded(MIDNIGHT_RESPOND_BIDIRECTIONAL_PATH, 32);
  path[31] = 1;
  assert.equal(
    midnightRequestRejection(
      record(TxParamType.tron, TRON_CAIP2_ID, { path }),
      READ_ADDRESS
    ),
    undefined
  );
});

const CONFIG: ServerConfig = {
  disableSolana: true,
  solanaRpcUrl: 'http://unused.invalid',
  evmRpcUrl: 'http://unused.invalid',
  mpcRootKey: '0x' + '01'.repeat(32),
  isDevnet: false,
  bitcoinNetwork: 'regtest',
  midnightIndexerUrl: 'http://unused.invalid',
  midnightSignerContractAddress: 'unused',
  midnightResponderContractAddress: 'unused',
  tronRpcUrl: 'http://unused.invalid:9090',
};

for (const [family, txParamType, dest] of FAMILIES) {
  for (const [name, overrides] of REFUSALS) {
    test(`the server never signs a ${family} request with ${name}`, async (t) => {
      const evmBuilds = t.mock.method(
        MidnightMonitor.prototype,
        'buildSerializedTransaction',
        () => {
          throw new Error('an inadmissible request reached the EVM builder');
        }
      );
      const tronSignatures = t.mock.method(
        MidnightMonitor.prototype,
        'postTronSignature',
        async () => {}
      );
      const watches = t.mock.method(TronWatcher.prototype, 'watch', () => {});
      const server = new ChainSignatureServer(CONFIG);
      await server['handleMidnightSigningRequest']({
        predecessor: READ_ADDRESS,
        requestId: new Uint8Array(32).fill(0x33),
        calldata: { words: [] },
        caip2Id: dest,
        keyVersion: 1,
        path: new Uint8Array(32),
        algo: 'ecdsa',
        dest: 'unused',
        params: new Uint8Array(64),
        outputDeserializationSchema: new Uint8Array(0),
        signetRequest: record(txParamType, dest, overrides),
      });
      assert.equal(evmBuilds.mock.callCount(), 0);
      assert.equal(tronSignatures.mock.callCount(), 0);
      assert.equal(watches.mock.callCount(), 0);
    });
  }
}
