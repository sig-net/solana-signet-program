import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import BN from 'bn.js';
import type {
  SignBidirectionalEvent,
  SignatureRequestedEvent,
  PendingTransaction,
  TransactionOutput,
  ServerConfig,
  CpiEventData,
} from '../types';
import { isSignBidirectionalEvent, isSignatureRequestedEvent } from '../types';
import { serverConfigSchema } from '../types';
import {
  type ChainSignaturesProgram,
  asChainSignaturesProgram,
} from '../types/program';
import ChainSignaturesIDL from '../../idl/chain_signatures.json';
import { CryptoUtils } from '../modules/CryptoUtils';
import { CONFIG } from '../config/Config';
import { contracts } from 'signet.js';
const { getRequestIdRespond } = contracts.solana;
import { EthereumMonitor } from '../modules/ethereum/EthereumMonitor';
import { BitcoinMonitor } from '../modules/bitcoin/BitcoinMonitor';
import { OutputSerializer } from '../modules/OutputSerializer';
import { CpiEventParser } from '../events/CpiEventParser';
import * as borsh from 'borsh';
import {
  SerializationFormat,
  getNamespaceFromCaip2,
} from '../modules/ChainUtils';
import { handleBitcoinBidirectional } from '../modules/bitcoin/BidirectionalHandler';
import { handleEthereumBidirectional } from '../modules/ethereum/BidirectionalHandler';
import type { BidirectionalHandlerContext } from '../modules/shared/BidirectionalContext';

const pendingTransactions = new Map<string, PendingTransaction>();

const BACKFILL_INTERVAL_MS = 5_000;
const BACKFILL_BATCH_SIZE = 5;
const MAX_PROCESSED_SIGNATURES = 1_000;

export class ChainSignatureServer {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;
  private program: ChainSignaturesProgram;
  private pollCounter = 0;
  private cpiSubscriptionId: number | null = null;
  private config: ServerConfig;
  private monitorIntervalId: NodeJS.Timeout | null = null;
  private backfillIntervalId: NodeJS.Timeout | null = null;
  private processedSignatures = new Set<string>();
  private cpiEventHandlers = new Map<
    string,
    (event: CpiEventData, slot: number) => Promise<void>
  >();
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;

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

