// This server's OWN midnight-js provider composition for the central signet
// contract. @sig-net/midnight-contract is platform-agnostic and deliberately
// ships no environment bindings — every consumer declares where zk artifacts
// come from, where private state is stored, and how its wallet adapts to
// midnight-js. This is the Node composition of THIS server, ported from
// @midnight-erc20-vault/lib's midnight-providers.ts + deploy.ts (same pattern
// as ./wallet and ./midnight-node-config).

import { createRequire } from 'node:module';
import path from 'node:path';

import { CompiledContract } from '@midnight-ntwrk/compact-js/effect';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  createProofProvider,
  ZKConfigRegistry,
  zkConfigToProvingKeyMaterial,
  type MidnightProvider,
  type ProofProvider,
  type UnboundTransaction,
  type WalletProvider,
  type ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js/types';
import type {
  ProvingKeyMaterial,
  ProvingProvider,
} from '@midnightntwrk/ledger-v9';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import {
  Contract,
  SIGNET_CONTRACT_PRIVATE_STATE_ID,
  type SignetContractCircuitId,
  type SignetContractProviders,
  type SignetContractPrivateState,
} from '@sig-net/midnight-contract';

import type { MidnightNodeConfig } from './midnight-node-config';
import type { AccountKeys } from './wallet';

/**
 * The npm package's bundled compiler output (contract module, zkir, VERIFIER
 * keys). Resolved through the package's `./managed/*` subpath export, so it
 * tracks wherever the package manager puts it.
 *
 * NOTE: the published package does NOT ship prover keys (hundreds of MB), so
 * this default can join/read the contract but cannot PROVE a call
 * transaction. Posting responses requires `zkConfigPath` pointing at a full
 * `compact compile` output dir for the signet contract — see
 * MIDNIGHT_ZK_CONFIG_PATH.
 */
export const packagedManagedPath = path.dirname(
  path.dirname(
    createRequire(import.meta.url).resolve(
      '@sig-net/midnight-contract/managed/compiler/contract-manifest.json'
    )
  )
);

/**
 * The signet-contract compact-js compiled-contract binding: generated module
 * (the contract declares no witnesses) bound to on-disk compiled assets.
 * Consumed by `findDeployedContract`.
 *
 * @param managedDirPath - The compiler output dir (`contract/`, `keys/`, `zkir/`).
 * @returns The bound compiled contract.
 */
export function makeSignetContractCompiledContract(managedDirPath: string) {
  const base = CompiledContract.make<
    Contract<SignetContractPrivateState>,
    SignetContractPrivateState
  >('signet-contract', Contract);
  const vacant = CompiledContract.withVacantWitnesses(base);
  return CompiledContract.withCompiledFileAssets(vacant, managedDirPath);
}

// Balancing recipes expire 30 min out (same TTL the wallet-side submit uses).
const BALANCE_TTL_MS = 30 * 60 * 1000;

/**
 * Adapt a started {@link WalletFacade} + {@link AccountKeys} to midnight-js's
 * `WalletProvider & MidnightProvider`. `balanceTx` balances the unbound
 * transaction with the account's shielded/dust keys, signs, then finalizes
 * (which proves); `submitTx` relays through the facade. The casts bridge the
 * midnight-js-protocol vs ledger-v9 nominal type identities of the same
 * underlying classes.
 */
function createWalletAndMidnightProvider(
  facade: WalletFacade,
  keys: AccountKeys
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction, ttl?: Date) {
      const recipe = await facade.balanceUnboundTransaction(
        tx as never,
        {
          shieldedSecretKeys: keys.shieldedSecretKeys,
          dustSecretKey: keys.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + BALANCE_TTL_MS) }
      );
      const signed = await facade.signRecipe(
        recipe,
        keys.unshieldedKeystore.signDataAsync
      );
      return (await facade.finalizeRecipe(signed)) as never;
    },
    submitTx: (tx) => facade.submitTransaction(tx as never) as never,
  };
}

