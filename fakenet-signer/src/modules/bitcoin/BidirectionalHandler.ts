import { contracts } from 'signet.js';
const { getRequestIdBidirectional } = contracts.solana;
import { CryptoUtils } from '../CryptoUtils';
import {
  BitcoinTransactionProcessor,
  type BitcoinSigningPlan,
} from './BitcoinTransactionProcessor';
import type { SignBidirectionalEvent } from '../../types';
import type { BidirectionalHandlerContext } from '../shared/BidirectionalContext';

/**
 * Handle a Bitcoin bidirectional signing request emitted from Solana.
 * - Parses the PSBT, derives per-input signing plan, and triggers signing.
 * - Uses the MPC-derived private key for all inputs.
 * - Registers the transaction for later monitoring/response.
 */
export async function handleBitcoinBidirectional(
  event: SignBidirectionalEvent,
  context: BidirectionalHandlerContext,
  derivedPrivateKey: string
): Promise<void> {
  const { config } = context;

  console.log(
    `📦 bip122: PSBT received (${event.serializedTransaction.length} bytes, ${config.bitcoinNetwork})`
  );

  const bitcoinPlan = BitcoinTransactionProcessor.createSigningPlan(
    new Uint8Array(event.serializedTransaction),
    config
  );

  console.log(
    `✅ bip122: PSBT parsed → txid=${bitcoinPlan.explorerTxid} (${bitcoinPlan.inputs.length} input(s))`
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
 *    the explorer-facing txid plus per-input witness metadata and BIP-143
 *    sighashes.
 *  - Immediately records the txid in `pendingTransactions` with the schemas
 *    and prevouts so {@link BitcoinMonitor} can watch for confirmations or
 *    spent inputs (isPrevoutSpent via the adapters).
 *  - For each PSBT input, derives a deterministic request ID by hashing the
 *    explorer-facing txid bytes concatenated with the input index (u32 LE) and
 *    signs the corresponding sighash with the single MPC-derived private key.
 *  - Streams every signature back to the Solana program individually via
 *    `respond`, logging `{ txid, inputIndex, requestId }` for traceability.
 *  - The external client finalizes/broadcasts the PSBT; the server only signs
 *    and monitors until {@link handleCompletedTransaction} /
 *    {@link handleFailedTransaction} respond bidirectionally.
 *
 * @param event Solana-emitted bidirectional event containing PSBT bytes and metadata.
 * @param plan Parsed Bitcoin signing plan (txid + per-input sighashes).
 * @param derivedPrivateKey MPC-derived private key for this request.
 * @param context Shared server context (Anchor program, wallet, config, pending map).
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

  const { program, wallet, config, pendingTransactions, withTimeout } = context;

  // Use the explorer-facing txid (big-endian) for all aggregated request IDs;
  // never flip the byte order here.
  const txidBytes = Buffer.from(plan.explorerTxid, 'hex');
  const prevouts = plan.inputs.map(({ prevTxid, vout }) => ({
    txid: prevTxid,
    vout,
  }));

  const aggregateRequestId = getRequestIdBidirectional({
    sender: event.sender.toString(),
    payload: Array.from(txidBytes),
    caip2Id: event.caip2Id,
    keyVersion: event.keyVersion,
    path: event.path,
    algo: event.algo,
    dest: event.dest,
    params: event.params,
  });

  // On retry, preserve the existing entry (keeps submittedInputs state)
  const existing = pendingTransactions.get(plan.explorerTxid);
  const submittedInputs = existing?.submittedInputs ?? new Set<number>();

  if (!existing) {
    pendingTransactions.set(plan.explorerTxid, {
      txHash: plan.explorerTxid,
      requestId: aggregateRequestId,
      caip2Id: event.caip2Id,
      explorerDeserializationSchema: event.outputDeserializationSchema,
      callbackSerializationSchema: event.respondSerializationSchema,
      fromAddress: 'bitcoin',
      nonce: 0,
      checkCount: 0,
      namespace: 'bip122',
      prevouts,
      sender: event.sender.toString(),
      submittedInputs,
    });
  }

  // Simulate MPC nodes returning signatures out of order so clients rely on
  // requestId when matching signatures. Shuffle deterministically per run using
  // Math.random for simplicity.
  const signingQueue = [...plan.inputs];
  for (let i = signingQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = signingQueue[i];
    const b = signingQueue[j];
    if (a !== undefined && b !== undefined) {
      signingQueue[i] = b;
      signingQueue[j] = a;
    }
  }

  for (const inputPlan of signingQueue) {
    if (submittedInputs.has(inputPlan.inputIndex)) {
      console.log(
        `⏭️ bip122: skipping input ${inputPlan.inputIndex}/${plan.inputs.length} for ${plan.explorerTxid} (already submitted)`
      );
      continue;
    }

    const inputIndexBytes = Buffer.alloc(4);
    inputIndexBytes.writeUInt32LE(inputPlan.inputIndex, 0);
    const txDataForInput = Buffer.concat([txidBytes, inputIndexBytes]);

    const perInputRequestId = getRequestIdBidirectional({
      sender: event.sender.toString(),
      payload: Array.from(txDataForInput),
      caip2Id: event.caip2Id,
      keyVersion: event.keyVersion,
      path: event.path,
      algo: event.algo,
      dest: event.dest,
      params: event.params,
    });

    const perInputRequestIdBytes = Array.from(
      Buffer.from(perInputRequestId.slice(2), 'hex')
    );

    const signature = await CryptoUtils.signMessage(
      Array.from(inputPlan.sighash),
      derivedPrivateKey
    );

    const tx = await withTimeout(
      program.methods
        .respond([perInputRequestIdBytes], [signature])
        .accounts({
          responder: wallet.publicKey,
        })
        .rpc(),
      `respond-bip122-input-${inputPlan.inputIndex}`
    );

    submittedInputs.add(inputPlan.inputIndex);

    console.log(
      `✅ bip122: signed input ${inputPlan.inputIndex}/${plan.inputs.length} for ${plan.explorerTxid} (solana tx=${tx})`
    );
  }

  console.log(`🔍 Monitoring bip122 tx ${plan.explorerTxid} (${config.bitcoinNetwork})`);
}
