import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

export type BitcoinNetwork = 'regtest' | 'testnet';

export interface ServerConfig {
  solanaRpcUrl: string;
  solanaPrivateKey: string;
  mpcRootKey: string;
  infuraApiKey: string;
  programId: string;
  isDevnet: boolean;
  signatureDeposit?: string;
  chainId?: string;
  verbose?: boolean;
  bitcoinNetwork: BitcoinNetwork;
  backfillBatchSize?: number;
  backfillMaxBatchSize?: number;
  lastBackfillSignature?: string;
}

export const serverConfigSchema = z.object({
  solanaRpcUrl: z.string().min(1, 'Solana RPC URL is required'),
  solanaPrivateKey: z.string().min(1, 'Solana private key is required'),
  mpcRootKey: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{64}$/,
      'MPC root key must be a valid hex private key'
    ),
  infuraApiKey: z.string().min(1, 'Infura API key is required'),
  programId: z.string().refine((val) => {
    try {
      new PublicKey(val);
      return true;
    } catch {
      return false;
    }
  }, 'Must be a valid Solana public key'),
  isDevnet: z.boolean(),
  signatureDeposit: z.string().optional(),
  chainId: z.string().optional(),
  verbose: z.boolean().optional(),
  bitcoinNetwork: z.enum(['regtest', 'testnet']),
  backfillBatchSize: z.number().int().positive().optional(),
  backfillMaxBatchSize: z.number().int().positive().optional(),
  lastBackfillSignature: z.string().optional(),
});

export interface SignBidirectionalEvent {
  sender: PublicKey;
  serializedTransaction: Buffer;
  caip2Id: string;
  keyVersion: number;
  deposit: bigint;
  path: string;
  algo: string;
  dest: string;
  params: string;
  outputDeserializationSchema: Buffer;
  respondSerializationSchema: Buffer;
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
 * plus the serialization schemas required to format the final callback payload.
 */
export interface PendingTransaction {
  /** Canonical transaction hash on the destination chain (txid for Bitcoin). */
  txHash: string;

  /** Deterministic request identifier that the Solana contract expects. */
  requestId: string;

  /** CAIP-2 chain identifier (e.g. `eip155:1`, `bip122:000000...`). */
  caip2Id: string;

  /** Schema emitted on-chain describing how to decode explorer outputs. */
  explorerDeserializationSchema: Buffer | number[];

  /** Schema to re-encode the callback payload for `respondBidirectional`. */
  callbackSerializationSchema: Buffer | number[];

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
