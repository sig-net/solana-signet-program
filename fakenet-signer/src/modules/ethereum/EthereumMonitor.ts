import { ethers } from 'ethers';
import {
  TransactionOutput,
  TransactionStatus,
  ServerConfig,
  TransactionOutputData,
  AbiSchemaField,
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
          const output = await this.extractTransactionOutput(
            tx,
            receipt,
            provider,
            outputDeserializationSchema,
            fromAddress
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

  private static async extractTransactionOutput(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt,
    provider: ethers.JsonRpcProvider,
    outputDeserializationSchema: Buffer | number[],
    fromAddress: string
  ): Promise<TransactionOutput> {
    // Contract call = calldata longer than 2 bytes, matching is_contract_call
    // in github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/event_parsing.rs:19
    const isContractCall = ethers.dataLength(tx.data) > 2;

    // This is the Ethereum monitor, so the output deserialisation format is
    // always ABI: the MPC hardcodes it as OUTPUT_DESERIALIZATION_FORMAT in
    // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/respond_bidirectional.rs:10
    // and its decode gate is `SerDeserFormat::Abi if is_contract_call`
    // (respond_bidirectional.rs:122), which reduces to just is_contract_call.
    if (isContractCall) {
      const callResult = await provider.call({
        to: tx.to,
        data: tx.data,
        from: fromAddress,
        blockTag: receipt.blockNumber - 1,
      });

      // Checkpoint 1 (pre-deserialisation): 'callResult' must match the raw
      // 'trace_output' bytes in
      // github.com/sig-net/mpc/chain-signatures/chain-ethereum/src/indexer.rs:280.
      // Caveat: the MPC reads the mined tx's actual return data via
      // debug_traceTransaction, while we re-simulate via eth_call against the
      // previous block's state, so the two can diverge when earlier txs in
      // the same block change state the call depends on.

      const schemaStr = decodePaddedSchema(outputDeserializationSchema);

      if (!schemaStr.trim()) {
        throw new Error(
          'Empty output deserialization schema — cannot decode EVM return value'
        );
      }

      const schema = JSON.parse(schemaStr) as AbiSchemaField[];
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        schema.map((s) => s.type),
        callResult
      );

      const decodedOutput: TransactionOutputData = {};
      schema.forEach((field, index) => {
        decodedOutput[field.name] = decoded[index];
      });

      return { success: true, output: decodedOutput };
    } else {
      return {
        success: true,
        output: {
          success: true,
          isFunctionCall: false,
        },
      };
    }
  }
}

/**
 * Decode an on-chain schema byte array to its JSON string. Schemas are stored
 * as fixed-size, NUL-padded buffers, so cut at the first NUL — trailing \0
 * bytes are not whitespace and would make JSON.parse reject an otherwise-valid
 * schema.
 */
function decodePaddedSchema(schema: Buffer | number[] | string): string {
  if (typeof schema === 'string') return schema;
  const raw = new TextDecoder().decode(new Uint8Array(schema));
  const nul = raw.indexOf('\0');
  return nul === -1 ? raw : raw.slice(0, nul);
}
