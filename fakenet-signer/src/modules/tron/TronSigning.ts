import { ethers } from 'ethers';
import {
  buildTronRawTransaction,
  deriveEpsilon,
  type SignBidirectionalEvent,
  TRON_CAIP2_ID,
  type TronTxParams,
  tronAddressFromEvm,
  tronTransactionId,
} from '@sig-net/midnight';
import { CryptoUtils } from '../CryptoUtils';
import { tronSchemaRejection } from './TronVerdicts';

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
    'outputDeserializationSchema' | 'respondSerializationSchema'
  >,
  caip2Id: string
): string | undefined {
  if (caip2Id !== TRON_CAIP2_ID) {
    return `execution_dest ${caip2Id} does not name ${TRON_CAIP2_ID}, the chain family the record's tx_params assemble for`;
  }
  return tronSchemaRejection(
    request.outputDeserializationSchema,
    request.respondSerializationSchema
  );
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
