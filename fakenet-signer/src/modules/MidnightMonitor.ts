/**
 * MidnightMonitor - Generic signet monitor for any Midnight contract.
 *
 * The MPC needs ONLY a contract address. No compiled contract, no ZK keys,
 * no contract-info.json. State is read by the signet layout convention via
 * the shared reader: request index at ledger field 0, request counter at
 * field 1.
 *
 * Flow:
 * 1. Polls the contract's raw state via the Midnight GraphQL indexer
 * 2. Reads the signet nonce counter (field 1) to detect new requests cheaply
 * 3. Decodes the request index (field 0) and skips already-processed ids
 * 4. Builds ABI calldata + RLP transaction off-chain
 * 5. Posts the MPC's ECDSA signature to the signet contract (postSignatureResponse)
 * 6. After the EVM tx confirms, Schnorr-signs
 *    (requestId, hash(serializedOutput, outputLen)) and posts the attestation
 *    on-chain (postRespondBidirectional) — verified in-circuit against the
 *    sealed MPC key. The USER polls and calls claimDeposit().
 */

import { Buffer } from 'buffer';
import { ethers } from 'ethers';
import type { ServerConfig } from '../types';

import type { SigningRequest } from '../managed/erc20-vault/signet/types';

// Schnorr signing, the attestation-message circuit, and the Schnorr challenge
// all come from signet-midnight — the SAME compiled circuits the signet
// contract verifies against. Signing here with them is what makes an
// attestation pass postRespondBidirectional's in-circuit check.
import {
  bytesToHex,
  SignetRequestFeed,
  signatureToSignatureResponse,
  signBidirectionalRequestToUnsignedEVMTransaction,
  deriveJubjubKeypair,
  type JubjubKeypair,
  hashJubjubPoint,
  schnorrSign,
  pureCircuits as signetCircuits,
  SERIALIZED_OUTPUT_BYTES,
  type ResolvedSignetRequest,
  type RequestIdHex,
  type SignBidirectionalRequest,
  type SignatureResponse,
  type RespondBidirectional,
} from '@midnight-erc20-vault/signet-midnight';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import {
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js/contracts';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import {
  buildSignetContractProviders,
  signetContractCompiledContract,
  SIGNET_CONTRACT_PRIVATE_STATE_ID,
  createSignetContractPrivateState,
  type Contract as SignetContract,
  type SignetContractPrivateState,
} from '@midnight-erc20-vault/signet-contract';

import {
  deriveAccountKeys,
  initialiseWalletFacade,
  type AccountKeys,
} from './midnight/wallet';
import type { NetworkId } from './midnight/network-id';
import type { MidnightNodeConfig } from './midnight/midnight-node-config';

// ---- Types ----

export interface MidnightSigningRequest extends SigningRequest {
  /**
   * The nested on-ledger request record as read by signet-midnight — the
   * canonical source the shared tx builder consumes. The flat `SigningRequest`
   * fields are the string-decoded/flattened view kept for key derivation,
   * signing, and logging.
   */
  signetRequest: SignBidirectionalRequest;
}

export interface SignedResponse {
  requestId: string;
  serializedOutput: string;
  outputLen: number;
  pk: { x: string; y: string };
  announcement: { x: string; y: string };
  response: string;
}

export interface MidnightMonitorConfig {
  networkId: NetworkId;
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  proofServerUrl: string;
  /**
   * Address of the deployed central signet contract. The responder both WATCHES
   * its `Misc` events to discover requests (via {@link SignetRequestFeed}) and
   * posts its responses here — one contract for both directions.
   */
  signetContractAddress: string;
  /** Durable resume floor for the event feed (persist across restarts). */
  fromEventId?: number;
  mpcRootKey: string;
  pollIntervalMs?: number;
  wsPort?: number;

  /**
   * responderWalletSeed is the seed of midnight wallet from which responses are to be done.
   * Defaults to genesis account seed.
   */
  responderWalletSeed?: string;
}

/** The responder's live wallet: its key material plus a started-and-synced facade. */
export interface ResponderWallet {
  keys: AccountKeys;
  walletFacade: WalletFacade;
}

