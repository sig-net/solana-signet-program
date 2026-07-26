import { ethers } from 'ethers';
// The EVM output decoding comes from the signet protocol library — the same
// schema-driven ABI decode clients run to recompute the respond bytes.
import { deserializeEvmOutput } from '@sig-net/midnight';
import {
  TransactionOutput,
  TransactionStatus,
  ServerConfig,
} from '../../types';
import { getNamespaceFromCaip2 } from '../ChainUtils';

export class EthereumMonitor {
  private static providerCache = new Map<string, ethers.JsonRpcProvider>();
  static async waitForTransactionAndGetOutput(
    txHash: string,
    caip2Id: string,
    outputDeserializationSchema: Buffer | number[],
    fromAddress: string,
    nonce: number,
    config: ServerConfig
  ): Promise<TransactionStatus> {
    let provider: ethers.JsonRpcProvider;

    try {
      provider = this.getProvider(caip2Id, config);
    } catch {
      return { status: 'fatal_error', reason: 'unsupported_chain' };
    }

    try {
      const receipt = await provider.getTransactionReceipt(txHash);

      if (receipt) {
        if (receipt.status === 0) {
          console.log(
            `❌ EthereumMonitor: tx ${txHash} reverted (block=${receipt.blockNumber})`
          );
          return { status: 'error', reason: 'reverted' };
        }

        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          return { status: 'pending' };
        }

        try {
          const { output, rawOutput } = await this.extractTransactionOutput(
            tx,
            provider,
            outputDeserializationSchema
          );
          console.log(
            `✅ EthereumMonitor: tx ${txHash} confirmed (block=${receipt.blockNumber})`
          );

          // Checkpoint 2 (post-deserialisation): 'output' here must match
          // 'transaction_output' in build_serialized_output at
          // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/respond_bidirectional.rs:122
          // (built by TransactionOutput::from_call_result): the raw return
          // bytes already ABI-decoded per the output deserialization schema,
          // or the synthesized non-contract-call default.

          return {
            status: 'success',
            success: output.success,
            output: output.output,
            rawOutput,
          };
        } catch (error) {
          // On extraction failure the MPC emits no event and the execution
          // watcher retries on the next block (execution_confirmed_event
          // returns None, chain-ethereum/src/indexer.rs:332). Report pending
          // so the poll loop retries instead of sending an error response.
          console.error(
            `EthereumMonitor: output extraction failed for ${txHash}, will retry`,
            error
          );
          return { status: 'pending' };
        }
      } else {
        // No receipt - check if replaced
        const currentNonce = await provider.getTransactionCount(fromAddress);
        if (currentNonce > nonce) {
          const receiptCheck = await provider.getTransactionReceipt(txHash);
          if (!receiptCheck) {
            console.log(
              `❌ EthereumMonitor: tx ${txHash} replaced (nonce=${nonce} already used)`
            );
            return { status: 'error', reason: 'replaced' };
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
    const provider = new ethers.JsonRpcProvider(fetchRequest);
    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  /**
   * The top call frame of the mined transaction, read with the SAME RPC
   * method the real MPC uses (debug_traceTransaction with the callTracer,
   * top call only — github.com/sig-net/mpc
   * chain-signatures/chain-ethereum/src/indexer.rs). The frame's `output`
   * is the call's actual return data as mined (absent for a plain
   * transfer).
   */
  private static async traceTopCallOutput(
    txHash: string,
    provider: ethers.JsonRpcProvider
  ): Promise<string> {
    const callFrame = (await provider.send('debug_traceTransaction', [
      txHash,
      {
        tracer: 'callTracer',
        tracerConfig: {
          onlyTopCall: true,
        },
        timeout: '5s',
      },
    ])) as { output?: string };
    return callFrame?.output ?? '0x';
  }

  private static async extractTransactionOutput(
    tx: ethers.TransactionResponse,
    provider: ethers.JsonRpcProvider,
    outputDeserializationSchema: Buffer | number[]
  ): Promise<{ output: TransactionOutput; rawOutput: string }> {
    // Contract call = calldata longer than 2 bytes, matching is_contract_call
    // in github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/event_parsing.rs:19
    const isContractCall = ethers.dataLength(tx.data) > 2;

    // Checkpoint 1 (pre-deserialisation): 'rawOutput' must match the raw
    // 'trace_output' bytes in
    // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/indexer.rs:280.
    // Same method as the MPC (debug_traceTransaction, callTracer, top call
    // only), so this is the mined call's ACTUAL return data.
    const rawOutput = await this.traceTopCallOutput(tx.hash, provider);

    // This is the Ethereum monitor, so the output deserialisation format is
    // always ABI: the MPC hardcodes it as OUTPUT_DESERIALIZATION_FORMAT in
    // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/respond_bidirectional.rs:10
    // and its decode gate is `SerDeserFormat::Abi if is_contract_call`
    // (respond_bidirectional.rs:122), which reduces to just is_contract_call.
    if (isContractCall) {
      // Schema-driven ABI decode via the signet library (mirrors the MPC's
      // delegation to alloy). Accepts the raw NUL-padded on-chain schema
      // bytes and throws on an empty/malformed schema, which the caller
      // reports as pending so the poll loop retries.
      const decodedOutput = deserializeEvmOutput(
        Uint8Array.from(outputDeserializationSchema),
        rawOutput
      );

      return { output: { success: true, output: decodedOutput }, rawOutput };
    } else {
      return {
        output: {
          success: true,
          output: {
            success: true,
            isFunctionCall: false,
          },
        },
        rawOutput,
      };
    }
  }
}
