import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import BN from 'bn.js';
import pino from 'pino';
import * as bitcoin from 'bitcoinjs-lib';
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
import ChainSignaturesIDL from '../../idl/chain_signatures.json';
import { CryptoUtils } from '../modules/CryptoUtils';
import { CONFIG } from '../config/Config';
import { RequestIdGenerator } from '../modules/RequestIdGenerator';
import { TransactionProcessor } from '../modules/TransactionProcessor';
import { EthereumMonitor } from '../modules/EthereumMonitor';
import { BitcoinTransactionProcessor } from '../modules/BitcoinTransactionProcessor';
import { BitcoinMonitor } from '../modules/BitcoinMonitor';
import { OutputSerializer } from '../modules/OutputSerializer';
import { CpiEventParser } from '../events/CpiEventParser';
import * as borsh from 'borsh';
import {
  SerializationFormat,
  getNamespaceFromCaip2,
} from '../modules/ChainUtils';

const pendingTransactions = new Map<string, PendingTransaction>();

export class ChainSignatureServer {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;
  private program: Program;
  private pollCounter = 0;
  private cpiSubscriptionId: number | null = null;
  private config: ServerConfig;
  private logger: pino.Logger;
  private monitorIntervalId: NodeJS.Timeout | null = null;

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

    this.logger = pino({
      enabled: this.config.verbose === true,
      level: 'info',
      serializers: {
        error: pino.stdSerializers.err,
      },
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
  }

  async start() {
    this.logger.info('🚀 Response Server');
    this.logger.info({ wallet: this.wallet.publicKey.toString() }, 'Wallet');
    this.logger.info({ program: this.program.programId.toString() }, 'Program');

    await this.ensureInitialized();

    this.startTransactionMonitor();
    this.setupEventListeners();
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
      this.pollCounter++;

      if (pendingTransactions.size > 0 && this.pollCounter % 12 === 1) {
        this.logger.info(
          { count: pendingTransactions.size },
          '📊 Monitoring pending transactions'
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
                  txInfo.caip2Id,
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
                success: result.success!,
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
              this.logger.error(
                { txHash, reason: result.reason },
                'Fatal error for transaction'
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
            this.logger.error(
              { txHash, error: error.message },
              'Infrastructure error'
            );
            pendingTransactions.delete(txHash);
          } else {
            this.logger.error(
              {
                txHash,
                error,
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              },
              'Unexpected error polling'
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
    this.logger.info({ txHash }, '✅ Transaction completed');

    const serializedOutput = await OutputSerializer.serialize(
      result.output,
      SerializationFormat.Borsh, // Server only respond to Solana for now
      txInfo.callbackSerializationSchema
    );

    const requestIdBytes = Buffer.from(txInfo.requestId.slice(2), 'hex');
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.mpcRootKey
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
      this.logger.error(
        {
          error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          txHash,
        },
        'Error sending response'
      );
    }
  }

  private async handleFailedTransaction(
    txHash: string,
    txInfo: PendingTransaction
  ) {
    this.logger.warn({ txHash }, '❌ Transaction failed');

    try {
      const MAGIC_ERROR_PREFIX = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

      const errorSchema = { struct: { error: 'bool' } };
      const borshData = borsh.serialize(errorSchema, { error: true });
      const errorData = Buffer.concat([MAGIC_ERROR_PREFIX, borshData]);

      const serializedOutput = new Uint8Array(errorData);

      const requestIdBytes = Buffer.from(txInfo.requestId.slice(2), 'hex');
      const signature = await CryptoUtils.signBidirectionalResponse(
        requestIdBytes,
        serializedOutput,
        this.config.mpcRootKey
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
      this.logger.error(
        {
          error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          txHash,
        },
        'Error sending error response'
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
          this.logger.error('Invalid event type for signBidirectionalEvent');
          return;
        }

        this.logger.info(
          { sender: eventData.sender.toString() },
          '📨 SignBidirectionalEvent'
        );

        try {
          await this.handleSignBidirectional(eventData);
        } catch (error) {
          this.logger.error(
            {
              error,
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            'Error processing bidirectional'
          );
        }
      }
    );

    cpiEventHandlers.set(
      'signatureRequestedEvent',
      async (eventData: CpiEventData) => {
        if (!isSignatureRequestedEvent(eventData)) {
          this.logger.error('Invalid event type for signatureRequestedEvent');
          return;
        }

        this.logger.info(
          { sender: eventData.sender.toString() },
          '📝 SignatureRequestedEvent'
        );

        try {
          await this.handleSignatureRequest(eventData);
        } catch (error) {
          this.logger.error(
            {
              error,
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            'Error sending signature'
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

    // For Bitcoin, extract canonical txid (without witness) from PSBT
    // For EVM, use full transaction data
    let transactionData: number[];

    if (namespace === 'bip122') {
      this.logger.info('🔍 Bitcoin transaction detected');
      this.logger.info(
        {
          psbtBytesLength: event.serializedTransaction.length,
          caip2Id: event.caip2Id,
        },
        '📦 PSBT received'
      );

      // Bitcoin: Extract txid from PSBT (canonical, excludes witness)
      const psbt = bitcoin.Psbt.fromBuffer(
        Buffer.from(event.serializedTransaction)
      );
      this.logger.info(
        {
          inputCount: psbt.data.inputs.length,
          outputCount: psbt.data.outputs.length,
        },
        '✅ PSBT parsed successfully'
      );

      // Access unsigned transaction from PSBT cache
      // extractTransaction() requires finalized PSBT, so we use __CACHE.__TX
      // This works for P2WPKH (SegWit) because TXID is stable before signing
      const tx = (psbt as any).__CACHE.__TX;

      // Calculate txid
      // IMPORTANT: bitcoinjs-lib's getId() returns DISPLAY format (reversed for humans)
      // Rust's txid() returns INTERNAL format (raw hash output)
      // For requestId calculation, we MUST use INTERNAL format to match Rust!
      const txidDisplay = tx.getId(); // Display format (what block explorers show)
      const txidInternal = Buffer.from(txidDisplay, 'hex').reverse(); // Convert to internal format

      // Use INTERNAL format for requestId calculation (to match Rust)
      transactionData = Array.from(txidInternal);

      this.logger.info(
        {
          txidDisplay,
          txidInternal: txidInternal.toString('hex'),
          txidDisplayBytes: Array.from(Buffer.from(txidDisplay, 'hex')),
          txidInternalBytes: Array.from(txidInternal),
          format: 'INTERNAL (reversed from display) - matches Rust txid()',
          calculation: 'doubleSHA256(serialize_without_witness(tx))',
          displayCalculation: 'getId() = reverse(doubleSHA256(...))',
          usingForRequestId: 'INTERNAL format (non-reversed hash output)',
          sender: event.sender.toString(),
          path: event.path,
        },
        '🔐 Bitcoin txid calculated (UNSIGNED - for requestId)'
      );
    } else {
      // EVM: Use full transaction data
      transactionData = Array.from(event.serializedTransaction);
      this.logger.info(
        { txDataLength: transactionData.length },
        '📝 EVM transaction data'
      );
    }

    const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
      event.sender.toString(),
      transactionData,
      event.caip2Id,
      event.keyVersion,
      event.path,
      event.algo,
      event.dest,
      event.params
    );

    this.logger.info({ requestId, namespace }, '🔑 Request ID');

    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.mpcRootKey
    );

    let result;

    if (namespace === 'bip122') {
      this.logger.info('Processing Bitcoin transaction (P2WPKH)');

      // Store unsigned txid (internal format) for comparison
      const unsignedTxidInternal = Buffer.from(transactionData).toString('hex');
      const unsignedTxidDisplay = Buffer.from(transactionData).reverse().toString('hex');

      result = await BitcoinTransactionProcessor.processTransactionForSigning(
        new Uint8Array(event.serializedTransaction),
        derivedPrivateKey,
        event.caip2Id,
        this.config
      );

      // result.signedTxHash is in DISPLAY format (from BitcoinTransactionProcessor)
      // Convert it to internal format for comparison
      const signedTxidDisplay = result.signedTxHash;
      const signedTxidInternal = Buffer.from(signedTxidDisplay, 'hex').reverse().toString('hex');

      // Verify txid stability (SegWit property) - compare INTERNAL formats
      const txidsMatch = unsignedTxidInternal === signedTxidInternal;
      this.logger.info(
        {
          unsignedTxidDisplay,
          unsignedTxidInternal,
          signedTxidDisplay,
          signedTxidInternal,
          txidsMatch,
          segwitProperty: 'P2WPKH txid is stable (same before/after signing)',
          note: 'Both internal formats must match for SegWit',
        },
        '🔐 Bitcoin txid verification (SIGNED vs UNSIGNED)'
      );

      this.logger.info('📝 Bitcoin transaction signed - client will broadcast');
    } else {
      this.logger.info('Processing EVM transaction');

      result = await TransactionProcessor.processTransactionForSigning(
        new Uint8Array(event.serializedTransaction),
        derivedPrivateKey,
        event.caip2Id,
        this.config
      );

      this.logger.info('📝 EVM transaction signed - client will broadcast');
    }

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
    const tx = await this.program.methods
      .respond([requestIdBytes], result.signature) // result.signature is already an array
      .accounts({
        responder: this.wallet.publicKey,
      })
      .rpc();

    this.logger.info({ tx, namespace }, '✅ Signatures sent to contract');

    pendingTransactions.set(result.signedTxHash, {
      txHash: result.signedTxHash,
      requestId,
      caip2Id: event.caip2Id,
      explorerDeserializationSchema: event.outputDeserializationSchema,
      callbackSerializationSchema: event.respondSerializationSchema,
      sender: event.sender.toString(),
      path: event.path,
      fromAddress: result.fromAddress,
      nonce: result.nonce,
      checkCount: 0,
      namespace,
    });

    this.logger.info(
      { txHash: result.signedTxHash, namespace },
      '🔍 Monitoring transaction (waiting for client broadcast)'
    );
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

    this.logger.info({ requestId }, '🔑 Request ID');

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

    this.logger.info({ tx }, '✅ Signature sent!');
  }

  async shutdown() {
    this.logger.info('🛑 Shutting down...');
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
