import { RequestIdGenerator } from '../RequestIdGenerator';
import { EthereumTransactionProcessor } from './EthereumTransactionProcessor';
import type { SignBidirectionalEvent } from '../../types';
import type { BidirectionalHandlerContext } from '../shared/BidirectionalContext';

export async function handleEthereumBidirectional(
  event: SignBidirectionalEvent,
  context: BidirectionalHandlerContext,
  derivedPrivateKey: string
): Promise<void> {
  const { config, program, wallet, pendingTransactions } = context;

  const requestId = RequestIdGenerator.generateSignBidirectionalRequestId(
    event.sender.toString(),
    Array.from(event.serializedTransaction),
    event.caip2Id,
    event.keyVersion,
    event.path,
    event.algo,
    event.dest,
    event.params
  );

  console.log(`🔑 Request ID (eip155): ${requestId}`);

  const result =
    await EthereumTransactionProcessor.processTransactionForSigning(
      new Uint8Array(event.serializedTransaction),
      derivedPrivateKey,
      event.caip2Id,
      config
    );

  const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
  const requestIds = result.signature.map(() => Array.from(requestIdBytes));

  const tx = await program.methods
    .respond(requestIds, result.signature)
    .accounts({
      responder: wallet.publicKey,
    })
    .rpc();

  console.log(`✅ Signatures sent to contract (tx=${tx})`);

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
  });

  console.log(`🔍 Monitoring transaction ${result.signedTxHash} (eip155)`);
}
