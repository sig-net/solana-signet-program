import type { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

export interface ServerConfig {
  rpcUrl: string;
  solanaPrivateKey: string;
  ethereumPrivateKey: string;
  infuraApiKey: string;
  sepoliaRpcUrl?: string;
  ethereumRpcUrl?: string;
  isDevnet: boolean;
}

export const serverConfigSchema = z.object({
  rpcUrl: z.string().url({ message: 'RPC URL must be a valid URL' }),
  solanaPrivateKey: z.string().min(1, 'Solana private key is required'),
  ethereumPrivateKey: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Ethereum private key must be a valid hex private key'),
  infuraApiKey: z.string().min(1, 'Infura API key is required'),
  sepoliaRpcUrl: z.string().url({ message: 'Sepolia RPC URL must be a valid URL' }).optional(),
  ethereumRpcUrl: z.string().url({ message: 'Ethereum RPC URL must be a valid URL' }).optional(),
  isDevnet: z.boolean(),
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
}

export interface TransactionOutput {
  success: boolean;
  output: Record<string, unknown>;
}

export type TransactionStatus =
  | { status: 'pending' }
  | { status: 'success'; success: boolean; output: Record<string, unknown> }
  | { status: 'error'; reason: string }
  | { status: 'fatal_error'; reason: string };

export interface SignatureResponse {
  bigR: { x: number[]; y: number[] };
  s: number[];
  recoveryId: number;
}

export interface ProcessedTransaction {
  unsignedTxHash: string;
  signedTxHash: string;
  signature: SignatureResponse;
  signedTransaction: string;
  fromAddress: string;
  nonce: number;
}
