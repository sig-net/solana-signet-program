import {
  EvmTraceOutputKind,
  executedEvmRespondOutput,
} from '@sig-net/midnight';
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

export type TronExecutionOutcome =
  | { kind: 'executed'; output: Uint8Array }
  | { kind: 'failed' }
  | { kind: 'parked'; reason: string };

/**
 * The verdict the MPC attests for a solidified receipt (`execution_outcome`
 * in github.com/sig-net/mpc chain-signatures/chain-tron/src/types.rs). A
 * success's output is `contractResult[0]` recovered exactly as an EVM call's
 * traced return data: decoded with the output schema and serialised for
 * Midnight. Where that recovery refuses, the request parks unanswered.
 */
export function tronExecutionOutcome(
  receipt: Pick<TronReceipt, 'result' | 'receiptResult' | 'contractResult'>,
  outputSchema: Uint8Array,
  isContractCall: boolean
): TronExecutionOutcome {
  if (tronExecutionResult(receipt) === 'failed') return { kind: 'failed' };
  const returnData = receipt.contractResult[0];
  try {
    return {
      kind: 'executed',
      output: executedEvmRespondOutput(
        outputSchema,
        isContractCall,
        returnData === undefined
          ? { kind: EvmTraceOutputKind.NoReturnData }
          : { kind: EvmTraceOutputKind.Output, returnData }
      ),
    };
  } catch (error) {
    return {
      kind: 'parked',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
