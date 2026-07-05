/**
 * MidnightMonitor - Generic signet monitor for any Midnight contract.
 *
 * The MPC needs ONLY a contract address. No compiled contract, no ZK keys,
 * no contract-info.json. State is read using fixed signet field indices
 * that all signet-conforming contracts share (declared first in source).
 *
 * Flow:
 * 1. Polls the contract's raw state via the Midnight GraphQL indexer
 * 2. Reads signetNonce (index 1) to detect new requests
 * 3. Iterates signetRequestNonce map (index 2) for request IDs
 * 4. Reads calldata + EVM params from fixed indices (3-21)
 * 5. Builds ABI calldata + RLP transaction off-chain
 * 6. After EVM tx confirmed, signs (requestId, outputData) with Schnorr
 * 7. Broadcasts signature via WebSocket — the USER calls claim() on-chain
 */

import { Buffer } from 'buffer';
import type { ServerConfig } from '../types';

// FIXME, MAJOR!!!: import these from the pure circuits near the contract to prevent rebuilding!!!
import { schnorrSign, buildSignetMessage, deriveJubjubKeypair, hashJubjubPoint } from '../managed/erc20-vault/signet/schnorr';

// Shared, app-neutral Schnorr challenge — one compiled copy of the `schnorr`
// module, identical for every signet contract. The MPC stays contract-agnostic.
import { pureCircuits as schnorrLib } from '../managed/schnorr-lib/contract/index.js';
import { buildTransactionFromRequest } from '../managed/erc20-vault/signet/calldata-builder';
import type { SigningRequest, EvmGasParams, CalldataFields } from '../managed/erc20-vault/signet/types';
import { OUTPUT_DATA_SIZE } from '../managed/erc20-vault/signet/constants';
import { decodeLengthPrefixed, decodeString } from '../managed/erc20-vault/signet/codec';
import { calldataArgKey, computeRequestId, computeCalldataArgsCommitment } from '../managed/erc20-vault/signet/request-id';
import { readSignetEVMSignatureRequestIndexFromState } from "@midnight-erc20-vault/signet-midnight";

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';

// ---- Signet Standard Field Indices (fixed across all contracts) ----
// All signet-conforming contracts MUST declare these fields first.
// Flat field indices in ledger declaration order. The runtime chunks fields
// into nested arrays whose split point depends on the TOTAL field count, so we
// resolve the chunk dynamically (see getNode) rather than hardcode [chunk,inner].
// This stays generic across signet contracts regardless of trailing/contract
// fields or sealed config fields.
const IDX = {
  mpcPubKeyHash: 0,
  signetNonce: 1,
  signetRequestNonce: 2,
  signetCalldataFuncSig: 3,
  signetCalldataArgCount: 4,
  signetCalldataArgs: 5,
  signetEvmTo: 6,
  signetEvmChainId: 7,
  signetEvmNonce: 8,
  signetEvmGasLimit: 9,
  signetEvmMaxFee: 10,
  signetEvmPriorityFee: 11,
  signetEvmValue: 12,
  signetCaip2Id: 13,
  signetKeyVersion: 14,
  signetPath: 15,
  signetAlgo: 16,
  signetDest: 17,
  signetParams: 18,
  signetOutputSchema: 19,
  signetRespondSchema: 20,
  signetOutputData: 21,
} as const;

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
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  contractAddresses: string[];
  mpcRootKey: string;
  pollIntervalMs?: number;
  wsPort?: number;
}

(globalThis as any).WebSocket = WebSocket;

export class MidnightMonitor {
  private config: MidnightMonitorConfig;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private lastNonces = new Map<string, bigint>();
  private processedRequests = new Set<string>();

  private publicDataProvider: PublicDataProvider | null = null;
  private compactRuntime: any = null;

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

    this.compactRuntime = await import('@midnight-ntwrk/compact-runtime');

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
    console.log('MidnightMonitor: Stopped');
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
        const typedState = readSignetEVMSignatureRequestIndexFromState(contractState.data);

        // FIXME: put back nonce functionality to prevent full ledger read each time until nonce increments
        for (const [requestId, signetRequest] of typedState.entries()) {
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
          }          
        } 

        // const lastNonce = this.lastNonces.get(contractAddress);
        // if (lastNonce === undefined) {
        //   this.lastNonces.set(contractAddress, currentNonce);
        //   console.log(`MidnightMonitor: Seeded nonce for ${contractAddress} at ${currentNonce}`);
        //   continue;
        // }
        // if (currentNonce <= lastNonce) continue;

        // console.log(`MidnightMonitor: New requests on ${contractAddress} (nonce ${lastNonce} -> ${currentNonce})`);
        // this.lastNonces.set(contractAddress, currentNonce);

        // const requests = this.readAllRequests(state, contractAddress);

        // for (const req of requests) {
        //   if (req.nonce < lastNonce) continue;
        //   const requestId = '0x' + Buffer.from(req.requestId).toString('hex');
        //   if (this.processedRequests.has(requestId)) continue;

        //   const erc20Bytes = req.evmParams.evmTo;
        //   const amount = req.calldata.args.length > 1 ? bytesToBigintLE(req.calldata.args[1]) : 0n;

        //   const request: MidnightSigningRequest = {
        //     ...req,
        //     erc20Address: '0x' + Buffer.from(erc20Bytes).toString('hex'),
        //     amount,
        //   };
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
    console.log(`MidnightMonitor: Signing response for ${requestIdHex}`);

    const outputData = new Uint8Array(OUTPUT_DATA_SIZE);
    outputData.set(evmReturnData.slice(0, OUTPUT_DATA_SIZE));

    const msg = buildSignetMessage(requestId, outputData);
    const sig = schnorrSign(this.jubjubSk, msg, (ax, ay, px, py, m) =>
      schnorrLib.schnorrChallenge(ax, ay, px, py, m),
    );

    const response: SignedResponse = {
      requestId: requestIdHex,
      outputData: Buffer.from(outputData).toString('hex'),
      pk: { x: this.jubjubPk.x.toString(), y: this.jubjubPk.y.toString() },
      announcement: { x: sig.announcement.x.toString(), y: sig.announcement.y.toString() },
      response: sig.response.toString(),
    };

    console.debug("SIGNATURE RESPONSE! SEND THIS TO CLIENT!!!", JSON.stringify({ type: 'signet_response', data: response }));

    // if (this.wss) {
    //   const message = JSON.stringify({ type: 'signet_response', data: response });
    //   for (const client of this.wss.clients) {
    //     if (client.readyState === WebSocket.OPEN) {
    //       client.send(message);
    //     }
    //   }
    //   console.log(`MidnightMonitor: Broadcast response for ${requestIdHex} to ${this.wss.clients.size} clients`);
    // }

    return response;
  }

  broadcastSignedTransaction(data: {
    requestId: string;
    signedTransaction: string;
    txHash: string;
  }): void {
    console.debug("MIDNIGHT MONITOR broadcastSignedTransaction running!!!!!!!");
    // if (this.wss) {
    //   const message = JSON.stringify({ type: 'signet_signed_tx', data });
    //   for (const client of this.wss.clients) {
    //     if (client.readyState === WebSocket.OPEN) {
    //       client.send(message);
    //     }
    //   }
    // }
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
      indexerUrl: config.midnightIndexerUrl,
      indexerWsUrl: config.midnightIndexerWsUrl || config.midnightIndexerUrl.replace('http', 'ws'),
      nodeUrl: config.midnightNodeUrl || 'http://localhost:9944',
      contractAddresses: config.midnightContractAddresses,
      mpcRootKey: config.mpcRootKey,
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
