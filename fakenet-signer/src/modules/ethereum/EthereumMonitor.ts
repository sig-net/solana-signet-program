import { ethers } from 'ethers';
import {
  deserializeEvmOutput,
  evmTraceOutputFromCallFrame,
  EvmTraceOutputKind,
  isEvmContractCall,
  type JsonValue,
} from '@sig-net/midnight';
import {
  EvmExecution,
  TransactionOutput,
  TransactionStatus,
  TransactionFailureReason,
  ServerConfig,
} from '../../types';
import { getNamespaceFromCaip2 } from '../ChainUtils';

// Stop monitoring after this many consecutive output-extraction failures.
// Midnight requests remain unanswered when their output cannot be recovered.
const MAX_EXTRACTION_FAILURES = 5;

/** An EVM transaction this responder signed, as the MPC's watcher records it. */
export interface SignedEvmTransaction {
  hash: string;
  from: string;
  nonce: number;
  /** The request's unsigned serialized transaction, as hex. */
  unsignedTransaction: string;
}

export class EthereumMonitor {
  private static providerCache = new Map<string, ethers.JsonRpcProvider>();
  // Every signed transaction, broadcast or not, by lowercase hash: the MPC's
  // execution watchers. Kept after a transaction resolves, as a request still
  // pending at the same nonce may resolve later against it.
  private static signedTransactions = new Map<string, SignedEvmTransaction>();
  // Consecutive extractTransactionOutput failures per tx hash.
  private static extractionFailureCounts = new Map<string, number>();

