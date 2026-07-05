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

  // ---- Generic state tree reader ----
  // State is a nested array: root[i][j] where [i,j] matches the signet field index.
  // StateMap uses .keys() + .get() — it is NOT iterable with for...of.

  // Resolve a flat field index to its node by walking the runtime's field
  // chunks. The chunk boundaries shift with total field count, so we locate the
  // chunk dynamically instead of assuming a fixed [chunk, inner] split.
  private getNode(state: any, flatIndex: number): any {
    const raw = state.state ?? state;
    let idx = flatIndex;
    for (const chunk of raw.asArray()) {
      const arr = chunk.asArray();
      if (idx < arr.length) return arr[idx];
      idx -= arr.length;
    }
    throw new Error(`Field index ${flatIndex} out of range`);
  }

  private readCounter(state: any, index: number): bigint {
    const node = this.getNode(state, index);
    const cr = this.compactRuntime;
    const desc = new cr.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    return desc.fromValue([...node.asCell().value]);
  }

  private readCell(state: any, index: number, size: number): Uint8Array {
    const node = this.getNode(state, index);
    const cr = this.compactRuntime;
    const desc = new cr.CompactTypeBytes(size);
    return desc.fromValue([...node.asCell().value]);
  }

  private readMapKeys(state: any, index: number): Array<{ raw: any; bytes: Uint8Array }> {
    const node = this.getNode(state, index);
    const cr = this.compactRuntime;
    const keyDesc = new cr.CompactTypeBytes(32);
    const map = node.asMap();
    return map.keys().map((k: any) => ({ raw: k, bytes: keyDesc.fromValue([...k.value]) }));
  }

  private lookupMap(state: any, index: number, key: Uint8Array, valueDesc: any): any {
    const node = this.getNode(state, index);
    const map = node.asMap();
    const mapKeys = map.keys();
    const cr = this.compactRuntime;
    const keyDesc = new cr.CompactTypeBytes(32);
    for (const k of mapKeys) {
      const kBytes = keyDesc.fromValue([...k.value]);
      if (kBytes.length === key.length && kBytes.every((b: number, i: number) => b === key[i])) {
        const val = map.get(k);
        return valueDesc.fromValue([...val.asCell().value]);
      }
    }
    throw new Error(`Key not found in map at [${index}]`);
  }

  // ---- State reading using fixed indices ----

  private readAllRequests(state: any, contractAddress: string): SigningRequest[] {
    const cr = this.compactRuntime;
    const bytesDesc = (n: number) => new cr.CompactTypeBytes(n);
    const uintDesc = (max: bigint, bytes: number) => new cr.CompactTypeUnsignedInteger(max, bytes);

    const requests: SigningRequest[] = [];

    // Iterate signetRequestNonce map for all request IDs
    const nonceKeys = this.readMapKeys(state, IDX.signetRequestNonce);

    for (const { bytes: requestId } of nonceKeys) {
      // Skip if already has outputData (already claimed)
      try {
        const odKeys = this.readMapKeys(state, IDX.signetOutputData);
        if (odKeys.some(({ bytes: k }) => k.every((b: number, i: number) => b === requestId[i]))) continue;
      } catch { /* no outputData map yet */ }

      const lookup = (idx: number, key: Uint8Array, desc: any) => {
        return this.lookupMap(state, idx, key, desc);
      };

      try {
        const nonce = lookup(IDX.signetRequestNonce, requestId, uintDesc(18446744073709551615n, 8));
        const funcSigRaw = lookup(IDX.signetCalldataFuncSig, requestId, bytesDesc(256));
        const argCount = Number(lookup(IDX.signetCalldataArgCount, requestId, uintDesc(4294967295n, 4)));

        const args: Uint8Array[] = [];
        for (let i = 0; i < argCount; i++) {
          const key = calldataArgKey(requestId, i);
          args.push(lookup(IDX.signetCalldataArgs, key, bytesDesc(32)));
        }

        const funcSig = decodePaddedString(funcSigRaw);
        const calldata: CalldataFields = { funcSig, argCount, args };

        const evmTo = lookup(IDX.signetEvmTo, requestId, bytesDesc(20));
        const evmChainId = lookup(IDX.signetEvmChainId, requestId, uintDesc(18446744073709551615n, 8));
        const evmNonce = lookup(IDX.signetEvmNonce, requestId, uintDesc(18446744073709551615n, 8));
        const evmGasLimit = lookup(IDX.signetEvmGasLimit, requestId, uintDesc(18446744073709551615n, 8));
        const evmMaxFee = lookup(IDX.signetEvmMaxFee, requestId, uintDesc(340282366920938463463374607431768211455n, 16));
        const evmPriorityFee = lookup(IDX.signetEvmPriorityFee, requestId, uintDesc(340282366920938463463374607431768211455n, 16));
        const evmValue = lookup(IDX.signetEvmValue, requestId, uintDesc(340282366920938463463374607431768211455n, 16));

        const caip2IdRaw = lookup(IDX.signetCaip2Id, requestId, bytesDesc(64));
        const keyVersion = Number(lookup(IDX.signetKeyVersion, requestId, uintDesc(4294967295n, 4)));
        const pathRaw = new Uint8Array(lookup(IDX.signetPath, requestId, bytesDesc(256)));
        const algoRaw = lookup(IDX.signetAlgo, requestId, bytesDesc(32));
        const destRaw = lookup(IDX.signetDest, requestId, bytesDesc(64));
        const paramsRaw = lookup(IDX.signetParams, requestId, bytesDesc(512));
        const outputSchemaRaw = lookup(IDX.signetOutputSchema, requestId, bytesDesc(256));
        const respondSchemaRaw = lookup(IDX.signetRespondSchema, requestId, bytesDesc(256));

        const expectedRequestId = computeRequestId({
          nonce,
          evmChainId,
          evmNonce,
          evmGasLimit,
          evmMaxFee,
          evmPriorityFee,
          evmValue,
          evmTo,
          calldataFuncSig: funcSigRaw,
          calldataArgsCommitment: computeCalldataArgsCommitment(args),
          caip2Id: caip2IdRaw,
          keyVersion,
          path: pathRaw,
          algo: algoRaw,
          dest: destRaw,
          params: paramsRaw,
          outputSchema: outputSchemaRaw,
          respondSchema: respondSchemaRaw,
        });

        if (!requestId.every((b: number, i: number) => b === expectedRequestId[i])) {
          console.error(`MidnightMonitor: REFUSING request — requestId mismatch. Contract stored ${Buffer.from(requestId).toString('hex')}, recomputed ${Buffer.from(expectedRequestId).toString('hex')}`);
          continue;
        }

        requests.push({
          predecessor: contractAddress,
          requestId,
          nonce,
          evmParams: { evmTo, evmChainId, evmNonce, evmGasLimit, evmMaxFee, evmPriorityFee, evmValue },
          calldata,
          caip2Id: decodeString(caip2IdRaw),
          keyVersion,
          path: pathRaw,
          algo: decodeString(algoRaw),
          dest: decodeString(destRaw),
          params: decodeLengthPrefixed(paramsRaw),
          outputDeserializationSchema: decodeLengthPrefixed(outputSchemaRaw),
          respondSerializationSchema: decodeLengthPrefixed(respondSchemaRaw),
        });
      } catch (e) {
        console.error(`MidnightMonitor: Failed to read request ${Buffer.from(requestId).toString('hex')}:`, e);
      }
    }

    return requests;
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
        console.log(`MIDNIGHT!!!!!!!!! check for txns for ADDRESS '${contractAddress}' !!!!!!!!!`)

        const contractState = await this.publicDataProvider.queryContractState(contractAddress);
        if (!contractState?.data) {
          console.warn(`no state data found for contract '${contractAddress}'`);
          continue;
        };

        // const state = contractState.data;
        // const currentNonce = this.readCounter(state, IDX.signetNonce);

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

        //   this.processedRequests.add(requestId);

        //   console.log(`MidnightMonitor: New request ${requestId}`);
        //   console.log(`  Contract: ${contractAddress}`);
        //   console.log(`  ERC20: ${request.erc20Address}`);
        //   console.log(`  Amount: ${request.amount}`);

        //   try {
        //     await onSigningRequest(request);
        //   } catch (error) {
        //     console.error(`MidnightMonitor: Error processing ${requestId}:`, error);
        //     this.processedRequests.delete(requestId);
        //   }
        // }
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

  // broadcastSignedTransaction(data: {
  //   requestId: string;
  //   signedTransaction: string;
  //   txHash: string;
  // }): void {
  //   if (this.wss) {
  //     const message = JSON.stringify({ type: 'signet_signed_tx', data });
  //     for (const client of this.wss.clients) {
  //       if (client.readyState === WebSocket.OPEN) {
  //         client.send(message);
  //       }
  //     }
  //   }
  // }

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
