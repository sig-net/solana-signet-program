import { RequestIdGenerator } from '../RequestIdGenerator';
import { CryptoUtils } from '../CryptoUtils';
import {
  BitcoinTransactionProcessor,
  type BitcoinSigningPlan,
} from './BitcoinTransactionProcessor';
import type { SignBidirectionalEvent } from '../../types';
import type { BidirectionalHandlerContext } from '../shared/BidirectionalContext';

export async function handleBitcoinBidirectional(
  event: SignBidirectionalEvent,
  context: BidirectionalHandlerContext,
  derivedPrivateKey: string
): Promise<void> {
  const { logger, config } = context;

  logger.info('🔍 Bitcoin transaction detected');
  logger.info(
    {
      psbtBytesLength: event.serializedTransaction.length,
      caip2Id: event.caip2Id,
    },
    '📦 PSBT received'
  );

  const bitcoinPlan = BitcoinTransactionProcessor.createSigningPlan(
    new Uint8Array(event.serializedTransaction),
    config
  );

  logger.info(
    {
      inputCount: bitcoinPlan.inputs.length,
      txHash: bitcoinPlan.txid,
    },
    '✅ PSBT parsed successfully'
  );

  await handleBitcoinSigningPlan(event, bitcoinPlan, derivedPrivateKey, context);
}

async function handleBitcoinSigningPlan(
  event: SignBidirectionalEvent,
  plan: BitcoinSigningPlan,
  derivedPrivateKey: string,
  context: BidirectionalHandlerContext
) {
  if (plan.inputs.length === 0) {
    throw new Error('Bitcoin PSBT must contain at least one input');
  }

  const { program, wallet, logger, config, pendingTransactions } = context;

  const txidBytes = Buffer.from(plan.txid, 'hex');
  const prevouts = plan.inputs.map(({ prevTxid, vout }) => ({
    txid: prevTxid,
    vout,
  }));

  const aggregateRequestId = RequestIdGenerator.generateSignBidirectionalRequestId(
    event.sender.toString(),
    Array.from(txidBytes),
    event.caip2Id,
    event.keyVersion,
    event.path,
    event.algo,
    event.dest,
    event.params
  );

  logger.info(
    { requestId: aggregateRequestId, namespace: 'bip122' },
    '🔑 Request ID'
  );

  pendingTransactions.set(plan.txid, {
    txHash: plan.txid,
    requestId: aggregateRequestId,
    caip2Id: event.caip2Id,
    explorerDeserializationSchema: event.outputDeserializationSchema,
    callbackSerializationSchema: event.respondSerializationSchema,
    fromAddress: 'bitcoin',
    nonce: 0,
    checkCount: 0,
    namespace: 'bip122',
    prevouts,
  });

  for (const inputPlan of plan.inputs) {
    const inputIndexBytes = Buffer.alloc(4);
    inputIndexBytes.writeUInt32LE(inputPlan.inputIndex, 0);
    const txDataForInput = Buffer.concat([txidBytes, inputIndexBytes]);

    const perInputRequestId =
      RequestIdGenerator.generateSignBidirectionalRequestId(
        event.sender.toString(),
        Array.from(txDataForInput),
        event.caip2Id,
        event.keyVersion,
        event.path,
        event.algo,
        event.dest,
        event.params
      );

    const perInputRequestIdBytes = Array.from(
      Buffer.from(perInputRequestId.slice(2), 'hex')
    );

    const signature = await CryptoUtils.signMessage(
      Array.from(inputPlan.sighash),
      derivedPrivateKey
    );

    const tx = await program.methods
      .respond([perInputRequestIdBytes], [signature])
      .accounts({
        responder: wallet.publicKey,
      })
      .rpc();

    logger.info(
      {
        tx,
        txHash: plan.txid,
        inputIndex: inputPlan.inputIndex,
        requestId: perInputRequestId,
      },
      '✅ Bitcoin signature sent'
    );
  }

  logger.info(
    {
      txHash: plan.txid,
      namespace: 'bip122',
      network: config.bitcoinNetwork,
    },
    '🔍 Monitoring transaction'
  );
}
