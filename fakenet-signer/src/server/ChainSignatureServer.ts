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
import { RequestIdGenerator } from '../modules/RequestIdGenerator';
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

export class ChainSignatureServer {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;
  private program: ChainSignaturesProgram;
  private pollCounter = 0;
  private cpiSubscriptionId: number | null = null;
  private config: ServerConfig;
  private monitorIntervalId: NodeJS.Timeout | null = null;
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

    this.connection = new Connection(this.config.solanaRpcUrl, 'confirmed');
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

    // Resolve readiness so callers can await server.waitUntilReady()
    this.resolveReady?.();
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

    const signatureDeposit = this.config.signatureDeposit || '10000000';
    const chainId = this.config.chainId || 'solana:localnet';

    try {
      await this.program.methods
        .initialize(new BN(signatureDeposit), chainId)
        .accounts({
          admin: this.wallet.publicKey,
        })
        .rpc();
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
    this.monitorIntervalId = setInterval(async () => {
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
    const serializedOutput = await OutputSerializer.serialize(
      result.output,
      SerializationFormat.Borsh, // Server only respond to Solana for now
      txInfo.callbackSerializationSchema
    );

    const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey,
      txInfo.sender
    );

    try {
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
      const signature = await CryptoUtils.signBidirectionalResponse(
        requestIdBytes,
        serializedOutput,
        this.config.mpcRootKey,
        txInfo.sender
      );

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
    if (this.cpiSubscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.cpiSubscriptionId);
      this.cpiSubscriptionId = null;
    }
  }
}
