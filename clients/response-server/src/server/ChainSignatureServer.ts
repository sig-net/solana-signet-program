import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import BN from 'bn.js';
import * as bitcoin from 'bitcoinjs-lib';
import { ethers } from 'ethers'; 
import type {
  SignBidirectionalEvent,
  SignatureRequestedEvent,
  PendingTransaction,
  TransactionOutput,
  ServerConfig,
  CpiEventData,
  SignatureResponse,
} from '../types';
import { isSignBidirectionalEvent, isSignatureRequestedEvent } from '../types';
import { serverConfigSchema } from '../types';
import ChainSignaturesIDL from '../../idl/chain_signatures.json';
import { CryptoUtils } from '../modules/CryptoUtils';
import { CONFIG } from '../config/Config';
import { RequestIdGenerator } from '../modules/RequestIdGenerator';
import { EthereumMonitor } from '../modules/ethereum/EthereumMonitor';
import { BitcoinMonitor } from '../modules/bitcoin/BitcoinMonitor';
import { OutputSerializer } from '../modules/OutputSerializer';
import {
  SubstrateBidirectionalRequest,
  SubstrateMonitor,
  SubstrateSignatureRequest,
} from '../modules/SubstrateMonitor';
import {
  getNamespaceFromCaip2,
  SerializationFormat,
} from '../modules/ChainUtils';
import { CpiEventParser } from '../events/CpiEventParser';
import { handleBitcoinBidirectional } from '../modules/bitcoin/BidirectionalHandler';
import { handleEthereumBidirectional } from '../modules/ethereum/BidirectionalHandler';
import { BidirectionalHandlerContext } from '../modules/shared/BidirectionalContext';
import { MidnightMonitor, type MidnightSigningRequest } from '../modules/MidnightMonitor';
import { EthereumTransactionProcessor } from '../modules/ethereum/EthereumTransactionProcessor';

import * as borsh from 'borsh';


const pendingTransactions = new Map<string, PendingTransaction>();

const getNetwork = (config: ServerConfig) => {
  switch (config.bitcoinNetwork) {
    case 'testnet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
  }
};

export class ChainSignatureServer {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;
  private program: Program;
  private pollCounter = 0;
  private cpiSubscriptionId: number | null = null;
  private config: ServerConfig;
  private monitorIntervalId: NodeJS.Timeout | null = null;
  private monitoring = false; // re-entrancy guard for the transaction monitor tick
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private substrateMonitor: SubstrateMonitor | null = null;
  private midnightMonitor: MidnightMonitor | null = null;
  private inProgressTransactions = new Set<string>(); // Track transactions being processed

