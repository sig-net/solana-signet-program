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
  const { config, program, wallet, pendingTransactions } = context;

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

  console.log(`🔑 Request ID (eip155): ${requestId}`);

  console.log(`🔗 EthereumTxProcessor: processTransactionForSigning (THIS CAN HANG)...`);
  const result =
    await EthereumTransactionProcessor.processTransactionForSigning(
      new Uint8Array(event.serializedTransaction),
      derivedPrivateKey,
      event.caip2Id,
      config
    );
  console.log(`✓ EthereumTxProcessor: processTransactionForSigning done`);

  const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));
  const requestIds = result.signature.map(() => Array.from(requestIdBytes));

  console.log(`🔗 Solana RPC: respond() for eip155 (THIS CAN HANG)...`);
  const tx = await program.methods
    .respond(requestIds, result.signature)
    .accounts({
      responder: wallet.publicKey,
    })
    .rpc();
  console.log(`✓ Solana RPC: respond() done`);

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
    prevouts: [],
    sender: event.sender.toString(),
  });

  console.log(`🔍 Monitoring transaction ${result.signedTxHash} (eip155)`);
}
