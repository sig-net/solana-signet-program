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
const DEFAULT_BACKFILL_BATCH_SIZE = 10;
const DEFAULT_BACKFILL_MAX_BATCH_SIZE = 100;
const MAX_PROCESSED_SIGNATURES = 1_000;
const MAX_SIGNATURE_RETRIES = 3;
const WS_STALE_THRESHOLD_MS = 15_000;
const WS_HEALTH_CHECK_INTERVAL_MS = 10_000;
const WS_RECONNECT_COOLDOWN_MS = 30_000;
// When WS is healthy, only run backfill every Nth cycle as a safety net
const BACKFILL_SKIP_FACTOR_WHEN_WS_HEALTHY = 6;

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
  private wsHealthCheckIntervalId: NodeJS.Timeout | null = null;
  private processedSignatures = new Set<string>();
  private failedSignatureRetries = new Map<string, number>();
  private cpiEventHandlers = new Map<
    string,
    (event: CpiEventData, slot: number) => Promise<void>
  >();
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private lastWebSocketEventTime = 0;
  private lastWsReconnectTime = 0;
  private backfillBatchSize: number;
  private backfillMaxBatchSize: number;
  private currentBackfillBatchSize: number;
  private backfillCycleCounter = 0;

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

    this.backfillBatchSize =
      this.config.backfillBatchSize ?? DEFAULT_BACKFILL_BATCH_SIZE;
    this.backfillMaxBatchSize =
      this.config.backfillMaxBatchSize ?? DEFAULT_BACKFILL_MAX_BATCH_SIZE;
    this.currentBackfillBatchSize = this.backfillBatchSize;

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

  private log(message: string, ...args: unknown[]) {
    if (this.config.verbose) {
      console.log(message, ...args);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number = CONFIG.RPC_TIMEOUT_MS
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Timeout: ${label} after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  private async ensureInitialized() {
    const [programStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('program-state')],
      this.program.programId
    );

    try {
      this.log(`🔗 Solana RPC: getAccountInfo for program state PDA...`);
      const accountInfo = await this.withTimeout(
        this.connection.getAccountInfo(programStatePda),
        'getAccountInfo'
      );
      this.log(`✓ Solana RPC: getAccountInfo done (exists=${!!accountInfo})`);
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
      this.log(`🔗 Solana RPC: program.initialize()...`);
      await this.withTimeout(
        this.program.methods
          .initialize(new BN(signatureDeposit), chainId)
          .accounts({
            admin: this.wallet.publicKey,
          })
          .rpc(),
        'program.initialize()'
      );
      this.log(`✓ Solana RPC: program.initialize() done`);
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

      if (pendingTransactions.size === 0) {
        return;
      }

      this.log(
        `📊 Transaction monitor poll #${this.pollCounter} (pending=${pendingTransactions.size})`
      );

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
          this.log(
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
          this.log(`  📋 Result for ${txHash}: ${result.status}`);

          txInfo.checkCount++;

          switch (result.status) {
            case 'pending':
              // Just increment count, continue polling
              break;

            case 'success':
              try {
                await this.handleCompletedTransaction(txHash, txInfo, {
                  success: result.success,
                  output: result.output,
                });
                pendingTransactions.delete(txHash);
              } catch (handlerError) {
                if (this.isUnrecoverableError(handlerError)) {
                  // TODO: removing without retry may reduce stability
                  console.error(
                    `⛔ Unrecoverable error in handleCompletedTransaction for ${txHash}, removing: ${
                      handlerError instanceof Error
                        ? handlerError.message
                        : String(handlerError)
                    }`
                  );
                  pendingTransactions.delete(txHash);
                } else {
                  console.warn(
                    `⚠️ Error in handleCompletedTransaction for ${txHash}, will retry: ${
                      handlerError instanceof Error
                        ? handlerError.message
                        : String(handlerError)
                    }`
                  );
                }
              }
              break;

            case 'error':
              // Only for reverted/replaced - send signed error
              try {
                await this.handleFailedTransaction(txHash, txInfo);
                pendingTransactions.delete(txHash);
              } catch (handlerError) {
                if (this.isUnrecoverableError(handlerError)) {
                  // TODO: removing without retry may reduce stability
                  console.error(
                    `⛔ Unrecoverable error in handleFailedTransaction for ${txHash}, removing: ${
                      handlerError instanceof Error
                        ? handlerError.message
                        : String(handlerError)
                    }`
                  );
                  pendingTransactions.delete(txHash);
                } else {
                  console.warn(
                    `⚠️ Error in handleFailedTransaction for ${txHash}, will retry: ${
                      handlerError instanceof Error
                        ? handlerError.message
                        : String(handlerError)
                    }`
                  );
                }
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
          txInfo.checkCount++;

          if (this.isUnrecoverableError(error)) {
            // TODO: removing without retry may reduce stability
            console.error(
              `⛔ Unrecoverable error polling ${txHash}, removing: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            pendingTransactions.delete(txHash);
          } else {
            console.warn(
              `⚠️ Error polling ${txHash}, will retry: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
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
    this.log(`🔗 OutputSerializer: serialize...`);
    const serializedOutput = await OutputSerializer.serialize(
      result.output,
      SerializationFormat.Borsh, // Server only respond to Solana for now
      txInfo.callbackSerializationSchema
    );
    this.log(
      `✓ OutputSerializer: serialize done (${serializedOutput.length} bytes)`
    );

    const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');
    this.log(`🔗 CryptoUtils: signBidirectionalResponse...`);
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey,
      txInfo.sender
    );
    this.log(`✓ CryptoUtils: signBidirectionalResponse done`);

    this.log(`🔗 Solana RPC: respondBidirectional() for ${txHash}...`);
    await this.withTimeout(
      this.program.methods
        .respondBidirectional(
          Array.from(requestIdBytes),
          Buffer.from(serializedOutput),
          signature
        )
        .accounts({
          responder: this.wallet.publicKey,
        })
        .rpc(),
      `respondBidirectional(${txHash})`
    );
    pendingTransactions.delete(txHash);
    console.log(`✓ Solana RPC: respondBidirectional() done for ${txHash}`);
  }

  private async handleFailedTransaction(
    txHash: string,
    txInfo: PendingTransaction
  ) {
    console.warn(`❌ Transaction failed: ${txHash}`);

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
    this.log(`🔗 CryptoUtils: signBidirectionalResponse (error response)...`);
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey,
      txInfo.sender
    );
    this.log(`✓ CryptoUtils: signBidirectionalResponse done`);

    this.log(`🔗 Solana RPC: respondBidirectional() error for ${txHash}...`);
    await this.withTimeout(
      this.program.methods
        .respondBidirectional(
          Array.from(requestIdBytes),
          Buffer.from(serializedOutput),
          signature
        )
        .accounts({
          responder: this.wallet.publicKey,
        })
        .rpc(),
      `respondBidirectional-error(${txHash})`
    );
    pendingTransactions.delete(txHash);
    console.log(
      `✓ Solana RPC: respondBidirectional() error done for ${txHash}`
    );
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
          // Always re-throw so caller can retry. Duplicates are harmless, missing txs are not.
          throw error;
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
          // Always re-throw so caller can retry. Duplicates are harmless, missing txs are not.
          throw error;
        }
      }
    );

    console.log('👂 Starting WebSocket subscription for program logs...');
    this.subscribeToLogs();
    this.startWebSocketHealthCheck();
  }

  private subscribeToLogs() {
    this.cpiSubscriptionId = this.connection.onLogs(
      this.program.programId,
      async (logs, context) => {
        this.lastWebSocketEventTime = Date.now();

        this.log(
          `📡 WebSocket received logs for signature: ${logs.signature} (slot=${context.slot})`
        );
        if (logs.err) {
          this.log(`  ⚠️ Skipping - transaction has error`);
          return;
        }
        if (this.processedSignatures.has(logs.signature)) {
          this.log(`  ⚠️ Skipping - already processed`);
          return;
        }

        this.processedSignatures.add(logs.signature);
        try {
          await this.processTransaction(logs.signature, context.slot);
          this.failedSignatureRetries.delete(logs.signature);
        } catch (error) {
          this.handleSignatureError(logs.signature, error);
        }
      },
      'confirmed'
    );
    console.log(
      `✅ WebSocket subscription active (id=${this.cpiSubscriptionId})`
    );
  }

  private startWebSocketHealthCheck() {
    this.wsHealthCheckIntervalId = setInterval(() => {
      if (this.lastWebSocketEventTime === 0) return;
      if (Date.now() - this.lastWsReconnectTime < WS_RECONNECT_COOLDOWN_MS) {
        return;
      }

      const staleDuration = Date.now() - this.lastWebSocketEventTime;
      if (staleDuration > WS_STALE_THRESHOLD_MS) {
        console.warn(
          `⚠️ WebSocket appears stale (no events for ${Math.round(staleDuration / 1000)}s), reconnecting...`
        );
        void this.reconnectWebSocket();
      }
    }, WS_HEALTH_CHECK_INTERVAL_MS);
  }

  private async reconnectWebSocket() {
    if (this.cpiSubscriptionId !== null) {
      try {
        await this.withTimeout(
          this.connection.removeOnLogsListener(this.cpiSubscriptionId),
          'removeOnLogsListener',
          5_000
        );
      } catch {
        console.warn(
          '⚠️ Failed to remove old WebSocket listener, proceeding with new subscription'
        );
      }
      this.cpiSubscriptionId = null;
    }

    this.subscribeToLogs();
    this.lastWebSocketEventTime = Date.now();
    this.lastWsReconnectTime = Date.now();
  }

  private async processTransaction(
    signature: string,
    slot: number
  ): Promise<void> {
    this.log(`🔎 Processing transaction: ${signature} (slot=${slot})`);
    const events = await this.withTimeout(
      CpiEventParser.parseCpiEvents(
        this.connection,
        signature,
        this.program.programId.toString(),
        this.program
      ),
      'parseCpiEvents'
    );

    this.log(`  📦 Parsed ${events.length} event(s) from transaction`);
    for (const event of events) {
      this.log(`  🎯 Event: ${event.name}`);
      const handler = this.cpiEventHandlers.get(event.name);
      if (handler) {
        await handler(event.data, slot);
      }
    }
  }

  private startBackfillMonitor() {
    console.log(
      `🔄 Starting backfill monitor (interval=${BACKFILL_INTERVAL_MS}ms, batch=${this.backfillBatchSize}, max=${this.backfillMaxBatchSize})`
    );
    const backfill = async () => {
      this.backfillCycleCounter++;

      // When WS is healthy, reduce backfill frequency instead of skipping entirely.
      // Backfill must always remain active as an independent safety net for
      // partial WS drops and failed retries.
      const wsHealthy =
        this.lastWebSocketEventTime > 0 &&
        Date.now() - this.lastWebSocketEventTime < WS_STALE_THRESHOLD_MS;
      if (
        wsHealthy &&
        this.backfillCycleCounter % BACKFILL_SKIP_FACTOR_WHEN_WS_HEALTHY !== 0
      ) {
        this.log('🔄 Backfill: skipping this cycle (WebSocket is healthy)');
        return;
      }

      this.log(
        `🔍 Backfill: polling for recent signatures (batch=${this.currentBackfillBatchSize}, processed=${this.processedSignatures.size})`
      );
      try {
        const signatures = await this.withTimeout(
          this.connection.getSignaturesForAddress(
            this.program.programId,
            { limit: this.currentBackfillBatchSize },
            'confirmed'
          ),
          'getSignaturesForAddress'
        );

        this.log(
          `  📋 Backfill: found ${signatures.length} signature(s)`,
          signatures.map((s) => ({
            sig: s.signature,
            slot: s.slot,
            status: this.processedSignatures.has(s.signature)
              ? 'processed'
              : 'pending',
          }))
        );

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
            this.failedSignatureRetries.delete(sigInfo.signature);
          } catch (error) {
            this.handleSignatureError(sigInfo.signature, error);
          }
        }

        // Dynamic batch sizing: scale up when finding new events, reset when quiet
        if (newCount > 0) {
          this.currentBackfillBatchSize = Math.min(
            this.currentBackfillBatchSize * 2,
            this.backfillMaxBatchSize
          );
        } else {
          this.currentBackfillBatchSize = this.backfillBatchSize;
          this.log(`  ✓ Backfill: no new signatures to process`);
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
      this.failedSignatureRetries.delete(sig);
      removed++;
    }
  }

  private isUnrecoverableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message;
    return (
      msg.includes('Missing request ID') ||
      msg.includes('custom program error') ||
      msg.includes('Modulus not supported') ||
      msg.includes('Failed to parse SOLANA_PRIVATE_KEY') ||
      msg.includes('Failed to load keypair')
    );
  }

  private handleSignatureError(signature: string, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Transient errors always retry without counting toward the cap
    if (!this.isUnrecoverableError(error)) {
      this.processedSignatures.delete(signature);
      console.warn(
        `⚠️ ${signature}: transient error, will retry (${errorMsg})`
      );
      return;
    }

    const retries = (this.failedSignatureRetries.get(signature) ?? 0) + 1;

    if (retries >= MAX_SIGNATURE_RETRIES) {
      this.failedSignatureRetries.delete(signature);
      console.warn(
        `⛔ ${signature}: giving up after ${retries} failed attempts (${errorMsg})`
      );
      return;
    }

    this.failedSignatureRetries.set(signature, retries);
    this.processedSignatures.delete(signature);
    console.warn(
      `⚠️ ${signature}: attempt ${retries}/${MAX_SIGNATURE_RETRIES} failed, will retry (${errorMsg})`
    );
  }

  private async handleSignBidirectional(event: SignBidirectionalEvent) {
    const namespace = getNamespaceFromCaip2(event.caip2Id);
    this.log(
      `🧾 SignBidirectional payload namespace=${namespace} caip2Id=${event.caip2Id} keyVersion=${event.keyVersion} path=${event.path} algo=${event.algo} dest=${event.dest} params=${event.params} sender=${event.sender.toString()}`
    );
    this.log(`🔗 CryptoUtils: deriveSigningKey for bidirectional...`);
    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );
    this.log(`✓ CryptoUtils: deriveSigningKey done`);

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

    this.log(`🔑 Request ID: ${requestId}`);

    this.log(`🔗 CryptoUtils: deriveSigningKey...`);
    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );
    this.log(`✓ CryptoUtils: deriveSigningKey done`);

    this.log(`🔗 CryptoUtils: signMessage...`);
    const signature = await CryptoUtils.signMessage(
      event.payload,
      derivedPrivateKey
    );
    this.log(`✓ CryptoUtils: signMessage done`);

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
    this.log(`🔗 Solana RPC: respond()...`);
    const tx = await this.withTimeout(
      this.program.methods
        .respond([requestIdBytes], [signature])
        .accounts({
          responder: this.wallet.publicKey,
        })
        .rpc(),
      'respond()'
    );
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
    if (this.wsHealthCheckIntervalId !== null) {
      clearInterval(this.wsHealthCheckIntervalId);
      this.wsHealthCheckIntervalId = null;
    }
    if (this.cpiSubscriptionId !== null) {
      this.log(`🔗 Solana RPC: removeOnLogsListener...`);
      await this.connection.removeOnLogsListener(this.cpiSubscriptionId);
      this.log(`✓ Solana RPC: removeOnLogsListener done`);
      this.cpiSubscriptionId = null;
    }
  }
}
