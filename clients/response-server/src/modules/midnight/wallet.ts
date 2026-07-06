import * as ledger from "@midnight-ntwrk/ledger-v8";
import { parseSeed } from "./seed";
import { NetworkId } from "./network-id";
import type { MidnightNodeConfig } from "./midnight-node-config";
import {
  createKeystore,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import {
  WalletFacade,
  mergeWalletEntries,
  WalletEntrySchema,
} from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";

/**
 * The fee settings the facade balances transactions with: it burns
 * `feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead` per
 * transaction.
 */
export const COST_PARAMETERS: { readonly additionalFeeOverhead: bigint; readonly feeBlocksMargin: number } = {
  additionalFeeOverhead: 300_000_000_000n,
  feeBlocksMargin: 5,
};

/** The live key material for one account. Reused for signing / balancing. */
export interface AccountKeys {
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

/**
 * Parse a seed and derive the three role keys (Zswap / NightExternal / Dust).
 * Pure crypto — no network. This is the step that exercises the ledger WASM.
 */
export function deriveAccountKeys(seed: string, networkId: NetworkId): AccountKeys {
  const { seed: seedBytes } = parseSeed(seed);

  const hd = HDWallet.fromSeed(seedBytes);
  if (hd.type !== "seedOk") throw new Error("HDWallet.fromSeed failed (seedError).");

  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("deriveKeysAt failed (keyOutOfBounds).");
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], networkId);

  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

/**
 * Wire up the WalletFacade for the given keys + connection config. This only
 * constructs the three sub-wallets — it does NOT start syncing.
 */
export function initialiseWalletFacade(keys: AccountKeys, config: MidnightNodeConfig): Promise<WalletFacade> {
  return WalletFacade.init({
    configuration: {
      networkId: config.networkId,
      indexerClientConnection: {
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
      },
      provingServerUrl: new URL(config.proofServerUrl),
      // The facade talks to the node over WebSocket, so flip http(s) -> ws(s).
      relayURL: new URL(config.nodeUrl.replace(/^http/, "ws")),
      costParameters: COST_PARAMETERS,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(keys.unshieldedKeystore)),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(keys.dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
}