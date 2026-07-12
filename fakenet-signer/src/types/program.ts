import type { Program, Idl } from '@coral-xyz/anchor';
import type { PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';
import type { SignatureResponse } from './index';

export interface InitializeAccounts {
  admin: PublicKey;
}

export interface RespondAccounts {
  responder: PublicKey;
}

export interface RespondBidirectionalAccounts {
  responder: PublicKey;
}

interface MethodsBuilderWithRpc<T> {
  accounts(accounts: T): { rpc(): Promise<string> };
}

export interface ChainSignaturesMethods {
  initialize(
    signatureDeposit: BN,
    chainId: string
  ): MethodsBuilderWithRpc<InitializeAccounts>;

  respond(
    requestIds: number[][],
    signatures: SignatureResponse[]
  ): MethodsBuilderWithRpc<RespondAccounts>;

  respondBidirectional(
    requestId: number[],
    serializedOutput: Buffer,
    signature: SignatureResponse
  ): MethodsBuilderWithRpc<RespondBidirectionalAccounts>;
}

export type ChainSignaturesProgram = Program<Idl> & {
  readonly methods: ChainSignaturesMethods;
};

export function asChainSignaturesProgram(
  program: Program<Idl>
): ChainSignaturesProgram {
  return program as unknown as ChainSignaturesProgram;
}
