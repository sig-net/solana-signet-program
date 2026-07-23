import { contracts } from 'signet.js';
const { getRequestIdBidirectional } = contracts.solana;
import { EthereumTransactionProcessor } from './EthereumTransactionProcessor';
import type { SignBidirectionalEvent } from '../../types';
import type { BidirectionalHandlerContext } from '../shared/BidirectionalContext';

export async function handleEthereumBidirectional(
  event: SignBidirectionalEvent,
  context: BidirectionalHandlerContext,
  derivedPrivateKey: string
): Promise<void> {
  const { pendingTransactions, sendSignatures, source } = context;

  const requestId = getRequestIdBidirectional({
    sender: event.sender.toString(),
    payload: Array.from(event.serializedTransaction),
    caip2Id: event.caip2Id,
    keyVersion: event.keyVersion,
    path: event.path,
    algo: event.algo,
    dest: event.dest,
    params: event.params,
  });

  const result =
    await EthereumTransactionProcessor.processTransactionForSigning(
      new Uint8Array(event.serializedTransaction),
      derivedPrivateKey
    );

  const requestIdBytes = Buffer.from(requestId.slice(2), 'hex');
  const requestIds = result.signature.map(() => requestIdBytes);

  const tx = await sendSignatures(
    requestIds,
    result.signature,
    'respond-eip155'
  );

  console.log(
    `✅ eip155: signed tx=${result.signedTxHash} from=${result.fromAddress} (${source} tx=${tx ?? 'n/a'})`
  );

  pendingTransactions.set(result.signedTxHash, {
    txHash: result.signedTxHash,
    requestId,
    caip2Id: event.caip2Id,
    outputDeserializationSchema: Buffer.from(
      event.outputDeserializationSchema
    ),
    respondSerializationSchema: Buffer.from(event.respondSerializationSchema),
    fromAddress: result.fromAddress,
    nonce: result.nonce,
    checkCount: 0,
    namespace: 'eip155',
    prevouts: [],
    sender: event.sender.toString(),
    source,
  });

  console.log(`🔍 Monitoring eip155 tx ${result.signedTxHash}`);
}
