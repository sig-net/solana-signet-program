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
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  type MidnightProvider,
  type ProofProvider,
  type UnboundTransaction,
  type WalletProvider,
  type ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js/types';
import type { FinalizedTransaction } from '@midnightntwrk/ledger-v9';
import {
  ProtocolVersion,
  WalletTransaction,
} from '@midnightntwrk/wallet-sdk-abstractions';
import {
  DefaultForkSchedule,
  type WalletFacade,
} from '@midnightntwrk/wallet-sdk-facade';
import { Either } from 'effect';
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
 * The npm package's bundled compiler output (contract module, zkir, prover +
 * verifier keys). Resolved through the package's `./managed/*` subpath export.
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
 * transaction with the account's wallets, signs, then finalizes (which
 * proves); `submitTx` relays through the facade.
 *
 * midnight-js hands over and expects bare ledger transactions, while the
 * facade only accepts {@link WalletTransaction} handles stamped with the
 * protocol version they were authored for. Every crossing here stamps the
 * facade's active protocol version and unwraps within that version's epoch,
 * so a chain still on the ledger-v8 side of the fork is refused before
 * anything is proved against the wrong ledger.
 */
function createWalletAndMidnightProvider(
  facade: WalletFacade,
  keys: AccountKeys
): WalletProvider & MidnightProvider {
  const activeProtocolVersion =
    async (): Promise<ProtocolVersion.ProtocolVersion> =>
      (await facade.waitForSyncedState()).activeProtocolVersion;

  return {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction, ttl?: Date) {
      const version = await activeProtocolVersion();
      const recipe = await facade.balanceUnboundTransaction(
        WalletTransaction.adopt('Unbound', tx, version),
        { ttl: ttl ?? new Date(Date.now() + BALANCE_TTL_MS) }
      );
      const signed = await facade.signRecipe(
        recipe,
        keys.unshieldedKeystore.signDataAsync
      );
      const finalized = await facade.finalizeRecipe(signed);
      return Either.getOrThrowWith(
        WalletTransaction.unwrapWithin<FinalizedTransaction>(
          finalized,
          ProtocolVersion.epochOf(version, DefaultForkSchedule.v9)
        ),
        (mismatch) => mismatch
      );
    },
    async submitTx(tx: FinalizedTransaction) {
      return facade.submitTransaction(
        WalletTransaction.adopt('Finalized', tx, await activeProtocolVersion())
      );
    },
  };
}

/**
 * Proof provider via the proof server's /check + /prove endpoints, with ZK key
 * material resolved from the contract's compiled assets.
 */
function createProofServerProvider<K extends string>(
  proofServerUrl: string,
  zkConfigProvider: ZKConfigProvider<K>
): ProofProvider {
  return httpClientProofProvider({ url: proofServerUrl, zkConfigProvider });
}

/**
 * Build this server's midnight-js provider set for the signet contract.
 *
 * @param facade - A started (and synced) wallet facade — see ./wallet.
 * @param keys - The key material of the same wallet, for balancing and signing.
 * @param config - The Midnight network endpoints to run against.
 * @returns The provider set to hand to `findDeployedContract`.
 */
export function buildSignetContractProviders(
  facade: WalletFacade,
  keys: AccountKeys,
  config: MidnightNodeConfig
): SignetContractProviders {
  // Retrieves the ZK artifacts of the contract needed to create proofs.
  const zkConfigProvider = new NodeZkConfigProvider<SignetContractCircuitId>(
    packagedManagedPath
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
