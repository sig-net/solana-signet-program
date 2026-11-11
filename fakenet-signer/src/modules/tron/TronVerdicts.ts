import type { TronReceipt } from './TronClient';

const FAILED_RESULTS = new Set([
  'FAILED',
  'REVERT',
  'BAD_JUMP_DESTINATION',
  'OUT_OF_MEMORY',
  'PRECOMPILED_CONTRACT',
  'STACK_TOO_SMALL',
  'STACK_TOO_LARGE',
  'ILLEGAL_OPERATION',
  'STACK_OVERFLOW',
  'OUT_OF_ENERGY',
  'OUT_OF_TIME',
  'JVM_STACK_OVER_FLOW',
  'UNKNOWN',
  'TRANSFER_FAILED',
  'INVALID_CODE',
]);

export function tronExecutionResult(
  receipt: Pick<TronReceipt, 'result' | 'receiptResult'>
): 'succeeded' | 'failed' {
  const result = receipt.result ?? receipt.receiptResult;
  if (result === undefined) {
    throw new Error('receipt carries no execution result field');
  }
  if (result === 'SUCESS' || result === 'SUCCESS') return 'succeeded';
  if (FAILED_RESULTS.has(result)) return 'failed';
  if (result === 'DEFAULT') throw new Error('unset execution result');
  throw new Error(`unclassifiable execution result ${JSON.stringify(result)}`);
}

export function tronExecutionOutcome(
  receipt: Pick<TronReceipt, 'result' | 'receiptResult'>,
  outputSchema: Uint8Array
): 'executed' | 'failed' | 'parked' {
  if (tronExecutionResult(receipt) === 'failed') return 'failed';
  return outputSchema.length === 0 ? 'executed' : 'parked';
}

export function tronSchemaRejection(
  outputDeserializationSchema: Uint8Array,
  respondSerializationSchema: Uint8Array
): string | undefined {
  const nul = respondSerializationSchema.indexOf(0);
  const respondPrefix =
    nul === -1
      ? respondSerializationSchema
      : respondSerializationSchema.subarray(0, nul);
  if (outputDeserializationSchema.length === 0 && respondPrefix.length === 0) {
    return undefined;
  }
  return (
    'Tron targets define no output schemas yet: the output schema ' +
    `(${outputDeserializationSchema.length} byte(s)) and the respond schema ` +
    `(${respondPrefix.length} byte(s)) must both be empty`
  );
}
