import { ethers } from 'ethers';
import {
  assembleCalldata,
  buildTronRawTransaction,
  deriveEpsilon,
  isEvmContractCall,
  type SignBidirectionalEvent,
  type TronTxParams,
  tronAddressFromEvm,
  tronTransactionId,
} from '@sig-net/midnight';
import { CryptoUtils } from '../CryptoUtils';
import { outputSchemaRejection } from '../shared/OutputSchemaRejection';

export interface SignedTronRequest {
  raw: Uint8Array;
  txid: string;
  owner: Uint8Array;
  evmAddress: string;
  signature: ethers.Signature;
}

export const MAX_EXPIRATION_SPAN_MS = 86_400_000n;

export function tronExpiryRejection(
  expiration: bigint,
  sourceBlockTimeSeconds: bigint | undefined
): string | undefined {
  if (sourceBlockTimeSeconds === undefined) return undefined;
  const sourceMs = sourceBlockTimeSeconds * 1000n;
  if (expiration <= sourceMs) {
    return `validity window closed at the source block: expiration ${expiration} ms, source block ${sourceMs} ms`;
  }
  if (expiration > sourceMs + MAX_EXPIRATION_SPAN_MS) {
    return `expiration ${expiration} ms exceeds the cap over source block ${sourceMs} ms`;
  }
  return undefined;
}

export function tronRequestRejection(
  request: Pick<
    SignBidirectionalEvent<TronTxParams>,
    'outputDeserializationSchema' | 'txParams'
  >,
  sourceBlockTimeSeconds: bigint | undefined
): string | undefined {
  return (
    outputSchemaRejection(
      request.outputDeserializationSchema,
      tronIsContractCall(request.txParams)
    ) ??
    tronExpiryRejection(request.txParams.expiration, sourceBlockTimeSeconds)
  );
}

export function tronIsContractCall(
  txParams: Pick<TronTxParams, 'calldata'>
): boolean {
  return isEvmContractCall(assembleCalldata(txParams.calldata));
}

export function signTronRequest(
  txParams: TronTxParams,
  predecessor: string,
  pathHex: string,
  mpcRootKey: string
): SignedTronRequest {
  const derivedPrivateKey = CryptoUtils.deriveSigningKeyFromEpsilon(
    deriveEpsilon(predecessor, pathHex),
    mpcRootKey
  );
  const signingKey = new ethers.SigningKey(derivedPrivateKey);
  const evmAddress = ethers.computeAddress(signingKey.publicKey);
  const owner = tronAddressFromEvm(evmAddress);
  const raw = buildTronRawTransaction(txParams, owner);
  const txid = tronTransactionId(raw);
  const signature = signingKey.sign(txid);
  return {
    raw,
    txid: ethers.hexlify(txid).slice(2),
    owner,
    evmAddress,
    signature,
  };
}
