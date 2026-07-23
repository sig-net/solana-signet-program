import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

export type BitcoinNetwork = 'regtest' | 'testnet';

export interface ServerConfig {
  /** Skip the entire Solana leg (no connection, listeners, or backfill). */
  disableSolana?: boolean;
  solanaRpcUrl: string;
  solanaPrivateKey?: string;
  mpcRootKey: string;
  // The EVM endpoint e.g.:
  // - a local dev node: http://127.0.0.1:8545
  // - sepolia via infura: https://sepolia.infura.io/v3/<api-key-here>
  evmRpcUrl: string;
  programId?: string;
  isDevnet: boolean;
  signatureDeposit?: string;
  chainId?: string;
  verbose?: boolean;
  bitcoinNetwork: BitcoinNetwork;
  backfillBatchSize?: number;
  backfillMaxBatchSize?: number;
  lastBackfillSignature?: string;
  substrateWsUrl?: string;
  // Midnight config
  midnightNetworkId?: string;
  midnightIndexerUrl?: string;
  midnightIndexerWsUrl?: string;
  midnightNodeUrl?: string;
  midnightProofServerUrl?: string;
  midnightSignetContractAddress?: string;
  midnightWalletSeed?: string;
}

export const serverConfigSchema = z
  .object({
    disableSolana: z.boolean().optional(),
    solanaRpcUrl: z.string().min(1, 'Solana RPC URL is required'),
    solanaPrivateKey: z.string().optional(),
    mpcRootKey: z
      .string()
      .regex(
        /^0x[a-fA-F0-9]{64}$/,
        'MPC root key must be a valid hex private key'
      ),
    evmRpcUrl: z.string().min(1, 'EVM RPC URL is required'),
    programId: z
      .string()
      .refine((val) => {
        try {
          new PublicKey(val);
          return true;
        } catch {
          return false;
        }
      }, 'Must be a valid Solana public key')
      .optional(),
    isDevnet: z.boolean(),
    signatureDeposit: z.string().optional(),
    chainId: z.string().optional(),
    verbose: z.boolean().optional(),
    bitcoinNetwork: z.enum(['regtest', 'testnet']),
    backfillBatchSize: z.number().int().positive().optional(),
    backfillMaxBatchSize: z.number().int().positive().optional(),
    lastBackfillSignature: z.string().optional(),
    substrateWsUrl: z.string().optional(),
    // Midnight config
    midnightNetworkId: z.string().optional(),
    midnightIndexerUrl: z.string().optional(),
    midnightIndexerWsUrl: z.string().optional(),
    midnightNodeUrl: z.string().optional(),
    midnightProofServerUrl: z.string().optional(),
    midnightSignetContractAddress: z.string().optional(),
    midnightWalletSeed: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.disableSolana) {
      if (!config.solanaPrivateKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['solanaPrivateKey'],
          message: 'Solana private key is required',
        });
      }
      if (!config.programId) {
        ctx.addIssue({
          code: 'custom',
          path: ['programId'],
          message: 'Program ID is required',
        });
      }
    }
  });

export interface SignBidirectionalEvent {
  sender: PublicKey | string;
  serializedTransaction: Buffer | Uint8Array;
  caip2Id: string;
  keyVersion: number;
  deposit?: bigint | string;
  path: string;
  algo: string;
  dest: string;
  params: string;
  outputDeserializationSchema: Buffer | Uint8Array;
  respondSerializationSchema: Buffer | Uint8Array;
}

export interface SignatureRequestedEvent {
  sender: PublicKey;
  payload: number[];
  keyVersion: number;
  deposit: bigint;
  chainId: string;
  path: string;
  algo: string;
  dest: string;
  params: string;
  feePayer: PublicKey | null;
}

export interface PrevoutRef {
  txid: string;
  vout: number;
}

/**
 * Bookkeeping for any cross-chain transaction we are still monitoring.
 *
 * Each entry is added immediately after the server hands signatures back to the
 * requester, and removed once the monitor emits either a success/failure
 * response. Fields mirror the data needed by `BitcoinMonitor`/`EthereumMonitor`
 * plus the schemas required to decode the output and format the respond payload.
 */
