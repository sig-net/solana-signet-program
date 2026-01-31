import { ethers } from 'ethers';
import {
  TransactionOutput,
  TransactionStatus,
  ServerConfig,
  TransactionOutputData,
  AbiSchemaField,
} from '../../types';
import {
  getNamespaceFromCaip2,
  getSerializationFormat,
  SerializationFormat,
} from '../ChainUtils';

export class EthereumMonitor {
  private static providerCache = new Map<string, ethers.JsonRpcProvider>();
  static async waitForTransactionAndGetOutput(
    txHash: string,
    caip2Id: string,
    explorerDeserializationSchema: Buffer | number[],
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

    console.log(`⏳ EthereumMonitor: checking tx ${txHash}...`);

    try {
      console.log(`  🔗 EthereumMonitor: calling getTransactionReceipt...`);
      const receipt = await provider.getTransactionReceipt(txHash);
      console.log(`  ✓ EthereumMonitor: getTransactionReceipt returned (found: ${!!receipt})`);

      if (receipt) {
        console.log(`✅ Transaction found! Confirmation complete.`);
        console.log(`  📦 Block number: ${receipt.blockNumber}`);
        console.log(
          `  ${receipt.status === 1 ? '✅' : '❌'} Status: ${
            receipt.status === 1 ? 'Success' : 'Failed'
          }`
        );

        if (receipt.status === 0) {
          return { status: 'error', reason: 'reverted' };
        }

        console.log(`  🔗 EthereumMonitor: fetching full tx details...`);
        const tx = await provider.getTransaction(txHash);
        console.log(`  ✓ EthereumMonitor: tx details fetched`);
        if (!tx) {
          return { status: 'pending' };
        }

        try {
          console.log(`  🔗 EthereumMonitor: extracting transaction output...`);
          const output = await this.extractTransactionOutput(
            tx,
            receipt,
            provider,
            caip2Id,
            explorerDeserializationSchema,
            fromAddress
          );
          return {
            status: 'success',
            success: output.success,
            output: output.output,
          };
        } catch {
          return { status: 'fatal_error', reason: 'extraction_failed' };
        }
      } else {
        // No receipt - check if replaced
        console.log(`  🔗 EthereumMonitor: no receipt, checking nonce for ${fromAddress}...`);
        const currentNonce = await provider.getTransactionCount(fromAddress);
        console.log(`  ✓ EthereumMonitor: currentNonce=${currentNonce}, expectedNonce=${nonce}`);
        if (currentNonce > nonce) {
          // Check if it was our transaction
          console.log(`  🔗 EthereumMonitor: nonce advanced, re-checking receipt...`);
          const receiptCheck = await provider.getTransactionReceipt(txHash);
          if (!receiptCheck) {
            return { status: 'error', reason: 'replaced' };
          }
        }

        // Check if transaction exists
        console.log(`  🔗 EthereumMonitor: checking if tx exists in mempool...`);
        const tx = await provider.getTransaction(txHash);
        console.log(`  ✓ EthereumMonitor: tx in mempool: ${!!tx}`);
        if (!tx) {
          return { status: 'pending' };
        }

        console.log(`✅ EthereumMonitor: tx found, waiting for confirmation...`);

        // Already checked receipt above and it was null, so return pending
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
    const cacheKey = `${caip2Id}-${config.isDevnet}`;

    const cachedProvider = this.providerCache.get(cacheKey);
    if (cachedProvider) {
      return cachedProvider;
    }

    let url: string;
    switch (namespace) {
      case 'eip155':
        url = config.isDevnet
          ? `https://sepolia.infura.io/v3/${config.infuraApiKey}`
          : `https://mainnet.infura.io/v3/${config.infuraApiKey}`;
        break;
      default:
        throw new Error(`Unsupported chain namespace: ${namespace}`);
    }

    const provider = new ethers.JsonRpcProvider(url);
    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  private static async extractTransactionOutput(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt,
    provider: ethers.JsonRpcProvider,
    caip2Id: string,
    explorerDeserializationSchema: Buffer | number[],
    fromAddress: string
  ): Promise<TransactionOutput> {
    const serializationFormat = getSerializationFormat(caip2Id);
    const isContractCall = tx.data && tx.data !== '0x' && tx.data.length > 2;

    if (isContractCall && serializationFormat === SerializationFormat.ABI) {
      try {
        console.log('  📞 Getting function return value...');

        const callResult = await provider.call({
          to: tx.to,
          data: tx.data,
          from: fromAddress,
          blockTag: receipt.blockNumber - 1,
        });

        const schemaStr =
          typeof explorerDeserializationSchema === 'string'
            ? explorerDeserializationSchema
            : new TextDecoder().decode(
                new Uint8Array(explorerDeserializationSchema)
              );

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
      } catch (e) {
        console.error('Error extracting output:', e);
        return { success: true, output: { success: true } };
      }
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
