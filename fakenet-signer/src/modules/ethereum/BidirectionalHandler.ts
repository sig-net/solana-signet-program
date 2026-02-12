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
  const { program, wallet, pendingTransactions, withTimeout } = context;

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

  const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
  const requestIds = result.signature.map(() => Array.from(requestIdBytes));

  const tx = await withTimeout(
    program.methods
      .respond(requestIds, result.signature)
      .accounts({
        responder: wallet.publicKey,
      })
      .rpc(),
    'respond-eip155'
  );

  console.log(`✅ eip155: signed tx=${result.signedTxHash} from=${result.fromAddress} (solana tx=${tx})`);

  pendingTransactions.set(result.signedTxHash, {
    txHash: result.signedTxHash,
    requestId,
    caip2Id: event.caip2Id,
    explorerDeserializationSchema: event.outputDeserializationSchema,
    callbackSerializationSchema: event.respondSerializationSchema,
    fromAddress: result.fromAddress,
    nonce: result.nonce,
    checkCount: 0,
    namespace: 'eip155',
    prevouts: [],
    sender: event.sender.toString(),
  });

  console.log(`🔍 Monitoring eip155 tx ${result.signedTxHash}`);
}