  /**
   * Whether an RPC error means the method itself is missing or unsupported
   * (JSON-RPC -32601 or a provider's equivalent), as opposed to a transient
   * or per-transaction failure.
   */
  private static isMethodNotSupportedError(error: unknown): boolean {
    const e = error as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
      info?: { error?: { code?: unknown; message?: unknown } };
    };
    const codes = [e?.code, e?.error?.code, e?.info?.error?.code];
    if (codes.includes(-32601) || codes.includes('UNSUPPORTED_OPERATION')) {
      return true;
    }
    const messages = [e?.message, e?.error?.message, e?.info?.error?.message]
      .filter((m): m is string => typeof m === 'string')
      .join(' ');
    return /method not found|method not supported|does not exist|is not available|unsupported method/i.test(
      messages
    );
  }

  /**
   * The finalised height when a request is signed: the earliest block
   * searched for the consumption of its nonce. A nonce already spent there
   * resolves to `nonce_spent_before_signing`.
   * @param caip2Id Destination chain identifier.
   * @param config RPC configuration.
   * @returns The finalised height.
   * @throws If the finalised block cannot be read from the RPC.
   */
  static async getSigningBlock(
    caip2Id: string,
    config: ServerConfig
  ): Promise<number> {
    const provider = this.getProvider(caip2Id, config);
    const block = await provider.getBlock('finalized');
    if (!block) throw new Error('Finalised EVM block unavailable');
    return block.number;
  }

  /**
   * Record a transaction this responder signed, so a request its mining
   * displaces resolves as the MPC's watched sibling rule decides.
   * @param tx The signed transaction and the unsigned bytes it was signed over.
   */
  static recordSignedTransaction(tx: SignedEvmTransaction): void {
    this.signedTransactions.set(tx.hash.toLowerCase(), {
      hash: tx.hash.toLowerCase(),
      from: ethers.getAddress(tx.from),
      nonce: tx.nonce,
      unsignedTransaction: tx.unsignedTransaction.toLowerCase(),
    });
  }

  static async waitForTransactionAndGetOutput(
    txHash: string,
    caip2Id: string,
    outputDeserializationSchema: Buffer | number[],
    fromAddress: string,
    nonce: number,
    signedAtBlock: number | undefined,
    config: ServerConfig
  ): Promise<TransactionStatus> {
    if (signedAtBlock === undefined) {
      return { status: 'fatal_error', reason: 'missing_signing_block' };
    }
    let provider: ethers.JsonRpcProvider;

    try {
      provider = this.getProvider(caip2Id, config);
    } catch {
      return { status: 'fatal_error', reason: 'unsupported_chain' };
    }

    try {
      const finalisedBlock = await provider.getBlock('finalized');
      if (!finalisedBlock || finalisedBlock.number < signedAtBlock) {
        return { status: 'pending' };
      }
      const receipt = await provider.getTransactionReceipt(txHash);

      if (receipt) {
        if (receipt.blockNumber > finalisedBlock.number)
          return { status: 'pending' };
        if (receipt.status === 0) {
          console.log(
            `❌ EthereumMonitor: tx ${txHash} reverted (block=${receipt.blockNumber})`
          );
          return {
            status: 'error',
            reason: TransactionFailureReason.Reverted,
            blockHeight: BigInt(receipt.blockNumber),
          };
        }

        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          return { status: 'pending' };
        }

        try {
          const evmExecution = await this.readEvmExecution(tx, provider);
          const output = this.decodeTransactionOutput(
            evmExecution,
            outputDeserializationSchema
          );
          this.extractionFailureCounts.delete(txHash);
          console.log(
            `✅ EthereumMonitor: tx ${txHash} confirmed (block=${receipt.blockNumber})`
          );

          return {
            status: 'success',
            success: output.success,
            output: output.output,
            evmExecution,
            blockHeight: BigInt(receipt.blockNumber),
          };
        } catch (error) {
          // An unsupported trace method cannot supply an attestable output.
          if (this.isMethodNotSupportedError(error)) {
            this.extractionFailureCounts.delete(txHash);
            console.error(
              `EthereumMonitor: the EVM RPC configured via EVM_RPC_URL does not support debug_traceTransaction with the callTracer, so the mined call's output cannot be extracted for ${txHash}. Point EVM_RPC_URL at a node with the debug namespace enabled, e.g. a local anvil/geth/reth dev node or a provider plan that includes trace methods.`,
              error
            );
            return {
              status: 'fatal_error',
              reason: 'debug_trace_not_supported',
            };
          }

          // Retry transient extraction failures up to the monitoring limit.
          const failures = (this.extractionFailureCounts.get(txHash) ?? 0) + 1;
          if (failures >= MAX_EXTRACTION_FAILURES) {
            this.extractionFailureCounts.delete(txHash);
            console.error(
              `EthereumMonitor: output extraction failed ${failures} times for ${txHash}, giving up`,
              error
            );
            return { status: 'fatal_error', reason: 'extraction_failed' };
          }
          this.extractionFailureCounts.set(txHash, failures);
          console.error(
            `EthereumMonitor: output extraction failed for ${txHash} (attempt ${failures}/${MAX_EXTRACTION_FAILURES}), will retry`,
            error
          );
          return { status: 'pending' };
        }
      } else {
        // No receipt - check if replaced
        const currentNonce = await provider.getTransactionCount(
          fromAddress,
          finalisedBlock.number
        );
        if (currentNonce > nonce) {
          const receiptCheck = await provider.getTransactionReceipt(txHash);
          if (!receiptCheck) {
            const blockHeight = await this.findNonceConsumedBlock(
              provider,
              fromAddress,
              nonce,
              signedAtBlock,
              finalisedBlock.number
            );
            if (blockHeight === undefined) {
              return {
                status: 'fatal_error',
                reason: 'nonce_spent_before_signing',
              };
            }
            if (
              !(await this.displacingSiblingMinedAt(
                provider,
                txHash,
                blockHeight
              ))
            ) {
              console.log(
                `❌ EthereumMonitor: tx ${txHash} nonce=${nonce} taken in block ${blockHeight} by no displacing sibling`
              );
              return {
                status: 'fatal_error',
                reason: 'nonce_consumed_without_sibling',
              };
            }
            console.log(
              `❌ EthereumMonitor: tx ${txHash} replaced (nonce=${nonce} taken in block ${blockHeight})`
            );
            return {
              status: 'error',
              reason: TransactionFailureReason.Replaced,
              blockHeight,
            };
          }
        }

        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          return { status: 'pending' };
        }

        return { status: 'pending' };
      }
    } catch {
      return { status: 'pending' };
    }
  }

  /**
   * The first block at which `fromAddress` had spent `nonce`: the block that
   * took the nonce from a replaced transaction, found by bisecting the
   * account's transaction count after signing, or undefined when the nonce
   * was already spent at signing. The attestation of an unviable request
   * commits to this height.
   */
  private static async findNonceConsumedBlock(
    provider: ethers.JsonRpcProvider,
    fromAddress: string,
    nonce: number,
    signedAtBlock: number,
    finalisedHeight: number
  ): Promise<bigint | undefined> {
    if (
      (await provider.getTransactionCount(fromAddress, signedAtBlock)) > nonce
    ) {
      return undefined;
    }
    let low = signedAtBlock + 1;
    let high = finalisedHeight;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const count = await provider.getTransactionCount(fromAddress, mid);
      if (count > nonce) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return BigInt(low);
  }

  /**
   * Whether the nonce of `txHash` was taken in `blockHeight` by a watched
   * sibling: another transaction this responder signed from the same sender
   * at the same nonce, over different unsigned bytes. This is the MPC's
   * resolve_replaced_siblings rule for Midnight (github.com/sig-net/mpc
   * chain-signatures/chain-ethereum/src/execution_watcher.rs), and every
   * other consumer falls to its consumed_nonce_fallback. A Borsh source's
   * error response is the same bytes on either path, so the Midnight rule
   * serves every source.
   */
  private static async displacingSiblingMinedAt(
    provider: ethers.JsonRpcProvider,
    txHash: string,
    blockHeight: bigint
  ): Promise<boolean> {
    const displaced = this.signedTransactions.get(txHash.toLowerCase());
    if (!displaced) return false;
    for (const sibling of this.signedTransactions.values()) {
      if (
        sibling.hash === displaced.hash ||
        sibling.from !== displaced.from ||
        sibling.nonce !== displaced.nonce ||
        sibling.unsignedTransaction === displaced.unsignedTransaction
      ) {
        continue;
      }
      const receipt = await provider.getTransactionReceipt(sibling.hash);
      if (receipt && BigInt(receipt.blockNumber) === blockHeight) return true;
    }
    return false;
  }

  private static getProvider(
    caip2Id: string,
    config: ServerConfig
  ): ethers.JsonRpcProvider {
    const namespace = getNamespaceFromCaip2(caip2Id);
    const cacheKey = caip2Id;

    const cachedProvider = this.providerCache.get(cacheKey);
    if (cachedProvider) {
      return cachedProvider;
    }

    let url: string;
    switch (namespace) {
      case 'eip155':
        url = config.evmRpcUrl;
        break;
      default:
        throw new Error(`Unsupported chain namespace: ${namespace}`);
    }

    const fetchRequest = new ethers.FetchRequest(url);
    fetchRequest.timeout = 30_000;
    // No result caching: a receipt read must be fresh, so a transaction is
    // never declared replaced on a stale nonce or receipt.
    const provider = new ethers.JsonRpcProvider(fetchRequest, undefined, {
      cacheTimeout: -1,
    });
    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  /**
   * The MPC's extraction inputs for a mined transaction
   * (fetch_extraction_inputs in github.com/sig-net/mpc
   * chain-signatures/chain-ethereum/src/execution_watcher.rs): whether it is
   * a contract call and, for a contract call only, its top call frame read
   * with the MPC's own debug_traceTransaction request.
   */
  private static async readEvmExecution(
    tx: ethers.TransactionResponse,
    provider: ethers.JsonRpcProvider
  ): Promise<EvmExecution> {
    const isContractCall = isEvmContractCall(tx.data);
    if (!isContractCall) {
      return {
        isContractCall,
        trace: { kind: EvmTraceOutputKind.NotTraced },
      };
    }
    const callFrame: JsonValue = await provider.send('debug_traceTransaction', [
      tx.hash,
      {
        tracer: 'callTracer',
        tracerConfig: {
          onlyTopCall: true,
        },
        timeout: '5s',
      },
    ]);
    return { isContractCall, trace: evmTraceOutputFromCallFrame(callFrame) };
  }

  /**
   * The decoded output map the Borsh responders (Solana, Substrate)
   * serialise: a contract call's return data ABI-decoded per the output
   * deserialisation schema, or the non-contract-call marker their
   * serialiser fills with schema defaults. Midnight responds from
   * {@link EvmExecution} itself.
   */
  private static decodeTransactionOutput(
    evmExecution: EvmExecution,
    outputDeserializationSchema: Buffer | number[]
  ): TransactionOutput {
    if (!evmExecution.isContractCall) {
      return {
        success: true,
        output: {
          success: true,
          isFunctionCall: false,
        },
      };
    }
    const { trace } = evmExecution;
    return {
      success: true,
      // A frame without an `output` decodes as empty return data.
      output: deserializeEvmOutput(
        Uint8Array.from(outputDeserializationSchema),
        trace.kind === EvmTraceOutputKind.Output ? trace.returnData : '0x'
      ),
    };
  }
}
