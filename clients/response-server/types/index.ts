import type { PublicKey } from '@solana/web3.js';

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
  chainId: number;
  explorerDeserializationFormat: number;
  explorerDeserializationSchema: Buffer | number[];
  callbackSerializationFormat: number;
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

export interface ProcessedTransaction {
  unsignedTxHash: string;
  signedTxHash: string;
  signature: {
    bigR: { x: number[]; y: number[] };
    s: number[];
    recoveryId: number;
  };
  signedTransaction: string;
  fromAddress: string;
  nonce: number;
}
