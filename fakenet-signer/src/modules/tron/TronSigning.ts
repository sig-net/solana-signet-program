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

export function tronRequestRejection(
  request: Pick<
    SignBidirectionalEvent<TronTxParams>,
    'outputDeserializationSchema' | 'txParams'
  >
): string | undefined {
  return outputSchemaRejection(
    request.outputDeserializationSchema,
    tronIsContractCall(request.txParams)
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
