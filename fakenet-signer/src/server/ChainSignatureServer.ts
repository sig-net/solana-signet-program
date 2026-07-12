import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import BN from 'bn.js';
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
import {
  SubstrateBidirectionalRequest,
  SubstrateMonitor,
  SubstrateSignatureRequest,
} from '../modules/SubstrateMonitor';
import {
  MidnightMonitor,
  type MidnightSigningRequest,
} from '../modules/MidnightMonitor';

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
  private monitoring = false; // re-entrancy guard for the transaction monitor tick
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
  private lastBackfillSignature: string | undefined;
  private substrateMonitor: SubstrateMonitor | null = null;
  private midnightMonitor: MidnightMonitor | null = null;

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
    this.lastBackfillSignature = this.config.lastBackfillSignature;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    const solanaKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(this.config.solanaPrivateKey))
    );

    this.connection = new Connection(this.config.solanaRpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: async (input, init) => {
        const res = await globalThis.fetch(input, init);
        if (res.status === 429) {
          let method = 'unknown';
          try {
            const body = JSON.parse(init?.body as string);
            method = Array.isArray(body)
              ? body.map((r: { method: string }) => r.method).join(', ')
              : (body.method ?? 'unknown');
          } catch {
            /* best-effort parse */
          }
          console.warn(
            `\n[429 TRACE] RPC method: ${method}\n${new Error().stack}`
          );
        }
        return res;
      },
    });
    this.wallet = new anchor.Wallet(solanaKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });
    anchor.setProvider(this.provider);

    const idl = ChainSignaturesIDL as anchor.Idl;
    idl.address = this.config.programId;
    this.program = asChainSignaturesProgram(new Program(idl, this.provider));

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

        onRespondBidirectional: async (event: {
          requestId?: unknown;
          responder?: unknown;
        }) => {
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
    const unsignedTxBytes =
      this.midnightMonitor.buildSerializedTransaction(request);

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
    const signedTxHash = signedTx.hash;
    if (!signedTxHash) {
      throw new Error('Midnight: signed transaction has no hash');
    }

    console.log(`Midnight: Signed tx ${signedTxHash}`);
    console.log(`  Signing address: ${wallet.address}`);

    const requestIdHex = '0x' + Buffer.from(request.requestId).toString('hex');

    // Post the MPC signature on-chain to the signet contract
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
      explorerDeserializationSchema: Buffer.from(
        request.outputDeserializationSchema
      ),
      callbackSerializationSchema: Buffer.from(
        request.respondSerializationSchema
      ),
      fromAddress: wallet.address,
      nonce: Number(unsignedTx.nonce),
      checkCount: 0,
      namespace: request.caip2Id.split(':')[0] ?? 'eip155',
      prevouts: [],
      sender: request.predecessor,
      source: 'midnight',
    });

    console.log(
      `Midnight: Monitoring EVM tx ${signedTxHash} (client will broadcast)`
    );
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
      // Non-re-entrant: handling a confirmed tx posts a response on-chain,
      // which can take far longer than the poll interval (e.g. a Midnight
      // attestation proof + submit). Without this guard, overlapping ticks
      // re-check the same still-in-flight tx every interval — flooding the log
      // with duplicate output and wasting RPC calls. Skip a tick while the
      // previous one is still running (same reason MidnightMonitor.start does).
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
            break;

          case 'success': {
            const done = await this.executeWithRecovery(
              txHash,
              txInfo,
              () =>
                this.handleCompletedTransaction(txHash, txInfo, {
                  success: result.success,
                  output: result.output,
                }),
              'handleCompletedTransaction',
              true
            );
            if (done) pendingTransactions.delete(txHash);
            break;
          }

          case 'error': {
            // Reverted/replaced — send signed error back to the source chain
            const done = await this.executeWithRecovery(
              txHash,
              txInfo,
              () => this.handleFailedTransaction(txHash, txInfo),
              'handleFailedTransaction',
              false // circular — can't send error response for a failed error response
            );
            if (done) pendingTransactions.delete(txHash);
            break;
          }

          case 'fatal_error':
            console.error(
              `Fatal error for transaction ${txHash}: ${result.reason}`
            );
            await this.sendErrorResponse(txHash, txInfo);
            pendingTransactions.delete(txHash);
            break;
        }
      } catch (error) {
        txInfo.checkCount++;
        const done = await this.executeWithRecovery(
          txHash,
          txInfo,
          () => Promise.reject(error),
          'monitorPoll',
          true
        );
        if (done) pendingTransactions.delete(txHash);
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

    if (txInfo.source === 'midnight' && this.midnightMonitor) {
      // Midnight: Schnorr-attest the serialized output on-chain; the user
      // polls the signet contract and claims.
      const serializedOutput = await OutputSerializer.serialize(
        result.output,
        SerializationFormat.Midnight,
        txInfo.callbackSerializationSchema
      );
      await this.midnightMonitor.signAndBroadcastResponse(
        requestIdBytes,
        serializedOutput
      );
      console.log(`✓ Midnight: response posted for ${txHash}`);
      return;
    }

    this.log(`🔗 OutputSerializer: serialize...`);
    const serializedOutput = await OutputSerializer.serialize(
      result.output,
      SerializationFormat.Borsh,
      txInfo.callbackSerializationSchema
    );
    this.log(
      `✓ OutputSerializer: serialize done (${serializedOutput.length} bytes)`
    );

    this.log(`🔗 CryptoUtils: signBidirectionalResponse...`);
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey,
      txInfo.sender
    );
    this.log(`✓ CryptoUtils: signBidirectionalResponse done`);

    if (txInfo.source === 'polkadot' && this.substrateMonitor) {
      await this.substrateMonitor.sendRespondBidirectional(
        requestIdBytes,
        serializedOutput,
        signature
      );
      console.log('✅ Response sent to Substrate');
      return;
    }

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
    console.log(`✓ Solana RPC: respondBidirectional() done for ${txHash}`);
  }

  private async handleFailedTransaction(
    txHash: string,
    txInfo: PendingTransaction
  ) {
    console.warn(`❌ Transaction failed: ${txHash}`);

    const requestId = txInfo.requestId;
    if (!requestId) {
      throw new Error(`Missing request ID for tx ${txHash}`);
    }
    const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');

    const MAGIC_ERROR_PREFIX = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    if (txInfo.source === 'midnight' && this.midnightMonitor) {
      // Midnight: deadbeef prefix + serialized error using respond schema.
      // deadbeef in first 4 bytes makes claim() fail (byte 0 = 0xde != 0x01),
      // and a future refund() circuit can detect it via slice<4>(outputData, 0).
      const errorOutput = { success: false };
      const serializedError = await OutputSerializer.serialize(
        errorOutput,
        SerializationFormat.Midnight,
        txInfo.callbackSerializationSchema
      );
      const outputData = new Uint8Array(
        MAGIC_ERROR_PREFIX.length + serializedError.length
      );
      outputData.set(MAGIC_ERROR_PREFIX);
      outputData.set(serializedError, MAGIC_ERROR_PREFIX.length);
      await this.midnightMonitor.signAndBroadcastResponse(
        requestIdBytes,
        outputData
      );
      console.log(`✓ Midnight: error response posted for ${txHash}`);
      return;
    }

    const errorSchema = { struct: { error: 'bool' } };
    const borshData = borsh.serialize(errorSchema, { error: true });
    const errorData = Buffer.concat([MAGIC_ERROR_PREFIX, borshData]);

    const serializedOutput = new Uint8Array(errorData);

    this.log(`🔗 CryptoUtils: signBidirectionalResponse (error response)...`);
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey,
      txInfo.sender
    );
    this.log(`✓ CryptoUtils: signBidirectionalResponse done`);

    if (txInfo.source === 'polkadot' && this.substrateMonitor) {
      await this.substrateMonitor.sendRespondBidirectional(
        requestIdBytes,
        serializedOutput,
        signature
      );
      console.log('✅ Error response sent to Substrate');
      return;
    }

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
    console.log(
      `✓ Solana RPC: respondBidirectional() error done for ${txHash}`
    );
  }

  private setupEventListeners() {
    this.cpiEventHandlers.set(
      'signBidirectionalEvent',
      async (eventData: CpiEventData) => {
        if (!isSignBidirectionalEvent(eventData)) {
          console.error('Invalid event type for signBidirectionalEvent');
          return;
        }
        console.log(
          `📨 SignBidirectionalEvent from ${eventData.sender.toString()}`
        );
        await this.handleSignBidirectional(eventData);
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
        await this.handleSignatureRequest(eventData);
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

        await this.processSignatureWithRetry(logs.signature, context.slot);
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

  private async processSignatureWithRetry(
    signature: string,
    slot: number
  ): Promise<void> {
    this.processedSignatures.add(signature);
    try {
      await this.processTransaction(signature, slot);
      this.failedSignatureRetries.delete(signature);
    } catch (error) {
      this.handleSignatureError(signature, error);
    }
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
        try {
          await handler(event.data, slot);
        } catch (error) {
          console.error(
            `Error in ${event.name}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          throw error;
        }
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
        `🔍 Backfill: polling for recent signatures (batch=${this.currentBackfillBatchSize}, cursor=${this.lastBackfillSignature ?? 'none'}, processed=${this.processedSignatures.size})`
      );
      try {
        const signatures = await this.withTimeout(
          this.connection.getSignaturesForAddress(
            this.program.programId,
            {
              ...(this.lastBackfillSignature
                ? { until: this.lastBackfillSignature }
                : {}),
              limit: this.currentBackfillBatchSize,
            },
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

        // Advance cursor to newest signature so next cycle only fetches newer ones
        const newestSig = signatures[0];
        if (newestSig) {
          this.lastBackfillSignature = newestSig.signature;
        }

        let newCount = 0;
        for (const sigInfo of signatures) {
          if (this.processedSignatures.has(sigInfo.signature)) continue;
          if (sigInfo.err) continue;

          newCount++;
          console.log(
            `  🆕 Backfill: new signature ${sigInfo.signature} (slot=${sigInfo.slot})`
          );
          await this.processSignatureWithRetry(sigInfo.signature, sigInfo.slot);
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
      msg.includes('Failed to load keypair') ||
      msg.includes('insufficient funds') ||
      msg.includes('already been processed')
    );
  }

  private async sendErrorResponse(
    txHash: string,
    txInfo: PendingTransaction
  ): Promise<void> {
    try {
      await this.handleFailedTransaction(txHash, txInfo);
    } catch (error) {
      console.error(
        `⛔ Could not send error response for ${txHash}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Execute a monitor action with standardized error handling.
   * Returns true if the transaction should be removed from the pending map.
   */
  private async executeWithRecovery(
    txHash: string,
    txInfo: PendingTransaction,
    action: () => Promise<void>,
    label: string,
    sendErrorOnFailure: boolean
  ): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.isUnrecoverableError(error)) {
        console.error(
          `⛔ Unrecoverable error in ${label} for ${txHash}: ${errorMsg}`
        );
        if (sendErrorOnFailure) {
          await this.sendErrorResponse(txHash, txInfo);
        }
        return true;
      }
      console.warn(
        `⚠️ Error in ${label} for ${txHash}, will retry: ${errorMsg}`
      );
      return false;
    }
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
      sendSignatures: async (
        requestIds: Uint8Array[],
        signatures: SignatureResponse[],
        label: string
      ) => {
        const requestIdArrays = requestIds.map((id) => Array.from(id));
        return this.withTimeout(
          this.program.methods
            .respond(requestIdArrays, signatures)
            .accounts({
              responder: this.wallet.publicKey,
            })
            .rpc(),
          label
        );
      },
      config: this.config,
      pendingTransactions,
      source: 'solana',
    };
  }

  private getSubstrateBidirectionalContext(): BidirectionalHandlerContext {
    const substrateMonitor = this.substrateMonitor;
    if (!substrateMonitor) {
      throw new Error('Substrate monitor not configured');
    }
    return {
      sendSignatures: async (
        requestIds: Uint8Array[],
        signatures: SignatureResponse[],
        label: string
      ) => {
        for (let i = 0; i < requestIds.length; i++) {
          const requestId = requestIds[i];
          const signature = signatures[i];
          if (!requestId || !signature) continue;
          await this.withTimeout(
            substrateMonitor.sendSignatureResponse(requestId, signature),
            `${label}-substrate-${i}`
          );
        }
        return undefined;
      },
      config: this.config,
      pendingTransactions,
      source: 'polkadot',
    };
  }

  private async handleSubstrateSignatureRequest(
    event: SubstrateSignatureRequest
  ) {
    const substrateMonitor = this.substrateMonitor;
    if (!substrateMonitor) {
      throw new Error('Substrate monitor not configured');
    }
    const path = Buffer.from(event.path.slice(2), 'hex').toString();
    const algo = Buffer.from(event.algo.slice(2), 'hex').toString();
    const dest =
      event.dest === '0x'
        ? ''
        : Buffer.from(event.dest.slice(2), 'hex').toString();
    const params = Buffer.from(event.params.slice(2), 'hex').toString();
    const chainId = Buffer.from(event.chainId.slice(2), 'hex').toString();

    console.log({ path, algo, chainId, params: params || '(empty)' });

    const requestId = getRequestIdRespond({
      address: event.sender,
      payload: Array.from(event.payload),
      path,
      keyVersion: event.keyVersion,
      chainId,
      algo,
      dest,
      params,
    });

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

    await substrateMonitor.sendSignatureResponse(
      Buffer.from(requestId.slice(2), 'hex'),
      signature
    );

    console.log('✅ Signature sent to Substrate');
  }

  private async handleSubstrateBidirectional(
    event: SubstrateBidirectionalRequest
  ) {
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