/**
 * Proof provider via the proof server's /check + /prove endpoints, with ZK key
 * material resolved from the contract's compiled assets. Exists instead of
 * midnight-js's own `httpClientProofProvider` because that one (5.0.0-beta.3)
 * lacks the `lookupKey` the ledger-v9 1.0.0-rc.3 WASM validates for — delete
 * in favor of `httpClientProofProvider` once midnight-js ships a beta aligned
 * with ledger-v9 1.0.0-rc.3. (Ported from lib's createProofServerProvider.)
 */
function createProofServerProvider<K extends string>(
  proofServerUrl: string,
  zkConfigProvider: ZKConfigProvider<K>
): ProofProvider {
  const registry = new ZKConfigRegistry([
    zkConfigProvider as ZKConfigProvider<string>,
  ]);

  // Pass the REGISTRY (not the provider) to the base: its /check and /prove
  // key resolution special-cases a ZKConfigRegistry. The `as` bridges the
  // nominal type: the base only ever calls `.resolveKeyLocation` on it.
  const base = httpClientProvingProvider(
    proofServerUrl,
    registry as unknown as ZKConfigProvider<string>
  );

  const lookupKey = async (
    keyLocation: string
  ): Promise<ProvingKeyMaterial | undefined> => {
    const resolved = await registry.resolveKeyLocation(keyLocation);
    if (resolved !== undefined) {
      return zkConfigToProvingKeyMaterial(resolved);
    }
    try {
      return zkConfigToProvingKeyMaterial(
        await zkConfigProvider.get(keyLocation as K)
      );
    } catch {
      // Protocol builtins ("midnight/...") resolve to undefined and are
      // supplied by the proof server itself.
      return undefined;
    }
  };

  const provingProvider: ProvingProvider = { ...base, lookupKey };
  return createProofProvider(provingProvider);
}

/**
 * Build this server's midnight-js provider set for the signet contract.
 *
 * @param facade - A started (and synced) wallet facade — see ./wallet.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @param zkConfigPath - The zk-config root holding this contract's FULL
 *   compiled output, prover keys included (posting responses proves
 *   `postRespondBidirectional`). Defaults to the npm package's bundled assets,
 *   which can read/join but NOT prove — set MIDNIGHT_ZK_CONFIG_PATH.
 * @returns The provider set to hand to `findDeployedContract`.
 */
export function buildSignetContractProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig,
  zkConfigPath: string = packagedManagedPath
): SignetContractProviders {
  // Retrieves the ZK artifacts of the contract needed to create proofs.
  const zkConfigProvider = new NodeZkConfigProvider<SignetContractCircuitId>(
    zkConfigPath
  );

  // The wallet, adapted to midnight-js's balancer + submitter interfaces
  // (the facade itself does not implement WalletProvider/MidnightProvider).
  const walletAndMidnightProvider = createWalletAndMidnightProvider(
    facade,
    keys
  );
  const accountId = walletAndMidnightProvider.getCoinPublicKey();

  return {
    // Manages the private state of the contract, plus contract-maintenance
    // signing keys. Store names are scoped to this server to avoid collision
    // with other dApps sharing the same LevelDB. The signet contract's private
    // state is empty, so nothing is lost if the store is cleared.
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `${SIGNET_CONTRACT_PRIVATE_STATE_ID}-private-states`,
      signingKeyStoreName: `${SIGNET_CONTRACT_PRIVATE_STATE_ID}-signing-keys`,
      accountId,
      // A constant in source is obfuscation, not secrecy — acceptable here
      // only because nothing sensitive is stored (empty private state).
      // Value unchanged from the pre-severing package so existing local
      // stores still open.
      privateStoragePasswordProvider: () => '&*(BHJqwe419-signetContract',
    }),

    // Retrieves public data from the blockchain.
    publicDataProvider: indexerPublicDataProvider({
      queryURL: config.indexerUrl,
      subscriptionURL: config.indexerWsUrl,
    }),

    zkConfigProvider,

    // Creates proven, unbalanced transactions (proves the contract-call
    // transcript). Distinct from the wallet's own balancing proofs.
    proofProvider: createProofServerProvider(
      config.proofServerUrl,
      zkConfigProvider
    ),

    // Creates proven, balanced transactions.
    walletProvider: walletAndMidnightProvider,

    // Submits proven, balanced transactions to the network.
    midnightProvider: walletAndMidnightProvider,
  };
}