/**
 * The joined signet contract handle — midnight-js's found-contract shape typed
 * to the generated contract, so `callTx.postSignatureResponse(...)` and
 * `callTx.postRespondBidirectional(...)` carry the real circuit signatures.
 */
type DeployedSignetContract = FoundContract<
  SignetContract<SignetContractPrivateState>
>;

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

/** Public half of the responder's Jubjub keypair (signet-midnight's schnorr). */
type JubjubPoint = JubjubKeypair['pk'];

/**
 * Upper bound on a single signet contract write (proof + submit + finalize).
 * Long by design — a real attestation legitimately takes tens of seconds; this
 * only trips when a `callTx` is genuinely wedged, turning a forever-hang into a
 * retryable failure.
 */
const WRITE_TIMEOUT_MS = 120_000;

export class MidnightMonitor {
  private config: MidnightMonitorConfig;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private polling = false;

  private publicDataProvider: PublicDataProvider | null = null;

  // The event-observation request feed: watches the ONE signet contract's
  // events, resolves each to an authenticated request read from the caller's
  // own ledger, and dedupes by request id. Built in initialize().
  private feed: SignetRequestFeed | null = null;

  // The responder wallet and the joined signet contract are both
  // constructed lazily on first access and memoized (loaded once). The cached
  // promise is cleared if construction rejects, so a later call can retry.
  private responderWalletPromise?: Promise<ResponderWallet>;
  private responderContractPromise?: Promise<DeployedSignetContract>;

  private jubjubSk: bigint = 0n;
  private jubjubPk: JubjubPoint | null = null;

  // Single-writer serialization for ALL signet contract writes. The joined
  // contract shares one wallet + single-writer LevelDB private-state store, and
  // two concurrent callTx.* invocations deadlock it (see the poll-loop note in
  // start()). postSignatureResponse and postRespondBidirectional are driven by
  // two INDEPENDENT loops (MidnightMonitor's poll and ChainSignatureServer's tx
  // monitor), so their per-loop re-entrancy guards don't cover cross-loop
  // overlap. This chain forces every write to queue behind the previous one.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(config: MidnightMonitorConfig) {
    this.config = {
      pollIntervalMs: 5000,
      wsPort: 3030,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    console.log('MidnightMonitor: Initializing (generic signet monitor)...');

    const rootKeyBytes = new Uint8Array(
      Buffer.from(this.config.mpcRootKey.replace('0x', ''), 'hex')
    );
    const { sk, pk } = deriveJubjubKeypair(rootKeyBytes);
    this.jubjubSk = sk;
    this.jubjubPk = pk;
    console.log('MidnightMonitor: Jubjub keypair derived');
    console.log(
      `MidnightMonitor: Jubjub pk hash = ${Buffer.from(hashJubjubPoint(pk)).toString('hex')}`
    );

    this.publicDataProvider = indexerPublicDataProvider({
      queryURL: this.config.indexerUrl,
      subscriptionURL: this.config.indexerWsUrl,
    });

    // One feed over the central signet contract's events — no requester list.
    // The indexer provider is both the event source and the state source the
    // resolver reads caller ledgers through.
    this.feed = new SignetRequestFeed({
      signetContractAddress: this.config.signetContractAddress,
      source: this.publicDataProvider,
      fromEventId: this.config.fromEventId,
    });

    console.log(
      `MidnightMonitor: watching signet contract events at ${this.config.signetContractAddress}`
    );
    console.log('MidnightMonitor: Initialized (no compiled contract needed)');
  }

  // ---- Polling ----

