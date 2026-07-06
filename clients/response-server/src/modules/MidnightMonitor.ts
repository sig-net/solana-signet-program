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
 * 6. After the EVM tx confirms, Schnorr-signs (requestId, hash(outputData)) and
 *    posts the attestation on-chain (postRemoteExecutionResponse) — verified
 *    in-circuit against the sealed MPC key. The USER polls and calls claim().
 */

import { Buffer } from 'buffer';
import { ethers } from 'ethers';
import type { ServerConfig } from '../types';

import { buildTransactionFromRequest } from '../managed/erc20-vault/signet/calldata-builder';
import type { SigningRequest } from '../managed/erc20-vault/signet/types';

// Schnorr signing, the attestation-message circuit, and the Schnorr challenge
// all come from signet-midnight — the SAME compiled circuits the signet
// contract verifies against. Signing here with them is what makes an
// attestation pass postRemoteExecutionResponse's in-circuit check (this is the
// "import from the pure circuits near the contract, don't rebuild" the old
// FIXME called for).
import {
  readSignetRequestsLedgerFromState,
  deriveJubjubKeypair,
  hashJubjubPoint,
  schnorrSign,
  pureCircuits as signetCircuits,
  OUTPUT_DATA_SIZE,
  type SignetRemoteExecutionResponse,
} from "@midnight-erc20-vault/signet-midnight";
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { setNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import { findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js/contracts";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  buildSignetContractProviders,
  signetContractCompiledContract,
  SIGNET_CONTRACT_PRIVATE_STATE_ID,
  createSignetContractPrivateState,
  type Contract as SignetContract,
  type SignetContractPrivateState,
} from "@midnight-erc20-vault/signet-contract";

import { deriveAccountKeys, initialiseWalletFacade, type AccountKeys } from "./midnight/wallet";
import type { NetworkId } from "./midnight/network-id";
import type { MidnightNodeConfig } from "./midnight/midnight-node-config";

// ---- Types ----

export interface MidnightSigningRequest extends SigningRequest {
  erc20Address: string;
  amount: bigint;
}

export interface SignedResponse {
  requestId: string;
  outputData: string;
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
  contractAddresses: string[];
  /** Address of the deployed signet contract the responder posts responses to. */
  signetContractAddress?: string;
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
 * `callTx.postRemoteExecutionResponse(...)` carry the real circuit signatures.
 */
type DeployedSignetContract = FoundContract<
  SignetContract<SignetContractPrivateState>
>;

(globalThis as any).WebSocket = WebSocket;

export class MidnightMonitor {
  private config: MidnightMonitorConfig;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private lastNonces = new Map<string, bigint>();
  private processedRequests = new Set<string>();

  private publicDataProvider: PublicDataProvider | null = null;

  // The responder wallet and the joined signet contract are both
  // constructed lazily on first access and memoized (loaded once). The cached
  // promise is cleared if construction rejects, so a later call can retry.
  private responderWalletPromise?: Promise<ResponderWallet>;
  private responderContractPromise?: Promise<DeployedSignetContract>;

  private jubjubSk: bigint = 0n;
  private jubjubPk: any = null;

  constructor(config: MidnightMonitorConfig) {
    this.config = {
      pollIntervalMs: 5000,
      wsPort: 3030,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    console.log('MidnightMonitor: Initializing (generic signet monitor)...');

    const rootKeyBytes = new Uint8Array(Buffer.from(this.config.mpcRootKey.replace('0x', ''), 'hex'));
    const { sk, pk } = deriveJubjubKeypair(rootKeyBytes);
    this.jubjubSk = sk;
    this.jubjubPk = pk;
    console.log('MidnightMonitor: Jubjub keypair derived');
    console.log(`MidnightMonitor: Jubjub pk hash = ${Buffer.from(hashJubjubPoint(pk)).toString('hex')}`);

    this.publicDataProvider = indexerPublicDataProvider(
      this.config.indexerUrl,
      this.config.indexerWsUrl,
    );

    console.log('MidnightMonitor: Initialized (no compiled contract needed)');
  }

  // ---- Polling ----

  async start(handlers: {
    onSigningRequest: (request: MidnightSigningRequest) => Promise<void>;
  }): Promise<void> {
    console.log('MidnightMonitor: Starting polling...');
    console.log(`  Indexer: ${this.config.indexerUrl}`);
    console.log(`  Contracts: ${this.config.contractAddresses.join(', ')}`);

    this.pollIntervalId = setInterval(async () => {
      try {
        await this.fetchAndProcessRequests(handlers.onSigningRequest);
      } catch (error) {
        console.error('MidnightMonitor: Poll error:', error);
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
      this.responderWalletPromise = this.buildResponderWallet().catch((error) => {
        this.responderWalletPromise = undefined; // allow a later retry
        throw error;
      });
    }
    return this.responderWalletPromise;
  }

  private async buildResponderWallet(): Promise<ResponderWallet> {
    const seed = this.config.responderWalletSeed;
    if (!seed) {
      throw new Error('MidnightMonitor: responderWalletSeed is required to construct the responder wallet.');
    }
    console.log('MidnightMonitor: constructing responder wallet (derive keys -> start facade -> sync)...');
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
   * `callTx.postRemoteExecutionResponse` are the responder's on-chain write paths.
   */
  async responderContract(): Promise<DeployedSignetContract> {
    if (!this.responderContractPromise) {
      this.responderContractPromise = this.buildResponderContract().catch((error) => {
        this.responderContractPromise = undefined; // allow a later retry
        throw error;
      });
    }
    return this.responderContractPromise;
  }

  private async buildResponderContract(): Promise<DeployedSignetContract> {
    const contractAddress = this.config.signetContractAddress;
    if (!contractAddress) {
      throw new Error(
        'MidnightMonitor: signetContractAddress is required to join the signet contract.',
      );
    }
    const { keys, walletFacade } = await this.responderWallet();
    // midnight-js reads a process-global network id — set it before building
    // providers / joining the contract.
    setNetworkId(this.config.networkId);
    const providers = buildSignetContractProviders(walletFacade, keys, this.nodeConfig);
    console.log(`MidnightMonitor: joining signet contract at ${contractAddress}...`);
    return findDeployedContract(providers, {
      contractAddress,
      compiledContract: signetContractCompiledContract,
      privateStateId: SIGNET_CONTRACT_PRIVATE_STATE_ID,
      initialPrivateState: createSignetContractPrivateState(),
    });
  }

  /**
   * Post an MPC signature response (the 65-byte ECDSA signature) on-chain via
   * the joined signet contract. Unauthenticated by necessity — verified
   * off-chain. Lazily constructs the wallet + contract on first call.
   */
  async postSignatureResponse(requestId: Uint8Array, signatureResponse: Uint8Array) {
    const contract = await this.responderContract();
    return contract.callTx.postSignatureResponse(requestId, signatureResponse);
  }

  /**
   * Post the MPC's remote-execution attestation on-chain via the joined signet
   * contract. The Schnorr signature over (requestId, hash(outputData)) is
   * verified in-circuit against the contract's sealed MPC key at post time, so
   * only a genuine attestation lands. Lazily constructs the wallet + contract
   * on first call.
   */
  async postRemoteExecutionResponse(
    requestId: Uint8Array,
    executionResponse: SignetRemoteExecutionResponse,
  ) {
    const contract = await this.responderContract();
    return contract.callTx.postRemoteExecutionResponse(requestId, executionResponse);
  }

  private async fetchAndProcessRequests(
    onSigningRequest: (request: MidnightSigningRequest) => Promise<void>,
  ): Promise<void> {
    if (!this.publicDataProvider) {
      console.error('MidnightMonitor: not initialized');
      return;
    }

    for (const contractAddress of this.config.contractAddresses) {
      try {
        console.debug(`check midnight for signetEVMSignatureRequests at contract address '${contractAddress}'...`);

        const contractState = await this.publicDataProvider.queryContractState(contractAddress);
        if (!contractState?.data) {
          console.warn(`no state data found for contract '${contractAddress}'`);
          continue;
        };
        const { nonce, requestsIndex } = readSignetRequestsLedgerFromState(contractState.data);

        // Cheap change detection: the signet nonce counts requests ever
        // created, so an unchanged value means nothing new since the last
        // fully-processed poll.
        const lastNonce = this.lastNonces.get(contractAddress);
        if (lastNonce !== undefined && nonce <= lastNonce) continue;
        console.log(`MidnightMonitor: nonce ${lastNonce ?? '(none)'} -> ${nonce} on ${contractAddress}`);

        let allProcessed = true;
        for (const [requestId, signetRequest] of requestsIndex.entries()) {
          if (this.processedRequests.has(requestId)) continue;
          console.log(`found request: ${requestId}`);

          const { evmTransaction, calldata, mpcRouting } = signetRequest;
          const argCount = Number(calldata.argCount);
          const args = calldata.args.slice(0, argCount);

          const request: MidnightSigningRequest = {
            predecessor: contractAddress,
            requestId: new Uint8Array(Buffer.from(requestId, 'hex')),
            nonce: signetRequest.requestNonce,
            evmParams: {
              evmTo: evmTransaction.to,
              evmChainId: evmTransaction.chainId,
              evmNonce: evmTransaction.nonce,
              evmGasLimit: evmTransaction.gasLimit,
              evmMaxFee: evmTransaction.maxFeePerGas,
              evmPriorityFee: evmTransaction.maxPriorityFeePerGas,
              evmValue: evmTransaction.value,
            },
            calldata: {
              funcSig: decodePaddedString(calldata.funcSig),
              argCount,
              args,
            },
            caip2Id: decodePaddedString(mpcRouting.caip2Id),
            keyVersion: Number(mpcRouting.keyVersion),
            path: mpcRouting.path,
            algo: decodePaddedString(mpcRouting.algo),
            dest: decodePaddedString(mpcRouting.dest),
            params: mpcRouting.params,
            outputDeserializationSchema: mpcRouting.outputSchema,
            respondSerializationSchema: mpcRouting.respondSchema,
            erc20Address: '0x' + Buffer.from(evmTransaction.to).toString('hex'),
            amount: args.length > 1 ? bytesToBigintLE(args[1]) : 0n,
          };

          this.processedRequests.add(requestId);

          console.log(`MidnightMonitor: New request ${requestId}`);
          console.log(`  Contract: ${contractAddress}`);
          console.log(`  ERC20: ${request.erc20Address}`);
          console.log(`  Amount: ${request.amount}`);

          try {
            await onSigningRequest(request);
          } catch (error) {
            console.error(`MidnightMonitor: Error processing ${requestId}:`, error);
            this.processedRequests.delete(requestId);
            allProcessed = false;
          }
        }

        // Advance the watermark only when every pending request went through:
        // a failed request stays unprocessed, keeps the nonce gate open, and
        // is retried on the next poll.
        if (allProcessed) {
          this.lastNonces.set(contractAddress, nonce);
        }
      } catch (error) {
        console.error(`MidnightMonitor: Error polling ${contractAddress}:`, error);
      }
    }
  }

  // ---- Transaction building & signing ----

  buildSerializedTransaction(request: MidnightSigningRequest): Uint8Array {
    return buildTransactionFromRequest(request);
  }

  async signAndBroadcastResponse(requestId: Uint8Array, evmReturnData: Uint8Array): Promise<SignedResponse> {
    const requestIdHex = Buffer.from(requestId).toString('hex');
    console.log(`MidnightMonitor: Signing remote-execution attestation for ${requestIdHex}`);

    const outputData = new Uint8Array(OUTPUT_DATA_SIZE);
    outputData.set(evmReturnData.slice(0, OUTPUT_DATA_SIZE));

    // Sign (requestId, hash(outputData)) with the same compiled circuits the
    // signet contract verifies against — signetAttestationMessage + the Schnorr
    // challenge — so the attestation passes postRemoteExecutionResponse's
    // in-circuit check.
    const msg = signetCircuits.signetAttestationMessage(requestId, outputData);
    const sig = schnorrSign(this.jubjubSk, msg, (ax, ay, px, py, m) =>
      signetCircuits.schnorrChallenge(ax, ay, px, py, m),
    );

    const response: SignedResponse = {
      requestId: requestIdHex,
      outputData: Buffer.from(outputData).toString('hex'),
      pk: { x: this.jubjubPk.x.toString(), y: this.jubjubPk.y.toString() },
      announcement: { x: sig.announcement.x.toString(), y: sig.announcement.y.toString() },
      response: sig.response.toString(),
    };

    // Post the attestation on-chain to the signet contract. There is no
    // push/websocket channel — the contract's remoteExecutionResponseIndex is
    // the delivery surface; the client polls it and presents the record to claim().
    await this.postRemoteExecutionResponse(requestId, {
      outputData,
      pk: this.jubjubPk,
      announcement: sig.announcement,
      response: sig.response,
    });
    console.log(`MidnightMonitor: posted remote-execution response for ${requestIdHex}`);

    return response;
  }

  /**
   * Post the MPC's EVM signature for a request on-chain to the
   * signet contract. The input is the fully-signed EVM
   * transaction the MPC produced; we extract its 65-byte `r || s || v`
   * ECDSA signature — the payload a poller recovers the signer from — and
   * submit it via the joined contract's `postSignatureResponse` circuit.
   */
  async broadcastSignedTransaction(data: {
    requestId: string;
    signedTransaction: string;
    txHash: string;
  }): Promise<void> {
    // The signature covers the transaction's unsigned hash, which is exactly
    // what a poller recovers the signer from (see signet-midnight's
    // recoverSignetEVMSignatureResponseSigner).
    const sig = ethers.Transaction.from(data.signedTransaction).signature;
    if (!sig) {
      throw new Error(`broadcastSignedTransaction: transaction for ${data.requestId} carries no signature`);
    }

    // Pack r (32) || s (32) || v (1). v is the recovery id (0/1); the
    // signature-responses reader normalises 0/1 and legacy 27/28 alike.
    const signatureResponse = new Uint8Array(65);
    signatureResponse.set(ethers.getBytes(sig.r), 0);
    signatureResponse.set(ethers.getBytes(sig.s), 32);
    signatureResponse[64] = sig.yParity;

    const requestId = ethers.getBytes(data.requestId);

    console.log(`MidnightMonitor: posting signature response for ${data.requestId} (tx ${data.txHash})...`);
    await this.postSignatureResponse(requestId, signatureResponse);
    console.log(`MidnightMonitor: posted signature response for ${data.requestId}`);
  }

  getJubjubPk(): any {
    return this.jubjubPk;
  }

  getPathHex(request: MidnightSigningRequest): string {
    return Buffer.from(request.path).toString('hex');
  }

  getPath(request: MidnightSigningRequest): string {
    return Buffer.from(request.path).toString('utf8').replace(/\0/g, '');
  }

  static fromServerConfig(config: ServerConfig): MidnightMonitor | null {
    if (!config.midnightIndexerUrl || !config.midnightContractAddresses?.length) {
      return null;
    }

    return new MidnightMonitor({
      networkId: (config.midnightNetworkId ?? 'undeployed') as NetworkId,
      indexerUrl: config.midnightIndexerUrl,
      indexerWsUrl: config.midnightIndexerWsUrl || config.midnightIndexerUrl.replace('http', 'ws'),
      nodeUrl: config.midnightNodeUrl || 'http://localhost:9944',
      proofServerUrl: config.midnightProofServerUrl || 'http://localhost:6300',
      contractAddresses: config.midnightContractAddresses,
      signetContractAddress: config.midnightSignetContractAddress,
      mpcRootKey: config.mpcRootKey,
      responderWalletSeed: config.midnightWalletSeed || '0000000000000000000000000000000000000000000000000000000000000001',
    });
  }
}

function decodePaddedString(bytes: Uint8Array): string {
  let end = bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) { end = i; break; }
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

function bytesToBigintLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}
