import { RequestIdGenerator } from '../RequestIdGenerator';
import { CryptoUtils } from '../CryptoUtils';
import {
  BitcoinTransactionProcessor,
  type BitcoinSigningPlan,
} from './BitcoinTransactionProcessor';
import type { SignBidirectionalEvent } from '../../types';
import type { BidirectionalHandlerContext } from '../shared/BidirectionalContext';
import { AppLogger } from '../logger/AppLogger';

export async function handleBitcoinBidirectional(
  event: SignBidirectionalEvent,
  context: BidirectionalHandlerContext,
  derivedPrivateKey: string
): Promise<void> {
  const { logger, config } = context;
  const colors = AppLogger.colors;

  logger.info(
    `🔍 Bitcoin transaction detected on ${colors.network(config.bitcoinNetwork)}`
  );
  logger.info(
    {
      psbtBytesLength: event.serializedTransaction.length,
      caip2Id: event.caip2Id,
    },
    `📦 PSBT received (${colors.value(event.serializedTransaction.length)} bytes, ${colors.value(event.caip2Id)})`
  );

  const bitcoinPlan = BitcoinTransactionProcessor.createSigningPlan(
    new Uint8Array(event.serializedTransaction),
    config,
    logger
  );

  logger.info(
    {
      inputCount: bitcoinPlan.inputs.length,
      txHash: bitcoinPlan.txid,
    },
    `✅ PSBT parsed successfully → tx ${colors.txid(bitcoinPlan.txid)}`
  );

  await handleBitcoinSigningPlan(
    event,
    bitcoinPlan,
    derivedPrivateKey,
    context
  );
}

/**
 * Processes a PSBT into per-input signing jobs and registers the pending tx.
 *
 * Flow mirrors the "Bitcoin Per-Input Signing" doc:
 *  - Uses {@link BitcoinTransactionProcessor} to parse the PSBT once, yielding
 *    the canonical txid plus per-input witness metadata and BIP-143 sighashes.
 *  - Immediately records the txid in `pendingTransactions` with the schemas and
 *    prevouts so {@link BitcoinMonitor} can watch for confirmations or spent
 *    inputs (isPrevoutSpent via the adapters).
 *  - For each PSBT input, derives a deterministic request ID by hashing the
 *    little-endian txid bytes concatenated with the input index (u32 LE) and
 *    signs the corresponding sighash with the single MPC-derived private key.
 *  - Streams every signature back to the Solana program individually via
 *    `respond`, logging `{ txid, inputIndex, requestId }` for traceability.
 *  - The external client finalizes/broadcasts the PSBT; the server only signs
 *    and monitors until {@link handleCompletedTransaction} /
 *    {@link handleFailedTransaction} respond bidirectionally.
 */
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
  const colors = AppLogger.colors;

  const txidBytes = Buffer.from(plan.txid, 'hex');
  const prevouts = plan.inputs.map(({ prevTxid, vout }) => ({
    txid: prevTxid,
    vout,
  }));

  const aggregateRequestId =
    RequestIdGenerator.generateSignBidirectionalRequestId(
      event.sender.toString(),
      Array.from(txidBytes),
      event.caip2Id,
      event.keyVersion,
      event.path,
      event.algo,
      event.dest,
      event.params
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

    logger.success(
      {
        tx,
        txHash: plan.txid,
        inputIndex: inputPlan.inputIndex,
        requestId: perInputRequestId,
      },
      `✅ Signed input ${colors.value(inputPlan.inputIndex)} for ${colors.txid(plan.txid)}`
    );
  }

  logger.info(
    {
      txHash: plan.txid,
      namespace: 'bip122',
      network: config.bitcoinNetwork,
    },
    `🔍 Monitoring ${colors.network(config.bitcoinNetwork)} tx ${colors.txid(plan.txid)}`
  );
}
