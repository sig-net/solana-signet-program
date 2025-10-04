import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import type {
  SignBidirectionalEvent,
  SignatureRequestedEvent,
  PendingTransaction,
  TransactionOutput,
  ServerConfig,
} from './types';
import { serverConfigSchema } from './types';
import ChainSignaturesIDL from './idl/chain_signatures.json';
import { CryptoUtils } from './crypto-utils';
import { CONFIG } from './config';
import { RequestIdGenerator } from './request-id-generator';
import { TransactionProcessor } from './transaction-processor';
import { EthereumMonitor } from './ethereum-monitor';
import { OutputSerializer } from './output-serializer';
import { CpiEventParser } from './cpi-event-parser';
import * as borsh from 'borsh';
import { SerializationFormat } from './chain-utils';

const pendingTransactions = new Map<string, PendingTransaction>();

class ChainSignatureServer {
  private connection: Connection;
  private wallet: anchor.Wallet;
  private provider: anchor.AnchorProvider;
  private program: Program;
  private pollCounter = 0;
  private cpiSubscriptionId: number | null = null;
  private config: ServerConfig;

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

    const solanaKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(this.config.solanaPrivateKey))
    );

    this.connection = new Connection(this.config.rpcUrl, 'confirmed');
    this.wallet = new anchor.Wallet(solanaKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });
    anchor.setProvider(this.provider);

    this.program = new Program(ChainSignaturesIDL as anchor.Idl, this.provider);
  }

  async start() {
    console.log('🚀 Response Server');
    console.log('  Wallet:', this.wallet.publicKey.toString());
    console.log('  Program:', this.program.programId.toString());

    this.startTransactionMonitor();
    this.setupEventListeners();
  }

  private startTransactionMonitor() {
    setInterval(async () => {
      this.pollCounter++;

      if (pendingTransactions.size > 0 && this.pollCounter % 12 === 1) {
        console.log(
          `\n📊 Monitoring ${pendingTransactions.size} pending transaction(s)...`
        );
      }

      for (const [txHash, txInfo] of pendingTransactions.entries()) {
        // CHANGE 4: Exponential backoff - check less frequently as time passes
        if (txInfo.checkCount > 0) {
          // Skip checks based on how many times we've already checked
          // 0-5 checks: every 5s
          // 6-10 checks: every 10s
          // 11-20 checks: every 30s
          // 20+ checks: every 60s
          let skipFactor = 1;
          if (txInfo.checkCount > 20) skipFactor = 12;
          else if (txInfo.checkCount > 10) skipFactor = 6;
          else if (txInfo.checkCount > 5) skipFactor = 2;

          if (this.pollCounter % skipFactor !== 0) {
            continue; // Skip this check
          }
        }

        try {
          const result = await EthereumMonitor.waitForTransactionAndGetOutput(
            txHash,
            txInfo.caip2Id,
            txInfo.explorerDeserializationSchema,
            txInfo.fromAddress,
            txInfo.nonce,
            this.config
          );

          // Increment check count
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
              console.error(`Fatal error for ${txHash}:`, result.reason);
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
            console.error(`Infrastructure error for ${txHash}:`, error.message);
            pendingTransactions.delete(txHash);
          } else {
            console.error(`Unexpected error polling ${txHash}:`, error);
            txInfo.checkCount++; // Still increment count
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

    const serializedOutput = await OutputSerializer.serialize(
      result.output,
      SerializationFormat.Borsh, // Server only respond to Solana for now
      txInfo.callbackSerializationSchema
    );

    const requestIdBytes = Buffer.from(txInfo.requestId.slice(2), 'hex');
    const signature = await CryptoUtils.signBidirectionalResponse(
      requestIdBytes,
      serializedOutput,
      this.config.ethereumPrivateKey
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
      console.error('Error sending response:', error);
    }
  }

  private async handleFailedTransaction(
    txHash: string,
    txInfo: PendingTransaction
  ) {
    console.log(`❌ Transaction failed: ${txHash}`);

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
        this.config.ethereumPrivateKey
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
      console.error('Error sending error response:', error);
    }
  }

  private setupEventListeners() {
    // CPI event listener for SignatureRequestedEvent only
    const cpiEventHandlers = new Map<
      string,
      (event: unknown, slot: number) => Promise<void>
    >();

    // Standard event listeners for non-CPI events
    cpiEventHandlers.set(
      'signBidirectionalEvent',
      async (eventData: unknown, _slot: number) => {
        const event = eventData as SignBidirectionalEvent;
        console.log(
          `\n📨 SignBidirectionalEvent from ${event.sender.toString()}`
        );

        try {
          await this.handleSignBidirectional(event);
        } catch (error) {
          console.error('Error processing bidirectional:', error);
        }
      }
    );

    // Note: Anchor's BorshEventCoder returns event names in camelCase
    cpiEventHandlers.set(
      'signatureRequestedEvent',
      async (eventData: unknown) => {
        const event = eventData as SignatureRequestedEvent;
        console.log(
          `\n📝 SignatureRequestedEvent from ${event.sender.toString()}`
        );

        try {
          await this.handleSignatureRequest(event);
        } catch (error) {
          console.error('Error sending signature:', error);
        }
      }
    );

    // Subscribe to CPI events
    this.cpiSubscriptionId = CpiEventParser.subscribeToCpiEvents(
      this.connection,
      this.program,
      cpiEventHandlers
    );

    // Standard event listener for RespondBidirectionalEvent
    // Note: addEventListener is not used for CPI events, they're parsed manually
    // This is just for logging non-CPI RespondBidirectionalEvent if it exists
  }

  private async handleSignBidirectional(event: SignBidirectionalEvent) {
    const requestId = RequestIdGenerator.generateSignRespondRequestId(
      event.sender.toString(),
      Array.from(event.serializedTransaction),
      event.caip2Id,
      event.keyVersion,
      event.path,
      event.algo,
      event.dest,
      event.params
    );

    console.log('  🔑 Request ID:', requestId);

    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.ethereumPrivateKey
    );

    const result = await TransactionProcessor.processTransactionForSigning(
      new Uint8Array(event.serializedTransaction),
      derivedPrivateKey,
      event.caip2Id,
      this.config
    );

    const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
    await this.program.methods
      .respond([requestIdBytes], [result.signature])
      .accounts({
        responder: this.wallet.publicKey,
      })
      .rpc();

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
    });

    console.log(`🔍 Monitoring transaction: ${result.signedTxHash}`);
  }

  private async handleSignatureRequest(event: SignatureRequestedEvent) {
    const requestId = RequestIdGenerator.generateRequestId(
      event.sender.toString(),
      Array.from(event.payload),
      event.path,
      event.keyVersion,
      0,
      event.algo,
      event.dest,
      event.params
    );

    console.log('  🔑 Request ID:', requestId);

    const derivedPrivateKey = await CryptoUtils.deriveSigningKey(
      event.path,
      event.sender.toString(),
      this.config.ethereumPrivateKey
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

    console.log('  ✅ Signature sent!');
    console.log('  🔗 Solana tx:', tx);
  }

  async shutdown() {
    console.log('\n🛑 Shutting down...');
    if (this.cpiSubscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.cpiSubscriptionId);
    }
    process.exit(0);
  }
}

async function main() {
  const { envConfig } = await import('./envConfig');

  const config: ServerConfig = {
    rpcUrl: envConfig.RPC_URL,
    solanaPrivateKey: envConfig.SOLANA_PRIVATE_KEY,
    ethereumPrivateKey: envConfig.PRIVATE_KEY_TESTNET,
    infuraApiKey: envConfig.INFURA_API_KEY,
    sepoliaRpcUrl: envConfig.SEPOLIA_RPC_URL,
    ethereumRpcUrl: envConfig.ETHEREUM_RPC_URL,
    isDevnet: envConfig.RPC_URL.includes('devnet'),
  };

  const server = new ChainSignatureServer(config);
  await server.start();

  process.on('SIGINT', async () => {
    await server.shutdown();
  });
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