  constructor(config: ServerConfig) {
    try {
      this.config = serverConfigSchema.parse(config);
    } catch (error) {
      if (error instanceof Error && 'issues' in error) {
        const zodError = error as {
          issues: Array<{ path: string[]; message: string }>;
        };
        console.error('❌ Server configuration validation failed:');
        zodError.issues.forEach((err) => {
          console.error(`  - ${err.path.join('.')}: ${err.message}`);
        });
      }
      throw new Error('Invalid server configuration');
    }

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    const solanaKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(this.config.solanaPrivateKey))
    );

    this.connection = new Connection(this.config.solanaRpcUrl, 'confirmed');
    this.wallet = new anchor.Wallet(solanaKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });
    anchor.setProvider(this.provider);

    const idl = ChainSignaturesIDL as anchor.Idl;
    idl.address = this.config.programId;
    this.program = new Program(idl, this.provider);
    if (this.config.substrateWsUrl) {
      this.substrateMonitor = new SubstrateMonitor(this.config.substrateWsUrl);
    }
    this.midnightMonitor = MidnightMonitor.fromServerConfig(this.config);
  }

  async start() {
    console.log('🚀 Response Server');
    console.log(`Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(`Program: ${this.program.programId.toString()}`);

    await this.ensureInitialized();

    if (this.substrateMonitor) {
      await this.connectToSubstrate();
    }

    if (this.midnightMonitor) {
      await this.connectToMidnight();
    }

    this.startTransactionMonitor();
    this.setupEventListeners();

    // Resolve readiness so callers can await server.waitUntilReady()
    this.resolveReady?.();
  }

  private async connectToSubstrate() {
    if (!this.substrateMonitor) return;

    try {
      await this.substrateMonitor.connect();
      console.log('✅ Connected to Substrate node');

      await this.substrateMonitor.subscribeToEvents({
        onSignatureRequested: async (event: SubstrateSignatureRequest) => {
          console.log(
            { sender: event.sender },
            '📝 Substrate SignatureRequested'
          );
          try {
            await this.handleSubstrateSignatureRequest(event);
          } catch (error) {
            console.log(
              { error },
              'Error processing Substrate signature request'
            );
          }
        },

        onSignBidirectional: async (event: SubstrateBidirectionalRequest) => {
          console.log(
            { sender: event.sender, caip2Id: event.caip2Id },
            '📨 Substrate SignBidirectionalRequested'
          );
          try {
            await this.handleSubstrateBidirectional(event);
          } catch (error) {
            console.log(
              { error },
              'Error processing Substrate bidirectional request'
            );
          }
        },

        onRespondBidirectional: async (event: any) => {
          console.log(
            { requestId: event.requestId, responder: event.responder },
            '📖 Substrate RespondBidirectionalEvent'
          );
        },
      });
    } catch (error) {
      console.log({ error }, 'Failed to connect to Substrate');
    }
  }

  private async connectToMidnight() {
    if (!this.midnightMonitor) return;

    try {
      await this.midnightMonitor.initialize();
      console.log('Connected to Midnight network');

      await this.midnightMonitor.start({
        onSigningRequest: async (request: MidnightSigningRequest) => {
          console.log(
            `Midnight signing request: 0x${Buffer.from(request.requestId).toString('hex')} caip2=${request.caip2Id}`
          );
          try {
            await this.handleMidnightSigningRequest(request);
          } catch (error) {
            console.error('Error processing Midnight signing request:', error);
          }
        },
      });
    } catch (error) {
      console.error('Failed to connect to Midnight:', error);
    }
  }

  /**
   * Handle a signing request from the Midnight vault contract.
   *
   * The MPC reads calldata args + EVM gas params from the contract's ledger,
   * builds ABI calldata + RLP transaction off-chain from contract-controlled values,
   * signs with the derived secp256k1 key, and sends the signed tx to the client
   * via WebSocket. The CLIENT broadcasts to Sepolia. The MPC monitors for the tx hash.
   */
  private async handleMidnightSigningRequest(request: MidnightSigningRequest) {
    if (!this.midnightMonitor) return;

    // Build the unsigned EVM transaction from contract-controlled calldata + gas params
    const unsignedTxBytes = this.midnightMonitor.buildSerializedTransaction(request);

    // Derive the signing key using the contract's path field as the derivation path.
    // Path is the userCommitment stored as Field → Bytes<256> (raw bytes, not UTF-8).
    const pathHex = this.midnightMonitor.getPath(request);
    const derivedPrivateKey = await CryptoUtils.deriveSigningKeyWithChainId(
      pathHex,
      request.predecessor,
      this.config.mpcRootKey,
      'midnight:testnet'
    );

    // Parse the unsigned tx and sign it properly with ethers
    const unsignedTx = ethers.Transaction.from(ethers.hexlify(unsignedTxBytes));
    const wallet = new ethers.Wallet(derivedPrivateKey);
    const signedTxHex = await wallet.signTransaction(unsignedTx);
    const signedTx = ethers.Transaction.from(signedTxHex);
    const signedTxHash = signedTx.hash!;

    console.log(`Midnight: Signed tx ${signedTxHash}`);
    console.log(`  Signing address: ${wallet.address}`);

    const requestIdHex = '0x' + Buffer.from(request.requestId).toString('hex');

    // Post the MPC signature on-chain to the signature-responses contract
    // (the client polls it and broadcasts the EVM tx itself).
    await this.midnightMonitor.broadcastSignedTransaction({
      requestId: requestIdHex,
      signedTransaction: signedTxHex,
      txHash: signedTxHash,
    });

    // Store as pending transaction for the monitor to track.
    // The client broadcasts to Sepolia; the MPC watches for confirmation.
    pendingTransactions.set(signedTxHash, {
      txHash: signedTxHash,
      requestId: requestIdHex,
      caip2Id: request.caip2Id,
      explorerDeserializationSchema: Buffer.from(request.outputDeserializationSchema),
      callbackSerializationSchema: Buffer.from(request.respondSerializationSchema),
      fromAddress: wallet.address,
      nonce: Number(unsignedTx.nonce),
      checkCount: 0,
      namespace: request.caip2Id.split(':')[0],
      source: 'midnight',
    });

    console.log(`Midnight: Monitoring EVM tx ${signedTxHash} (client will broadcast)`);
  }

  private async ensureInitialized() {
    const [programStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('program-state')],
      this.program.programId
    );

    try {
      const accountInfo = await this.connection.getAccountInfo(programStatePda);
      if (accountInfo) {
        return;
      }
    } catch {}

    const signatureDeposit = this.config.signatureDeposit || '10000000';
    const chainId = this.config.chainId || 'solana:localnet';

    try {
      await this.program.methods
        .initialize(new BN(signatureDeposit), chainId)
        .accounts({
          admin: this.wallet.publicKey,
        })
        .rpc();
    } catch (error) {
      throw new Error(
        `Failed to initialize program: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private startTransactionMonitor() {
    this.monitorIntervalId = setInterval(async () => {
      // Non-re-entrant: handling a confirmed tx posts a response on-chain,
      // which can take far longer than the poll interval (e.g. a Midnight
      // attestation proof + submit). Without this guard, overlapping ticks
      // re-check the same still-in-flight tx every interval — flooding the log
      // with duplicate "Checking transaction…" output and wasting RPC calls —
      // before the in-progress guard below makes them no-op. Skip a tick while
      // the previous one is still running (same reason MidnightMonitor.start does).
      if (this.monitoring) return;
      this.monitoring = true;
      try {
        await this.runTransactionMonitorTick();
      } catch (error) {
        console.error('Transaction monitor tick error:', error);
      } finally {
        this.monitoring = false;
      }
    }, CONFIG.POLL_INTERVAL_MS);
  }

  private async runTransactionMonitorTick(): Promise<void> {
    this.pollCounter++;

    if (pendingTransactions.size > 0 && this.pollCounter % 12 === 1) {
      console.log(
        `📊 Monitoring pending transactions (count=${pendingTransactions.size})`
      );
    }

    for (const [txHash, txInfo] of pendingTransactions.entries()) {
        if (txInfo.checkCount > 0) {
          let skipFactor = 1;

          if (txInfo.namespace === 'bip122') {
            if (txInfo.checkCount > 10) skipFactor = 12;
            else if (txInfo.checkCount > 5) skipFactor = 6;
            else skipFactor = 2;
          } else {
            if (txInfo.checkCount > 20) skipFactor = 12;
            else if (txInfo.checkCount > 10) skipFactor = 6;
            else if (txInfo.checkCount > 5) skipFactor = 2;
          }

          if (this.pollCounter % skipFactor !== 0) {
            continue;
          }
        }

        try {
          const result =
            txInfo.namespace === 'bip122'
              ? await BitcoinMonitor.waitForTransactionAndGetOutput(
                  txHash,
                  txInfo.prevouts,
                  this.config
                )
              : await EthereumMonitor.waitForTransactionAndGetOutput(
                  txHash,
                  txInfo.caip2Id,
                  txInfo.explorerDeserializationSchema,
                  txInfo.fromAddress,
                  txInfo.nonce,
                  this.config
                );

          txInfo.checkCount++;

          switch (result.status) {
            case 'pending':
              // Just increment count, continue polling
              break;

            case 'success':
              // Skip if already being processed to prevent duplicate handling
              if (this.inProgressTransactions.has(txHash)) {
                break;
              }
              this.inProgressTransactions.add(txHash);
              try {
                await this.handleCompletedTransaction(txHash, txInfo, {
                  success: result.success!,
                  output: result.output,
                });
                pendingTransactions.delete(txHash);
              } finally {
                this.inProgressTransactions.delete(txHash);
              }
              break;

            case 'error':
              // Only for reverted/replaced - send signed error
              // Skip if already being processed to prevent duplicate handling
              if (this.inProgressTransactions.has(txHash)) {
                break;
              }
              this.inProgressTransactions.add(txHash);
              try {
                await this.handleFailedTransaction(txHash, txInfo);
                pendingTransactions.delete(txHash);
              } finally {
                this.inProgressTransactions.delete(txHash);
              }
              break;

            case 'fatal_error':
              // Just remove from map, don't send signed error
              console.error(
                `Fatal error for transaction ${txHash}: ${result.reason}`
              );
              pendingTransactions.delete(txHash);
              break;
          }
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message.includes('Modulus not supported') ||
            error.message.includes('Failed to parse SOLANA_PRIVATE_KEY') ||
            error.message.includes('Failed to load keypair'))
          ) {
            console.error(
              `Infrastructure error for ${txHash}: ${error.message}`
            );
            pendingTransactions.delete(txHash);
          } else {
            console.error(
              `Unexpected error polling ${txHash}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            txInfo.checkCount++;
          }
        }
      }
  }

  private async handleCompletedTransaction(
    txHash: string,
    txInfo: PendingTransaction,
    result: TransactionOutput
  ) {
    console.log(`✅ Transaction completed: ${txHash}`);

    const requestId = txInfo.requestId;
    if (!requestId) {
      throw new Error(`Missing request ID for tx ${txHash}`);
    }
    const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');

    try {
      if (txInfo.source === 'midnight' && this.midnightMonitor) {
        const serializedOutput = await OutputSerializer.serialize(
          result.output,
          SerializationFormat.Midnight,
          txInfo.callbackSerializationSchema
        );
        await this.midnightMonitor.signAndBroadcastResponse(requestIdBytes, serializedOutput);
      } else {
        // Solana / Substrate: serialize output + compute ed25519 signature
        const serializedOutput = await OutputSerializer.serialize(
          result.output,
          SerializationFormat.Borsh,
          txInfo.callbackSerializationSchema
        );
        const signature = await CryptoUtils.signBidirectionalResponse(
          requestIdBytes,
          serializedOutput,
          this.config.mpcRootKey
        );

        if (txInfo.source === 'polkadot' && this.substrateMonitor) {
          await this.substrateMonitor.sendRespondBidirectional(
            requestIdBytes,
            serializedOutput,
            signature
          );
          console.log('✅ Response sent to Substrate');
        } else {
          await this.program.methods
            .respondBidirectional(
              Array.from(requestIdBytes),
              Buffer.from(serializedOutput),
              signature
            )
            .accounts({
              responder: this.wallet.publicKey,
            })
            .rpc();
          console.log('✅ Response sent to Solana');
        }
      }

      pendingTransactions.delete(txHash);
    } catch (error) {
      console.error(
        `Error sending response for ${txHash}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      console.error(
        '🔍 Borsh serialization context',
        txInfo.callbackSerializationSchema,
        result.output
      );
    }
  }

  private async handleFailedTransaction(
    txHash: string,
    txInfo: PendingTransaction
  ) {
    console.warn(`❌ Transaction failed: ${txHash}`);

    try {
      const requestId = txInfo.requestId;
      if (!requestId) {
        throw new Error(`Missing request ID for tx ${txHash}`);
      }
      const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');

      if (txInfo.source === 'midnight' && this.midnightMonitor) {
        // Midnight: deadbeef prefix + serialized error using respond schema.
        // deadbeef in first 4 bytes makes claim() fail (byte 0 = 0xde != 0x01),
        // and a future refund() circuit can detect it via slice<4>(outputData, 0).
        const MAGIC_ERROR_PREFIX = [0xde, 0xad, 0xbe, 0xef];
        const errorOutput = { success: false };
        const serializedError = await OutputSerializer.serialize(
          errorOutput,
          SerializationFormat.Midnight,
          txInfo.callbackSerializationSchema
        );
        const outputData = new Uint8Array(MAGIC_ERROR_PREFIX.length + serializedError.length);
        outputData.set(MAGIC_ERROR_PREFIX);
        outputData.set(serializedError, MAGIC_ERROR_PREFIX.length);
        await this.midnightMonitor.signAndBroadcastResponse(requestIdBytes, outputData);
      } else {
        // Solana / Substrate: serialize error + compute ed25519 signature
        const MAGIC_ERROR_PREFIX = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const errorSchema = { struct: { error: 'bool' } };
        const borshData = borsh.serialize(errorSchema, { error: true });
        const errorData = Buffer.concat([MAGIC_ERROR_PREFIX, borshData]);
        const serializedOutput = new Uint8Array(errorData);

        const signature = await CryptoUtils.signBidirectionalResponse(
          requestIdBytes,
          serializedOutput,
          this.config.mpcRootKey
        );

        if (txInfo.source === 'polkadot' && this.substrateMonitor) {
          await this.substrateMonitor.sendRespondBidirectional(
            requestIdBytes,
            serializedOutput,
            signature
          );
          console.log('✅ Error response sent to Substrate');
        } else {
          await this.program.methods
            .respondBidirectional(
              Array.from(requestIdBytes),
              Buffer.from(serializedOutput),
              signature
            )
            .accounts({
              responder: this.wallet.publicKey,
            })
            .rpc();
          console.log('✅ Error response sent to Solana');
        }
      }
    } catch (error) {
      console.error(
        `Error sending error response for ${txHash}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private setupEventListeners() {
    const cpiEventHandlers = new Map<
      string,
      (event: CpiEventData, slot: number) => Promise<void>
    >();

    cpiEventHandlers.set(
      'signBidirectionalEvent',
      async (eventData: CpiEventData, _slot: number) => {
        if (!isSignBidirectionalEvent(eventData)) {
          console.error('Invalid event type for signBidirectionalEvent');
          return;
        }

        console.log(`📨 SignBidirectionalEvent from ${eventData.sender.toString()}`);

        try {
          await this.handleSignBidirectional(eventData);
        } catch (error) {
          console.error(
            `Error processing bidirectional: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );

    cpiEventHandlers.set(
      'signatureRequestedEvent',
      async (eventData: CpiEventData) => {
        if (!isSignatureRequestedEvent(eventData)) {
          console.error('Invalid event type for signatureRequestedEvent');
          return;
        }

        console.log(`📝 SignatureRequestedEvent from ${eventData.sender.toString()}`);

        try {
          await this.handleSignatureRequest(eventData);
        } catch (error) {
          console.error(
            `Error sending signature: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );

    this.cpiSubscriptionId = CpiEventParser.subscribeToCpiEvents(
      this.connection,
      this.program,
      cpiEventHandlers
    );
  }

  private async handleSignBidirectional(event: SignBidirectionalEvent) {
    const namespace = getNamespaceFromCaip2(event.caip2Id);
    console.log(
      `🧾 SignBidirectional payload namespace=${namespace} caip2Id=${event.caip2Id} keyVersion=${event.keyVersion} path=${event.path} algo=${event.algo} dest=${event.dest} params=${event.params} sender=${event.sender.toString()}`
    );
    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );

    if (namespace === 'bip122') {
      await handleBitcoinBidirectional(
        event,
        this.getBidirectionalContext(),
        derivedPrivateKey
      );
      return;
    }

    if (namespace === 'eip155') {
      await handleEthereumBidirectional(
        event,
        this.getBidirectionalContext(),
        derivedPrivateKey
      );
      return;
    }

    throw new Error(`Unsupported chain namespace: ${namespace}`);
  }

  private async handleSignatureRequest(event: SignatureRequestedEvent) {
    const requestId = RequestIdGenerator.generateSignRequestId(
      event.sender.toString(),
      Array.from(event.payload),
      event.path,
      event.keyVersion,
      0,
      event.algo,
      event.dest,
      event.params
    );

    console.log(`🔑 Request ID: ${requestId}`);

    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );

    const signature = await CryptoUtils.signMessage(
      event.payload,
      derivedPrivateKey
    );

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
    const tx = await this.program.methods
      .respond([requestIdBytes], [signature])
      .accounts({
        responder: this.wallet.publicKey,
      })
      .rpc();

    console.log(`✅ Signature sent! tx=${tx}`);
  }

  private getBidirectionalContext(): BidirectionalHandlerContext {
    return {
      sendSignatures: async (
        requestIds: Uint8Array[],
        signatures: SignatureResponse[]
      ) => {
        const requestIdArrays = requestIds.map((id) => Array.from(id));
        await this.program.methods
          .respond(requestIdArrays, signatures)
          .accounts({
            responder: this.wallet.publicKey,
          })
          .rpc();
      },
      config: this.config,
      pendingTransactions,
      source: 'solana',
    };
  }

  private getSubstrateBidirectionalContext(): BidirectionalHandlerContext {
    return {
      sendSignatures: async (
        requestIds: Uint8Array[],
        signatures: SignatureResponse[]
      ) => {
        for (let i = 0; i < requestIds.length; i++) {
          await this.substrateMonitor!.sendSignatureResponse(
            requestIds[i],
            signatures[i]
          );
        }
      },
      config: this.config,
      pendingTransactions,
      source: 'polkadot',
    };
  }

  private async handleSubstrateSignatureRequest(
    event: SubstrateSignatureRequest
  ) {
    const path = Buffer.from(event.path.slice(2), 'hex').toString();
    const algo = Buffer.from(event.algo.slice(2), 'hex').toString();
    const dest =
      event.dest === '0x'
        ? ''
        : Buffer.from(event.dest.slice(2), 'hex').toString();
    const params = Buffer.from(event.params.slice(2), 'hex').toString();
    const chainId = Buffer.from(event.chainId.slice(2), 'hex').toString();

    console.log({ path, algo, chainId, params: params || '(empty)' });

    const requestId = RequestIdGenerator.generateRequestIdStringChainId(
      event.sender,
      Array.from(event.payload),
      path,
      event.keyVersion,
      chainId,
      algo,
      dest,
      params
    );

    console.log({ requestId }, '🔑 Request ID');

    const derivedPrivateKey = await CryptoUtils.deriveSigningKeyWithChainId(
      path,
      event.sender,
      this.config.mpcRootKey,
      'polkadot:2034'
    );

    const signature = await CryptoUtils.signMessage(
      Array.from(event.payload), // Convert Uint8Array to number[]
      derivedPrivateKey
    );

    await this.substrateMonitor!.sendSignatureResponse(
      Buffer.from(requestId.slice(2), 'hex'),
      signature
    );

    console.log('✅ Signature sent to Substrate');
  }

  private async handleSubstrateBidirectional(
    event: SubstrateBidirectionalRequest
  ) {
    console.log(`🔍 Server received sender: ${event.sender}`);
    console.log(`🔍 Server received path: ${event.path}`);

    const path = Buffer.from(event.path.slice(2), 'hex').toString();
    const algo = Buffer.from(event.algo.slice(2), 'hex').toString();
    const dest =
      event.dest === '0x'
        ? ''
        : Buffer.from(event.dest.slice(2), 'hex').toString();
    const params = Buffer.from(event.params.slice(2), 'hex').toString();

    const namespace = getNamespaceFromCaip2(event.caip2Id);

    const derivedPrivateKey = await CryptoUtils.deriveSigningKeyWithChainId(
      path,
      event.sender,
      this.config.mpcRootKey,
      'polkadot:2034'
    );

    console.log(`🔍 Path for key derivation: ${path}`);
    console.log(`🔍 Sender for key derivation: ${event.sender}`);
    console.log(
      `🔍 Private key (first 10 chars): ${derivedPrivateKey.slice(0, 12)}...`
    );

    // Convert to SignBidirectionalEvent format
    const normalizedEvent: SignBidirectionalEvent = {
      sender: event.sender,
      serializedTransaction: event.serializedTransaction,
      caip2Id: event.caip2Id,
      keyVersion: event.keyVersion,
      path,
      algo,
      dest,
      params,
      outputDeserializationSchema: event.outputDeserializationSchema,
      respondSerializationSchema: event.respondSerializationSchema,
    };

    if (namespace === 'bip122') {
      await handleBitcoinBidirectional(
        normalizedEvent,
        this.getSubstrateBidirectionalContext(),
        derivedPrivateKey
      );
      return;
    }

    if (namespace === 'eip155') {
      await handleEthereumBidirectional(
        normalizedEvent,
        this.getSubstrateBidirectionalContext(),
        derivedPrivateKey
      );
      return;
    }

    throw new Error(`Unsupported namespace: ${namespace}`);
  }

  /**
   * Await until the server has finished its startup sequence and listeners are registered.
   * Useful in tests to avoid racing the first request against the log subscription.
   */
  async waitUntilReady(timeoutMs = 2_000): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(
          new Error(
            `ChainSignatureServer readiness timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
    });

    await Promise.race([this.readyPromise, timeoutPromise]);
  }

  async shutdown() {
    console.log('🛑 Shutting down...');
    if (this.monitorIntervalId !== null) {
      clearInterval(this.monitorIntervalId);
      this.monitorIntervalId = null;
    }
    if (this.cpiSubscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.cpiSubscriptionId);
      this.cpiSubscriptionId = null;
    }
    if (this.substrateMonitor) {
      await this.substrateMonitor.disconnect();
      this.substrateMonitor = null;
    }
    if (this.midnightMonitor) {
      await this.midnightMonitor.stop();
      this.midnightMonitor = null;
    }
  }
}
