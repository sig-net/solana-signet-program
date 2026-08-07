/**
 * MidnightMonitor - Generic signet monitor for any Midnight contract.
 *
 * Configured with the signet contract address alone: requester contracts are
 * discovered from that contract's emitted notification events.
 *
 * Flow:
 * 1. Poll the signet contract's notification events (SignetRequestFeed)
 * 2. Enumerate each notified caller's request map and serve every
 *    SignBidirectionalEvent not served before
 * 3. Build ABI calldata + RLP transaction off-chain
 * 4. Post the MPC's ECDSA signature to the signet contract (respond)
 * 5. Once the EVM tx confirms, sign the attestation digest with the response
 *    key derived for the requesting contract and post the
 *    RespondBidirectionalEvent (respondBidirectional), which the client
 *    verifies before calling claimDeposit()
 */

import { Buffer } from 'buffer';
import { ethers } from 'ethers';
import type { ServerConfig } from '../types';

import type { SigningRequest } from './midnight/signet-request-types';

import {
  bytesToHex,
  deriveMidnightResponseSecretKey,
  formatSecp256k1PublicKey,
  signetEventSourceFromPublicDataProvider,
  SignetRequestFeed,
  signBidirectionalEventToUnsignedEvmTransaction,
  MPCDestination,
  MPCSignatureAlgorithm,
  type ResolvedSignetRequest,
  type RequestIdHex,
  type SignBidirectionalEvent,
  type SignatureRespondedEvent,
  type RespondBidirectionalEvent,
} from '@sig-net/midnight';
// The posting-side helpers: the responder is the MPC's test double, so it
// signs and encodes through the SDK's minting surface.
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
  signatureToSignatureRespondedEvent,
} from '@sig-net/midnight/testing';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import {
  findDeployedContract,
  type FoundContract,
} from '@midnight-ntwrk/midnight-js/contracts';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import {
  SIGNET_CONTRACT_PRIVATE_STATE_ID,
  createSignetContractPrivateState,
  type Contract as SignetContract,
  type SignetContractPrivateState,
} from '@sig-net/midnight-contract';

import {
  deriveAccountKeys,
  initialiseWalletFacade,
  type AccountKeys,
} from './midnight/wallet';
import type { NetworkId } from './midnight/network-id';
import type { MidnightNodeConfig } from './midnight/midnight-node-config';
import {
  buildSignetContractProviders,
  makeSignetContractCompiledContract,
  packagedManagedPath,
} from './midnight/signet-contract-providers';

// ---- Types ----

export interface MidnightSigningRequest extends SigningRequest {
  /**
   * The on-ledger event record the tx builder consumes. The flat
   * `SigningRequest` fields are its decoded view, used for key derivation,
   * signing and logging.
   */
  signetRequest: SignBidirectionalEvent;
}

export interface SignedResponse {
  requestId: string;
  /** The exact unpadded serialised output the attestation commits to, as hex. */
  serializedOutput: string;
  /** The signed attestation digest keccak256(requestId || output), as hex. */
  attestationDigest: string;
  /** Signature nonce point R.x as hex (32 big-endian bytes, ledger form). */
  bigRx: string;
  /** Signature nonce point R.y as hex (32 big-endian bytes, ledger form). */
  bigRy: string;
  /** ECDSA signature scalar s as hex (32 big-endian bytes, ledger form). */
  s: string;
  /** Recovery id (parity of R.y). */
  recoveryId: number;
}

export interface MidnightMonitorConfig {
  networkId: NetworkId;
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  proofServerUrl: string;
  /**
   * Address of the deployed signet contract: the responder polls its events
   * to discover requests and posts its responses to it.
   */
  signetContractAddress: string;
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

/** The joined signet contract handle, typed to the generated contract. */
type DeployedSignetContract = FoundContract<
  SignetContract<SignetContractPrivateState>
>;

/**
 * Upper bound on a single signet contract write (proof + submit + finalize).
 * Long because a real attestation takes tens of seconds: it should only trip
 * on a wedged `callTx`, turning a forever-hang into a retryable failure.
 */
const WRITE_TIMEOUT_MS = 120_000;

export class MidnightMonitor {
  private config: MidnightMonitorConfig;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private polling = false;

  private publicDataProvider: PublicDataProvider | null = null;

  // Built in initialize().
  private feed: SignetRequestFeed | null = null;

  private responderWalletPromise?: Promise<ResponderWallet>;
  private responderContractPromise?: Promise<DeployedSignetContract>;

  // Root of the per-contract response key derivation.
  private mpcRootKeyBytes: Uint8Array | null = null;

