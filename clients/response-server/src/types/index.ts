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

export interface PendingTransaction {
  txHash: string;
  requestId: string;
  caip2Id: string;
  explorerDeserializationSchema: Buffer | number[];
  callbackSerializationSchema: Buffer | number[];
  sender: string;
  path: string;
  fromAddress: string;
  nonce: number;
  checkCount: number;
  namespace: string;
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

// Bitcoin outputs are just boolean success values
// EVM outputs are objects with decoded data
export type TransactionOutputData =
  | boolean
  | { [key: string]: SerializableValue };

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
