import * as ledger from '@midnightntwrk/ledger-v9';
import { parseSeed } from './seed';
import { NetworkId } from './network-id';
import type { MidnightNodeConfig } from './midnight-node-config';
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { WalletSeeds } from '@midnightntwrk/wallet-sdk-hd';
import {
  WalletFacade,
  mergeWalletEntries,
  WalletEntrySchema,
} from '@midnightntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';

/**
 * The fee settings the facade balances transactions with: it burns
 * `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead` per
 * transaction.
 */
export const COST_PARAMETERS: {
  readonly additionalFeeOverhead: bigint;
  readonly feeBlocksMargin: number;
} = {
  additionalFeeOverhead: 300_000_000_000n,
  feeBlocksMargin: 5,
};

/** The live key material for one account. Reused for signing / balancing. */
export interface AccountKeys {
  /** The three per-wallet seeds the facade and its sub-wallets start from. */
  seeds: WalletSeeds;
  /** The shielded key pair the seeds derive: its coin and encryption public keys identify the account. */
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  unshieldedKeystore: UnshieldedKeystore;
}

/**
 * Parse a seed and derive the three per-wallet seeds (Zswap / NightExternal /
 * Dust roles at account 0, address index 0) plus the keys read off them.
 * Pure crypto, no network. This is the step that exercises the ledger WASM.
 */
export function deriveAccountKeys(
  seed: string,
  networkId: NetworkId
): AccountKeys {
  const { seed: seedBytes } = parseSeed(seed);
  const seeds = WalletSeeds.fromMasterSeed(seedBytes);

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(seeds.shielded);
  const unshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: seeds.unshielded },
    networkId
  );

  return { seeds, shieldedSecretKeys, unshieldedKeystore };
}

/**
 * Wire up the WalletFacade for the given keys + connection config. This only
 * constructs the three sub-wallets — it does NOT start syncing.
 */
export function initialiseWalletFacade(
  keys: AccountKeys,
  config: MidnightNodeConfig
): Promise<WalletFacade> {
  return WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: {
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
      },
      provingServerUrl: new URL(config.proofServerUrl),
      // The facade talks to the node over WebSocket, so flip http(s) -> ws(s).
      relayURL: new URL(config.nodeUrl.replace(/^http/, 'ws')),
      costParameters: COST_PARAMETERS,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(
        WalletEntrySchema,
        mergeWalletEntries
      ),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(keys.seeds.shielded),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore)
      ),
    dust: (cfg) => DustWallet(cfg).startWithSeed(keys.seeds.dust),
  });
}