  // Serializes ALL signet contract writes. Two concurrent callTx.* calls
  // deadlock the shared single-writer LevelDB private-state store, and the two
  // write paths are driven by independent loops (this poll and
  // ChainSignatureServer's tx monitor), so per-loop re-entrancy guards cannot
  // catch the overlap.
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

    this.mpcRootKeyBytes = new Uint8Array(
      Buffer.from(this.config.mpcRootKey.replace('0x', ''), 'hex')
    );
    console.log(
      'MidnightMonitor: respond-bidirectional response keys are derived per' +
        ' requesting contract (sender-scoped, "midnight response key" path)'
    );

    this.publicDataProvider = indexerPublicDataProvider({
      queryURL: this.config.indexerUrl,
      subscriptionURL: this.config.indexerWsUrl,
    });

    // The indexer provider serves both roles: the event source for discovery
    // and the state source for the caller-ledger reads.
    this.feed = new SignetRequestFeed({
      signetContractAddress: this.config.signetContractAddress,
      source: this.publicDataProvider,
      eventSource: signetEventSourceFromPublicDataProvider(
        this.publicDataProvider
      ),
    });

    console.log(
      `MidnightMonitor: polling signet contract events at ${this.config.signetContractAddress}`
    );
    console.log('MidnightMonitor: Initialized');
  }

  // ---- Polling ----