export interface PendingTransaction {
  /** Canonical transaction hash on the destination chain (txid for Bitcoin). */
  txHash: string;

  /** Deterministic request identifier that the Solana contract expects. */
  requestId: string;

  /** CAIP-2 chain identifier (e.g. `eip155:1`, `bip122:000000...`). */
  caip2Id: string;

  /**
   * Schema for decoding the executed transaction's output, carried verbatim
   * from `SignBidirectionalEvent.outputDeserializationSchema` (the MPC's
   * `BidirectionalTx.output_deserialization_schema`). Only the schema is
   * carried, never a format: the format follows from the destination chain
   * the signed transaction is submitted to (ABI for EVM).
   */
  outputDeserializationSchema: Buffer | number[];

  /**
   * Schema for re-encoding the decoded output into the respond payload,
   * carried verbatim from `SignBidirectionalEvent.respondSerializationSchema`
   * (the MPC's `BidirectionalTx.respond_serialization_schema`). Only the
   * schema is carried, never a format: the format follows from the source
   * chain the request came from, which is where the response is posted
   * (Borsh for Solana and Substrate, Midnight format for Midnight).
   */
  respondSerializationSchema: Buffer | number[];

  /** Address that broadcast the transaction (EVM sender or `bitcoin`). */
  fromAddress: string;

  /** Nonce used for the EVM transaction (0 for Bitcoin). */
  nonce: number;

  /** Number of poll attempts already performed; drives backoff. */
  checkCount: number;

  /** Chain namespace derived from CAIP-2 (e.g. `eip155`, `bip122`). */
  namespace: string;

  /**
   * Previous outputs consumed by the transaction. Required field; use an empty
   * array for non-UTXO chains. Bitcoin relies on these to detect double-spends
   * before confirmation.
   */
  prevouts: PrevoutRef[];

  sender: string;

  /** Input indices already submitted to Solana (Bitcoin PSBT only). */
  submittedInputs?: Set<number>;

  /** Chain the request originated from; responses are routed back to it. */
  source: 'solana' | 'polkadot' | 'midnight';
}

// Borsh schema types
export interface BorshStructField {
  [key: string]: string;
}

export interface BorshSchema {
  struct?: BorshStructField;
  enum?: Array<{ [key: string]: BorshStructField | string }>;
}

// ABI schema types
export interface AbiSchemaField {
  name: string;
  type: string;
}

// Midnight schema field — extends ABI field with size hints for dynamic types
export interface MidnightSchemaField {
  name: string;
  type: string;
  maxBytes?: number;
  maxItems?: number;
}

// Serialization output types
export type SerializableValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | SerializableValue[]
  | { [key: string]: SerializableValue };

// Monitor outputs always return structured objects so serializers can apply
// either Borsh or ABI schemas consistently across chains.
export type TransactionOutputData = { [key: string]: SerializableValue };

export interface TransactionOutput {
  success: boolean;
  output: TransactionOutputData;
}

export type TransactionStatus =
  | { status: 'pending' }
  | { status: 'success'; success: boolean; output: TransactionOutputData }
  | { status: 'error'; reason: string }
  | { status: 'fatal_error'; reason: string };

export interface SignatureResponse {
  bigR: { x: number[]; y: number[] };
  s: number[];
  recoveryId: number;
}

export interface ProcessedTransaction {
  signedTxHash: string;
  signature: SignatureResponse[]; // Array to support multiple inputs (e.g., Bitcoin PSBTs)
  signedTransaction: string;
  fromAddress: string;
  nonce: number;
}

// CPI Event data types - union of all possible event data
export type CpiEventData = SignBidirectionalEvent | SignatureRequestedEvent;

// Type guard functions
export function isSignBidirectionalEvent(
  event: CpiEventData
): event is SignBidirectionalEvent {
  return 'serializedTransaction' in event && 'caip2Id' in event;
}

export function isSignatureRequestedEvent(
  event: CpiEventData
): event is SignatureRequestedEvent {
  return 'payload' in event && 'chainId' in event;
}