  async start(handlers: {
    onSigningRequest: (request: MidnightSigningRequest) => Promise<void>;
  }): Promise<void> {
    console.log('MidnightMonitor: Starting polling...');
    console.log(`  Indexer: ${this.config.indexerUrl}`);
    console.log(
      `  Signet contract (events): ${this.config.signetContractAddress}`
    );

    this.pollIntervalId = setInterval(async () => {
      // Non-re-entrant: wallet construction/sync and contract writes can take
      // several seconds — longer than the poll interval. Skip a tick while the
      // previous one is still running, or overlapping polls would issue
      // concurrent writes to the single-writer LevelDB private-state store and
      // deadlock on its lock (LEVEL_LOCKED).
      if (this.polling) return;
      this.polling = true;
      try {
        await this.fetchAndProcessRequests(handlers.onSigningRequest);
      } catch (error) {
        console.error('MidnightMonitor: Poll error:', error);
      } finally {
        this.polling = false;
      }
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }

    // Tear down the responder wallet facade — but only if it was ever
    // constructed (lazy: an untouched monitor has no facade to stop).
    if (this.responderWalletPromise) {
      try {
        const { walletFacade } = await this.responderWalletPromise;
        await walletFacade.stop().catch(() => {});
      } catch {
        // Wallet construction failed earlier; nothing to stop.
      }
      this.responderWalletPromise = undefined;
      this.responderContractPromise = undefined;
    }

    console.log('MidnightMonitor: Stopped');
  }

  // ---- Responder wallet + signet contract (lazy) ----

  /** The Midnight network endpoints this responder runs against. */
  private get nodeConfig(): MidnightNodeConfig {
    return {
      networkId: this.config.networkId,
      indexerUrl: this.config.indexerUrl,
      indexerWsUrl: this.config.indexerWsUrl,
      nodeUrl: this.config.nodeUrl,
      proofServerUrl: this.config.proofServerUrl,
    };
  }

  /**
   * The responder's started-and-synced wallet. Constructed on first access and
   * memoized — later calls reuse the same instance. Torn down by {@link stop}.
   */
  async responderWallet(): Promise<ResponderWallet> {
    if (!this.responderWalletPromise) {
      this.responderWalletPromise = this.buildResponderWallet().catch(
        (error) => {
          this.responderWalletPromise = undefined; // allow a later retry
          throw error;
        }
      );
    }
    return this.responderWalletPromise;
  }

  private async buildResponderWallet(): Promise<ResponderWallet> {
    const seed = this.config.responderWalletSeed;
    if (!seed) {
      throw new Error(
        'MidnightMonitor: responderWalletSeed is required to construct the responder wallet.'
      );
    }
    console.log(
      'MidnightMonitor: constructing responder wallet (derive keys -> start facade -> sync)...'
    );
    const keys = deriveAccountKeys(seed, this.config.networkId);
    const walletFacade = await initialiseWalletFacade(keys, this.nodeConfig);
    await walletFacade.start(keys.shieldedSecretKeys, keys.dustSecretKey);
    await walletFacade.waitForSyncedState();
    console.log('MidnightMonitor: responder wallet synced');
    return { keys, walletFacade };
  }

  /**
   * The joined signet contract, built on first access and memoized (depends on
   * {@link responderWallet}). Its `callTx.postSignatureResponse` /
   * `callTx.postRespondBidirectional` are the responder's on-chain write paths.
   */
  async responderContract(): Promise<DeployedSignetContract> {
    if (!this.responderContractPromise) {
      this.responderContractPromise = this.buildResponderContract().catch(
        (error) => {
          this.responderContractPromise = undefined; // allow a later retry
          throw error;
        }
      );
    }
    return this.responderContractPromise;
  }

  private async buildResponderContract(): Promise<DeployedSignetContract> {
    const contractAddress = this.config.signetContractAddress;
    if (!contractAddress) {
      throw new Error(
        'MidnightMonitor: signetContractAddress is required to join the signet contract.'
      );
    }
    const { keys, walletFacade } = await this.responderWallet();
    // midnight-js reads a process-global network id — set it before building
    // providers / joining the contract.
    setNetworkId(this.config.networkId);
    const providers = buildSignetContractProviders(
      walletFacade,
      keys,
      this.nodeConfig
    );
    console.log(
      `MidnightMonitor: joining signet contract at ${contractAddress}...`
    );
    return findDeployedContract(providers, {
      contractAddress,
      compiledContract: signetContractCompiledContract,
      privateStateId: SIGNET_CONTRACT_PRIVATE_STATE_ID,
      initialPrivateState: createSignetContractPrivateState(),
    });
  }

  /**
   * Serialize an on-chain write behind every prior one. The joined signet
   * contract shares a single wallet + LevelDB private-state store, so concurrent
   * `callTx.*` calls deadlock; chaining forces them to run one at a time.
   */
  private serializeWrite<T>(post: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(post, post);
    // Keep the chain alive past a rejection so one failed write doesn't wedge
    // every subsequent write, and swallow the tail rejection (the real error is
    // still delivered to the caller via `result`).
    this.writeChain = result.catch(() => {});
    return result;
  }

  /**
   * Run one on-chain post and log how long it took (proof generation +
   * submission + finalization) — basic latency benchmarking of the signet
   * contract write paths. Logs on failure too, so timeouts are measurable.
   *
   * Bounded by {@link WRITE_TIMEOUT_MS}: a genuinely wedged `callTx` (e.g. a
   * submission that never lands) rejects instead of hanging forever, so the
   * request is marked failed and retried on the next poll rather than silently
   * blocking the write chain. The timeout is deliberately long — a real
   * attestation proof + submit legitimately takes tens of seconds.
   */
  private async timedPost<T>(
    label: string,
    post: () => Promise<T>
  ): Promise<T> {
    console.log(`MidnightMonitor: [timing] ${label} started...`);
    const startedAt = performance.now();
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(`${label} timed out after ${WRITE_TIMEOUT_MS / 1000}s`)
            ),
          WRITE_TIMEOUT_MS
        );
      });
      const result = await Promise.race([post(), timeout]);
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      console.log(`MidnightMonitor: [timing] ${label} took ${seconds}s`);
      return result;
    } catch (error) {
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `MidnightMonitor: [timing] ${label} FAILED after ${seconds}s`
      );
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Post an MPC signature response (the canonical `{ bigR, s, recoveryId }`
   * record) on-chain via the joined signet contract. Unauthenticated by
   * necessity — verified off-chain. Lazily constructs the wallet + contract on
   * first call.
   */
  async postSignatureResponse(
    requestId: Uint8Array,
    signatureResponse: SignatureResponse
  ) {
    // Resolve the contract OUTSIDE the timer: the first call builds the
    // wallet + joins the contract (separately logged), and that one-off cost
    // would skew the post benchmark.
    const contract = await this.responderContract();
    return this.serializeWrite(() =>
      this.timedPost(
        `postSignatureResponse(0x${Buffer.from(requestId).toString('hex')})`,
        () =>
          contract.callTx.postSignatureResponse(requestId, signatureResponse)
      )
    );
  }

  /**
   * Post the MPC's respond-bidirectional attestation on-chain via the joined
   * signet contract. The Schnorr signature over
   * (requestId, hash(serializedOutput, outputLen)) is verified in-circuit
   * against the contract's sealed MPC key at post time, so only a genuine
   * attestation lands. Lazily constructs the wallet + contract on first call.
   */
  async postRespondBidirectional(
    requestId: Uint8Array,
    respondBidirectional: RespondBidirectional
  ) {
    const contract = await this.responderContract();
    return this.serializeWrite(() =>
      this.timedPost(
        `postRespondBidirectional(0x${Buffer.from(requestId).toString('hex')})`,
        () =>
          contract.callTx.postRespondBidirectional(
            requestId,
            respondBidirectional
          )
      )
    );
  }

  private async fetchAndProcessRequests(
    onSigningRequest: (request: MidnightSigningRequest) => Promise<void>
  ): Promise<void> {
    if (!this.feed) {
      console.error('MidnightMonitor: not initialized');
      return;
    }

    // Discover by event: the feed reads the signet contract's notifications,
    // resolves each to an AUTHENTICATED request from the named caller's own
    // ledger (forged / not-yet-indexed / non-member events are dropped and
    // retried), and dedupes by request id. No requester contract list.
    let resolved: ResolvedSignetRequest[];
    try {
      resolved = await this.feed.poll();
    } catch (error) {
      console.error('MidnightMonitor: Error polling signet events:', error);
      return;
    }

    for (const {
      callerAddress,
      requestId,
      request: signetRequest,
    } of resolved) {
      console.log(
        `MidnightMonitor: New request ${requestId} from contract ${callerAddress}`
      );
      const request = this.toSigningRequest(
        callerAddress,
        requestId,
        signetRequest
      );
      console.log(
        `  Selector: ${request.calldata.selector ?? '(no calldata)'}`
      );
      console.log(
        `  Words: ${request.calldata.words.map((word) => `0x${bytesToHex(word)}`).join(', ')}`
      );

      try {
        await onSigningRequest(request);
      } catch (error) {
        console.error(`MidnightMonitor: Error processing ${requestId}:`, error);
        // Re-arm for redelivery on the next poll — mirrors the old
        // delete-from-processed retry, now driven by the feed's dedupe set.
        this.feed.forget(requestId);
      }
    }
  }

  /**
   * Adapt an authenticated {@link SignBidirectionalRequest} (read from the
   * requester contract `predecessor`'s ledger) into the flat
   * {@link MidnightSigningRequest} the signing pipeline consumes. `predecessor`
   * is the epsilon-derivation root — the contract whose authenticated state the
   * feed actually read, never a value taken from the event on faith.
   */
  private toSigningRequest(
    predecessor: string,
    requestId: RequestIdHex,
    signetRequest: SignBidirectionalRequest
  ): MidnightSigningRequest {
    const { txParams } = signetRequest;
    // The flat logging view of the calldata: the real (used) words.
    // Re-assembly itself happens in the shared builder.
    const words = txParams.calldata.is_some
      ? txParams.calldata.value.words.slice(
          0,
          Number(txParams.calldata.value.noWords)
        )
      : [];

    return {
      predecessor,
      requestId: new Uint8Array(Buffer.from(requestId, 'hex')),
      nonce: signetRequest.requestNonce,
      evmParams: {
        evmTo: txParams.to,
        evmChainId: txParams.chainId,
        evmNonce: txParams.nonce,
        evmGasLimit: txParams.gasLimit,
        evmMaxFee: txParams.maxFeePerGas,
        evmPriorityFee: txParams.maxPriorityFeePerGas,
        evmValue: txParams.value,
      },
      calldata: {
        selector: txParams.calldata.is_some
          ? `0x${bytesToHex(txParams.calldata.value.selector)}`
          : undefined,
        words,
      },
      caip2Id: decodePaddedString(signetRequest.caip2Id),
      keyVersion: Number(signetRequest.keyVersion),
      path: signetRequest.path,
      algo: decodePaddedString(signetRequest.algo),
      dest: decodePaddedString(signetRequest.dest),
      params: signetRequest.params,
      outputDeserializationSchema: signetRequest.outputDeserializationSchema,
      respondSerializationSchema: signetRequest.respondSerializationSchema,
      signetRequest,
    };
  }

  // ---- Transaction building & signing ----

  buildSerializedTransaction(request: MidnightSigningRequest): Uint8Array {
    // Reuse signet-midnight's canonical builder (the same package the request
    // reader comes from) rather than a vendored RLP re-implementation, so the
    // unsigned transaction is assembled exactly as clients verify it.
    const unsignedTx = signBidirectionalRequestToUnsignedEVMTransaction(
      request.signetRequest
    );
    return ethers.getBytes(unsignedTx.unsignedSerialized);
  }

  async signAndBroadcastResponse(
    requestId: Uint8Array,
    evmReturnData: Uint8Array
  ): Promise<SignedResponse> {
    const jubjubPk = this.jubjubPk;
    if (!jubjubPk) {
      throw new Error('MidnightMonitor: not initialized (no Jubjub keypair)');
    }
    const requestIdHex = Buffer.from(requestId).toString('hex');
    console.log(
      `MidnightMonitor: Signing respond-bidirectional attestation for ${requestIdHex}`
    );

    if (evmReturnData.length > SERIALIZED_OUTPUT_BYTES) {
      throw new Error(
        `MidnightMonitor: execution output is ${evmReturnData.length} bytes — ` +
          `does not fit the ${SERIALIZED_OUTPUT_BYTES}-byte serializedOutput field`
      );
    }
    const serializedOutput = new Uint8Array(SERIALIZED_OUTPUT_BYTES);
    serializedOutput.set(evmReturnData);
    const outputLen = BigInt(evmReturnData.length);

    // Sign (requestId, hash(serializedOutput, outputLen)) with the same
    // compiled circuits the signet contract verifies against —
    // signetAttestationMessage + the Schnorr challenge — so the attestation
    // passes postRespondBidirectional's in-circuit check.
    const msg = signetCircuits.signetAttestationMessage(
      requestId,
      serializedOutput,
      outputLen
    );
    const sig = schnorrSign(this.jubjubSk, msg, (ax, ay, px, py, m) =>
      signetCircuits.schnorrChallenge(ax, ay, px, py, m)
    );

    const response: SignedResponse = {
      requestId: requestIdHex,
      serializedOutput: Buffer.from(serializedOutput).toString('hex'),
      outputLen: evmReturnData.length,
      pk: { x: jubjubPk.x.toString(), y: jubjubPk.y.toString() },
      announcement: {
        x: sig.announcement.x.toString(),
        y: sig.announcement.y.toString(),
      },
      response: sig.response.toString(),
    };

    // Post the attestation on-chain to the signet contract. There is no
    // push/websocket channel — the contract's respondBidirectionalIndex is
    // the delivery surface; the client polls it and presents the record to
    // claimDeposit().
    await this.postRespondBidirectional(requestId, {
      serializedOutput,
      outputLen,
      pk: jubjubPk,
      announcement: sig.announcement,
      response: sig.response,
    });
    console.log(
      `MidnightMonitor: posted respond-bidirectional attestation for ${requestIdHex}`
    );

    return response;
  }

  /**
   * Post the MPC's EVM signature for a request on-chain to the
   * signet contract. The input is the fully-signed EVM
   * transaction the MPC produced; we extract its ECDSA signature as the
   * canonical `{ bigR, s, recoveryId }` record — the payload a poller
   * recovers the signer from — and submit it via the joined contract's
   * `postSignatureResponse` circuit.
   */
  async broadcastSignedTransaction(data: {
    requestId: string;
    signedTransaction: string;
    txHash: string;
  }): Promise<void> {
    // The signature covers the transaction's unsigned hash, which is exactly
    // what a poller recovers the signer from (see signet-midnight's
    // recoverSignatureResponseSigner). The record encoder recovers
    // bigR.y by decompressing (r, yParity) on the curve.
    const sig = ethers.Transaction.from(data.signedTransaction).signature;
    if (!sig) {
      throw new Error(
        `broadcastSignedTransaction: transaction for ${data.requestId} carries no signature`
      );
    }
    const signatureResponse = signatureToSignatureResponse(sig);

    const requestId = ethers.getBytes(data.requestId);

    console.log(
      `MidnightMonitor: posting signature response for ${data.requestId} (tx ${data.txHash})...`
    );
    await this.postSignatureResponse(requestId, signatureResponse);
    console.log(
      `MidnightMonitor: posted signature response for ${data.requestId}`
    );
  }

  getJubjubPk(): JubjubPoint | null {
    return this.jubjubPk;
  }

  getPathHex(request: MidnightSigningRequest): string {
    return Buffer.from(request.path).toString('hex');
  }

  getPath(request: MidnightSigningRequest): string {
    return Buffer.from(request.path).toString('utf8').replace(/\0/g, '');
  }

  static fromServerConfig(config: ServerConfig): MidnightMonitor | null {
    // The signet contract address is now the sole requirement: the responder
    // discovers requesters by watching its events, so no requester list is
    // needed (or accepted).
    if (!config.midnightIndexerUrl || !config.midnightSignetContractAddress) {
      return null;
    }

    return new MidnightMonitor({
      networkId: (config.midnightNetworkId ?? 'undeployed') as NetworkId,
      indexerUrl: config.midnightIndexerUrl,
      indexerWsUrl:
        config.midnightIndexerWsUrl ||
        config.midnightIndexerUrl.replace('http', 'ws'),
      nodeUrl: config.midnightNodeUrl || 'http://localhost:9944',
      proofServerUrl: config.midnightProofServerUrl || 'http://localhost:6300',
      signetContractAddress: config.midnightSignetContractAddress,
      mpcRootKey: config.mpcRootKey,
      responderWalletSeed:
        config.midnightWalletSeed ||
        '0000000000000000000000000000000000000000000000000000000000000001',
    });
  }
}

function decodePaddedString(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i;
      break;
    }
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}