    this.connection = new Connection(this.config.solanaRpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    });
    this.wallet = new anchor.Wallet(solanaKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });
    anchor.setProvider(this.provider);

    const idl = ChainSignaturesIDL as anchor.Idl;
    idl.address = this.config.programId;
    this.program = asChainSignaturesProgram(new Program(idl, this.provider));
  }

  async start() {
    console.log('🚀 Response Server');
    console.log(`Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(`Program: ${this.program.programId.toString()}`);

    await this.ensureInitialized();

    this.startTransactionMonitor();
    this.setupEventListeners();
    this.startBackfillMonitor();

    // Resolve readiness so callers can await server.waitUntilReady()
    this.resolveReady?.();
  }

  private async ensureInitialized() {
    const [programStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('program-state')],
      this.program.programId
    );

    try {
      console.log(`🔗 Solana RPC: getAccountInfo for program state PDA...`);
      const accountInfo = await this.connection.getAccountInfo(programStatePda);
      console.log(`✓ Solana RPC: getAccountInfo done (exists=${!!accountInfo})`);
      if (accountInfo) {
        return;
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
        console.log(
          '⚠️ RPC returned 401, assuming program is already initialized...'
        );
        return;
      }
      throw error;
    }

    const signatureDeposit = this.config.signatureDeposit || '1';
    const chainId =
      this.config.chainId || 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

    try {
      console.log(`🔗 Solana RPC: program.initialize() (THIS CAN HANG)...`);
      await this.program.methods
        .initialize(new BN(signatureDeposit), chainId)
        .accounts({
          admin: this.wallet.publicKey,
        })
        .rpc();
      console.log(`✓ Solana RPC: program.initialize() done`);
    } catch (error: unknown) {
      const errorStr = String(error);
      const errorMsg = error instanceof Error ? error.message : errorStr;
      if (
        errorStr.includes('already in use') ||
        errorStr.includes('custom program error: 0x0') ||
        errorMsg.includes('already in use') ||
        errorMsg.includes('custom program error: 0x0') ||
        errorMsg.includes('0x0')
      ) {
        console.log('⚠️ Program already initialized, continuing...');
        return;
      }
      throw new Error(`Failed to initialize program: ${errorMsg}`);
    }
  }

  private startTransactionMonitor() {
    console.log(
      `⏱️ Starting transaction monitor (interval=${CONFIG.POLL_INTERVAL_MS}ms)`
    );
    this.monitorIntervalId = setInterval(async () => {
      this.pollCounter++;

      if (pendingTransactions.size > 0) {
        console.log(
          `📊 Transaction monitor poll #${this.pollCounter} (pending=${pendingTransactions.size})`
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
          console.log(
            `  🔍 Checking ${txInfo.namespace} tx: ${txHash} (attempt #${txInfo.checkCount + 1})`
          );
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
          console.log(`  📋 Result for ${txHash}: ${result.status}`);

          txInfo.checkCount++;

          switch (result.status) {
            case 'pending':
              // Just increment count, continue polling
              break;

            case 'success':
              await this.handleCompletedTransaction(txHash, txInfo, {
                success: result.success,
                output: result.output,
              });
              pendingTransactions.delete(txHash);
              break;

            case 'error':
              // Only for reverted/replaced - send signed error
              await this.handleFailedTransaction(txHash, txInfo);
              pendingTransactions.delete(txHash);
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
    }, CONFIG.POLL_INTERVAL_MS);
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
    console.log(`🔗 OutputSerializer: serialize...`);
    const serializedOutput = await OutputSerializer.serialize(
      result.output,
      SerializationFormat.Borsh, // Server only respond to Solana for now
      txInfo.callbackSerializationSchema
    );
    console.log(`✓ OutputSerializer: serialize done (${serializedOutput.length} bytes)`);

    const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');
    console.log(`🔗 CryptoUtils: signBidirectionalResponse...`);
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey,
      txInfo.sender
    );
    console.log(`✓ CryptoUtils: signBidirectionalResponse done`);

    try {
      console.log(`🔗 Solana RPC: respondBidirectional() for ${txHash} (THIS CAN HANG)...`);
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
      console.log(`✓ Solana RPC: respondBidirectional() done for ${txHash}`);

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
      const MAGIC_ERROR_PREFIX = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

      const errorSchema = { struct: { error: 'bool' } };
      const borshData = borsh.serialize(errorSchema, { error: true });
      const errorData = Buffer.concat([MAGIC_ERROR_PREFIX, borshData]);

      const serializedOutput = new Uint8Array(errorData);

      const requestId = txInfo.requestId;
      if (!requestId) {
        throw new Error(`Missing request ID for tx ${txHash}`);
      }
      const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');
      console.log(`🔗 CryptoUtils: signBidirectionalResponse (error response)...`);
      const signature = await CryptoUtils.signBidirectionalResponse(
        requestIdBytes,
        serializedOutput,
        this.config.mpcRootKey,
        txInfo.sender
      );
      console.log(`✓ CryptoUtils: signBidirectionalResponse done`);

      console.log(`🔗 Solana RPC: respondBidirectional() error for ${txHash} (THIS CAN HANG)...`);
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
      console.log(`✓ Solana RPC: respondBidirectional() error done for ${txHash}`);
    } catch (error) {
      console.error(
        `Error sending error response for ${txHash}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private setupEventListeners() {
    this.cpiEventHandlers.set(
      'signBidirectionalEvent',
      async (eventData: CpiEventData, _slot: number) => {
        if (!isSignBidirectionalEvent(eventData)) {
          console.error('Invalid event type for signBidirectionalEvent');
          return;
        }

        console.log(
          `📨 SignBidirectionalEvent from ${eventData.sender.toString()}`
        );

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

    this.cpiEventHandlers.set(
      'signatureRequestedEvent',
      async (eventData: CpiEventData) => {
        if (!isSignatureRequestedEvent(eventData)) {
          console.error('Invalid event type for signatureRequestedEvent');
          return;
        }

        console.log(
          `📝 SignatureRequestedEvent from ${eventData.sender.toString()}`
        );

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

    console.log('👂 Starting WebSocket subscription for program logs...');
    this.cpiSubscriptionId = this.connection.onLogs(
      this.program.programId,
      async (logs, context) => {
        console.log(
          `📡 WebSocket received logs for signature: ${logs.signature} (slot=${context.slot})`
        );
        if (logs.err) {
          console.log(`  ⚠️ Skipping - transaction has error`);
          return;
        }
        if (this.processedSignatures.has(logs.signature)) {
          console.log(`  ⚠️ Skipping - already processed`);
          return;
        }

        this.processedSignatures.add(logs.signature);
        try {
          await this.processTransaction(logs.signature, context.slot);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
            console.warn(`⚠️ WebSocket: 429 rate limited processing ${logs.signature}, will retry via backfill`);
            // Remove from processed so backfill can retry
            this.processedSignatures.delete(logs.signature);
          } else {
            console.error(`❌ WebSocket: error processing ${logs.signature}: ${errorMsg}`);
          }
        }
      },
      'confirmed'
    );
    console.log(`✅ WebSocket subscription active (id=${this.cpiSubscriptionId})`);
  }

  private async processTransaction(
    signature: string,
    slot: number
  ): Promise<void> {
    console.log(`🔎 Processing transaction: ${signature} (slot=${slot})`);
    const events = await CpiEventParser.parseCpiEvents(
      this.connection,
      signature,
      this.program.programId.toString(),
      this.program
    );

    console.log(`  📦 Parsed ${events.length} event(s) from transaction`);
    for (const event of events) {
      console.log(`  🎯 Event: ${event.name}`);
      const handler = this.cpiEventHandlers.get(event.name);
      if (handler) {
        await handler(event.data, slot);
      }
    }
  }

  private startBackfillMonitor() {
    console.log(
      `🔄 Starting backfill monitor (interval=${BACKFILL_INTERVAL_MS}ms, batch=${BACKFILL_BATCH_SIZE})`
    );
    const backfill = async () => {
      console.log(
        `🔍 Backfill: polling for recent signatures (processed=${this.processedSignatures.size})`
      );
      try {
        console.log(`  🔗 Solana RPC: getSignaturesForAddress...`);
        const signatures = await this.connection.getSignaturesForAddress(
          this.program.programId,
          { limit: BACKFILL_BATCH_SIZE },
          'confirmed'
        );
        console.log(`  ✓ Solana RPC: getSignaturesForAddress done`);

        console.log(`  📋 Backfill: found ${signatures.length} signature(s)`);

        let newCount = 0;
        for (const sigInfo of signatures) {
          if (this.processedSignatures.has(sigInfo.signature)) continue;
          if (sigInfo.err) continue;

          newCount++;
          console.log(
            `  🆕 Backfill: new signature ${sigInfo.signature} (slot=${sigInfo.slot})`
          );
          this.processedSignatures.add(sigInfo.signature);
          try {
            await this.processTransaction(sigInfo.signature, sigInfo.slot);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
              console.warn(`⚠️ Backfill: 429 rate limited processing ${sigInfo.signature}, will retry next cycle`);
              // Remove from processed so next backfill can retry
              this.processedSignatures.delete(sigInfo.signature);
            } else {
              console.error(`❌ Backfill: error processing ${sigInfo.signature}: ${errorMsg}`);
            }
          }
        }

        if (newCount === 0) {
          console.log(`  ✓ Backfill: no new signatures to process`);
        }

        this.trimProcessedSignatures();
      } catch (error) {
        console.error(
          `Backfill error: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    };

    void backfill();
    this.backfillIntervalId = setInterval(backfill, BACKFILL_INTERVAL_MS);
  }

  private trimProcessedSignatures() {
    if (this.processedSignatures.size <= MAX_PROCESSED_SIGNATURES) return;

    const excess = this.processedSignatures.size - MAX_PROCESSED_SIGNATURES;
    let removed = 0;
    for (const sig of this.processedSignatures) {
      if (removed >= excess) break;
      this.processedSignatures.delete(sig);
      removed++;
    }
  }

  private async handleSignBidirectional(event: SignBidirectionalEvent) {
    const namespace = getNamespaceFromCaip2(event.caip2Id);
    console.log(
      `🧾 SignBidirectional payload namespace=${namespace} caip2Id=${event.caip2Id} keyVersion=${event.keyVersion} path=${event.path} algo=${event.algo} dest=${event.dest} params=${event.params} sender=${event.sender.toString()}`
    );
    console.log(`🔗 CryptoUtils: deriveSigningKey for bidirectional...`);
    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );
    console.log(`✓ CryptoUtils: deriveSigningKey done`);

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
    const requestId = getRequestIdRespond({
      address: event.sender.toString(),
      payload: Array.from(event.payload),
      path: event.path,
      keyVersion: event.keyVersion,
      chainId: event.chainId,
      algo: event.algo,
      dest: event.dest,
      params: event.params,
    });

    console.log(`🔑 Request ID: ${requestId}`);

    console.log(`🔗 CryptoUtils: deriveSigningKey...`);
    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );
    console.log(`✓ CryptoUtils: deriveSigningKey done`);

    console.log(`🔗 CryptoUtils: signMessage...`);
    const signature = await CryptoUtils.signMessage(
      event.payload,
      derivedPrivateKey
    );
    console.log(`✓ CryptoUtils: signMessage done`);

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
    console.log(`🔗 Solana RPC: respond() (THIS CAN HANG)...`);
    const tx = await this.program.methods
      .respond([requestIdBytes], [signature])
      .accounts({
        responder: this.wallet.publicKey,
      })
      .rpc();
    console.log(`✓ Solana RPC: respond() done`);

    console.log(`✅ Signature sent! tx=${tx}`);
  }

  private getBidirectionalContext(): BidirectionalHandlerContext {
    return {
      program: this.program,
      wallet: this.wallet,
      config: this.config,
      pendingTransactions,
    };
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
    if (this.backfillIntervalId !== null) {
      clearInterval(this.backfillIntervalId);
      this.backfillIntervalId = null;
    }
    if (this.cpiSubscriptionId !== null) {
      console.log(`🔗 Solana RPC: removeOnLogsListener...`);
      await this.connection.removeOnLogsListener(this.cpiSubscriptionId);
      console.log(`✓ Solana RPC: removeOnLogsListener done`);
      this.cpiSubscriptionId = null;
    }
  }
}