  async start(handlers: {
    onSigningRequest: (request: MidnightSigningRequest) => Promise<void>;
  }): Promise<void> {
    console.log('MidnightMonitor: Starting polling...');
    console.log(`  Indexer: ${this.config.indexerUrl}`);
    console.log(
      `  Signet contract (notification registry): ${this.config.signetContractAddress}`
    );

    this.pollIntervalId = setInterval(async () => {
      // A tick can outlast the poll interval (wallet sync, contract writes).
      // Overlapping ticks would write concurrently to the single-writer
      // private-state store and deadlock on its lock (LEVEL_LOCKED).
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

    if (this.responderWalletPromise) {
      try {
        const { walletFacade } = await this.responderWalletPromise;
        await walletFacade.stop().catch(() => {});
      } catch {
        // Wallet construction failed earlier, so there is nothing to stop.
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
   * The responder's started-and-synced wallet, built on first access and
   * memoized. Torn down by {@link stop}.
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
   * The joined signet contract, built on first access and memoized. Its
   * `callTx` circuits are the responder's on-chain write paths.
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
    // midnight-js reads a process-global network id, so set it before
    // building providers and joining the contract.
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
      compiledContract: makeSignetContractCompiledContract(packagedManagedPath),
      privateStateId: SIGNET_CONTRACT_PRIVATE_STATE_ID,
      initialPrivateState: createSignetContractPrivateState(),
    });
  }

  /**
   * Queue an on-chain write behind every prior one (see {@link writeChain}).
   *
   * The chain advances on the RAW post promise, never on the timeout-raced
   * result the caller sees: a timed-out write is still in flight against the
   * single-writer store, so releasing the next write early would recreate the
   * deadlock. The caller still gets the bounded promise and can retry.
   */
  private serializeWrite<T>(label: string, post: () => Promise<T>): Promise<T> {
    const started = this.writeChain.then(
      () => this.timedPost(label, post),
      () => this.timedPost(label, post)
    );
    // Keep the chain alive past a rejection so one failed write doesn't wedge
    // the rest. The real error still reaches the caller via the raced result.
    this.writeChain = started.then(({ raw }) => raw).catch(() => {});
    return started.then(({ result }) => result);
  }

  /**
   * Run one on-chain post and log how long it took, for latency benchmarking.
   *
   * `result` is bounded by {@link WRITE_TIMEOUT_MS} so a wedged `callTx` fails
   * the request instead of hanging forever. `raw` is the post promise
   * untouched by the timeout: the write chain must advance on it, never on
   * `result` (see {@link serializeWrite}).
   */
  private timedPost<T>(
    label: string,
    post: () => Promise<T>
  ): { raw: Promise<T>; result: Promise<T> } {
    console.log(`MidnightMonitor: [timing] ${label} started...`);
    const startedAt = performance.now();
    const elapsedSeconds = () =>
      ((performance.now() - startedAt) / 1000).toFixed(1);

    const raw = post();
    void raw.then(
      () => {
        console.log(
          `MidnightMonitor: [timing] ${label} took ${elapsedSeconds()}s`
        );
      },
      () => {
        console.log(
          `MidnightMonitor: [timing] ${label} FAILED after ${elapsedSeconds()}s`
        );
      }
    );

    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        console.log(
          `MidnightMonitor: [timing] ${label} still running after ${elapsedSeconds()}s; ` +
            'reporting a timeout to the caller while the write chain waits for it to settle'
        );
        reject(
          new Error(`${label} timed out after ${WRITE_TIMEOUT_MS / 1000}s`)
        );
      }, WRITE_TIMEOUT_MS);
    });
    // `raw` can still reject after the race resolves. The logging handler
    // above and the write chain both observe it, so it never goes unhandled.
    const result = Promise.race([raw, timeout]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
    return { raw, result };
  }

  /** Post an MPC signature response on-chain via the joined signet contract. */
  async postSignatureResponse(
    requestId: Uint8Array,
    signatureResponse: SignatureRespondedEvent
  ) {
    // Resolve the contract outside the timer: the first call builds the wallet
    // and joins the contract, whose one-off cost would skew the benchmark.
    const contract = await this.responderContract();
    return this.serializeWrite(
      `respond(0x${Buffer.from(requestId).toString('hex')})`,
      () => contract.callTx.respond(requestId, signatureResponse)
    );
  }

  /**
   * Post the MPC's respond-bidirectional response on-chain via the joined
   * signet contract.
   */
  async postRespondBidirectional(
    requestId: Uint8Array,
    respondBidirectional: RespondBidirectionalEvent
  ) {
    const contract = await this.responderContract();
    return this.serializeWrite(
      `respondBidirectional(0x${Buffer.from(requestId).toString('hex')})`,
      () =>
        contract.callTx.respondBidirectional(requestId, respondBidirectional)
    );
  }

  private async fetchAndProcessRequests(
    onSigningRequest: (request: MidnightSigningRequest) => Promise<void>
  ): Promise<void> {
    if (!this.feed) {
      console.error('MidnightMonitor: not initialized');
      return;
    }

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
        // Drop the id so the next poll rediscovers and retries the request.
        this.feed.forget(requestId);
      }
    }
  }

  /**
   * Adapt a {@link SignBidirectionalEvent} into the flat
   * {@link MidnightSigningRequest} the signing pipeline consumes.
   *
   * `predecessor` is the epsilon-derivation root, so it must be the contract
   * whose state the feed actually read, never a value the notification claims.
   */
  private toSigningRequest(
    predecessor: string,
    requestId: RequestIdHex,
    signetRequest: SignBidirectionalEvent
  ): MidnightSigningRequest {
    const { txParams } = signetRequest;
    // The used words only, for logging. Re-assembly happens in the builder.
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
      // Compact enums arrive as 0-based variant indices, labelled for logging.
      algo:
        signetRequest.algo === MPCSignatureAlgorithm.ecdsa
          ? 'ecdsa'
          : `unknown(${signetRequest.algo})`,
      dest:
        signetRequest.dest === MPCDestination.unused
          ? 'unused'
          : `unknown(${signetRequest.dest})`,
      params: signetRequest.params,
      outputDeserializationSchema: signetRequest.outputDeserializationSchema,
      respondSerializationSchema: signetRequest.respondSerializationSchema,
      signetRequest,
    };
  }

  // ---- Transaction building & signing ----

  buildSerializedTransaction(request: MidnightSigningRequest): Uint8Array {
    const unsignedTx = signBidirectionalEventToUnsignedEvmTransaction(
      request.signetRequest
    );
    return ethers.getBytes(unsignedTx.unsignedSerialized);
  }

  /**
   * Sign and post the respond-bidirectional response for a completed or failed
   * remote execution. The response key is derived from
   * `senderContractAddress`, mirroring the MPC's sender-scoped
   * `tx.epsilon(path)` derivation.
   */
  async signAndBroadcastResponse(
    requestId: Uint8Array,
    evmReturnData: Uint8Array,
    senderContractAddress: string
  ): Promise<SignedResponse> {
    const mpcRootKeyBytes = this.mpcRootKeyBytes;
    if (!mpcRootKeyBytes) {
      throw new Error('MidnightMonitor: not initialized (no root key)');
    }
    const responseSecretKey = deriveMidnightResponseSecretKey(
      mpcRootKeyBytes,
      senderContractAddress
    );
    const requestIdHex = Buffer.from(requestId).toString('hex');
    console.log(
      `MidnightMonitor: Signing respond-bidirectional response for ${requestIdHex}` +
        ` (sender ${senderContractAddress}, response key ${formatSecp256k1PublicKey(
          secp256k1PublicKeyOf(responseSecretKey)
        )})`
    );

    // The attestation commits to the output at its exact unpadded length: no
    // padding, no fixed field width. The output itself travels off-chain.
    const serializedOutput = evmReturnData;

    // keccak256(requestId || output), matching the circuit clients verify
    // against in-circuit (verifyRespondBidirectionalEvent). A mismatch here
    // makes every response fail at claim time.
    const attestationDigest = calculateSignetAttestationDigest(
      requestId,
      serializedOutput
    );
    const sig = signAttestationDigest(attestationDigest, responseSecretKey);
    const signature = ecdsaSignatureToMpcSignature(sig);
    // Only the signature goes on-chain: the verifier recomputes the digest.
    const respondBidirectionalEvent: RespondBidirectionalEvent = { signature };

    const response: SignedResponse = {
      requestId: requestIdHex,
      serializedOutput: Buffer.from(serializedOutput).toString('hex'),
      attestationDigest: Buffer.from(attestationDigest).toString('hex'),
      bigRx: Buffer.from(signature.bigR.x).toString('hex'),
      bigRy: Buffer.from(signature.bigR.y).toString('hex'),
      s: Buffer.from(signature.s).toString('hex'),
      recoveryId: sig.recoveryId,
    };

    await this.postRespondBidirectional(requestId, respondBidirectionalEvent);
    console.log(
      `MidnightMonitor: posted respond-bidirectional response for ${requestIdHex}`
    );

    return response;
  }

  /**
   * Post the MPC's EVM signature for a request to the signet contract, taking
   * it from the fully-signed transaction the MPC produced.
   */
  async broadcastSignedTransaction(data: {
    requestId: string;
    signedTransaction: string;
    txHash: string;
  }): Promise<void> {
    // The signature covers the transaction's unsigned hash, which is what a
    // poller recovers the signer from (recoverSignatureResponseSigner).
    const sig = ethers.Transaction.from(data.signedTransaction).signature;
    if (!sig) {
      throw new Error(
        `broadcastSignedTransaction: transaction for ${data.requestId} carries no signature`
      );
    }
    const signatureResponse = signatureToSignatureRespondedEvent(sig);

    const requestId = ethers.getBytes(data.requestId);

    console.log(
      `MidnightMonitor: posting signature response for ${data.requestId} (tx ${data.txHash})...`
    );
    await this.postSignatureResponse(requestId, signatureResponse);
    console.log(
      `MidnightMonitor: posted signature response for ${data.requestId}`
    );
  }

  /**
   * The response public key for one requesting contract as uncompressed SEC1
   * hex, which that contract pins via its initialise circuit. Null before
   * {@link initialize}.
   */
  getResponsePublicKey(senderContractAddress: string): string | null {
    return this.mpcRootKeyBytes
      ? formatSecp256k1PublicKey(
          secp256k1PublicKeyOf(
            deriveMidnightResponseSecretKey(
              this.mpcRootKeyBytes,
              senderContractAddress
            )
          )
        )
      : null;
  }

  /**
   * The derivation-string rendering of a request's `path: Bytes<32>`:
   * lowercase hex of the FULL 32 bytes, verbatim, no 0x prefix. Mirrors the
   * real MPC's rendering (sig-net/mpc chain-midnight convert.rs), which
   * never trims: `0xab..00` and `0xab..` must derive different keys.
   */
  getPathHex(request: MidnightSigningRequest): string {
    return Buffer.from(request.path).toString('hex');
  }

  static fromServerConfig(config: ServerConfig): MidnightMonitor | null {
    if (!config.midnightIndexerUrl || !config.midnightSignetContractAddress) {
      // A half-set Midnight config is almost certainly a mistake, so name the
      // missing variable instead of silently never starting the leg.
      if (config.midnightSignetContractAddress && !config.midnightIndexerUrl) {
        console.warn(
          'MidnightMonitor: MIDNIGHT_SIGNET_CONTRACT_ADDRESS is set but ' +
            'MIDNIGHT_INDEXER_URL is missing. The Midnight leg will NOT start. ' +
            'Set MIDNIGHT_INDEXER_URL to enable it.'
        );
      } else if (
        config.midnightIndexerUrl &&
        !config.midnightSignetContractAddress
      ) {
        console.warn(
          'MidnightMonitor: MIDNIGHT_INDEXER_URL is set but ' +
            'MIDNIGHT_SIGNET_CONTRACT_ADDRESS is missing. The Midnight leg ' +
            'will NOT start. Set MIDNIGHT_SIGNET_CONTRACT_ADDRESS to enable it.'
        );
      }
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
