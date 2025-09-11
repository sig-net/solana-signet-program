import { ethers } from "ethers";
import { CONFIG } from "./config";
import { TransactionOutput } from "./types";

export class EthereumMonitor {
  static async waitForTransactionAndGetOutput(
    txHash: string,
    slip44ChainId: number,
    explorerDeserializationFormat: number,
    explorerDeserializationSchema: any,
    fromAddress: string
  ): Promise<TransactionOutput> {
    const provider = this.getProvider(slip44ChainId);

    console.log(`⏳ Checking transaction ${txHash}...`);

    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      throw new Error("Transaction not found");
    }

    console.log(`✅ Transaction found! Waiting for confirmation...`);

    const receipt = await provider.waitForTransaction(
      txHash,
      1,
      CONFIG.TX_TIMEOUT_MS
    );
    if (!receipt) {
      throw new Error("Transaction receipt not found");
    }

    console.log(`  📦 Block number: ${receipt.blockNumber}`);
    console.log(
      `  ${receipt.status === 1 ? "✅" : "❌"} Status: ${
        receipt.status === 1 ? "Success" : "Failed"
      }`
    );

    if (receipt.status === 0) {
      return { success: false, output: null };
    }

    return await this.extractTransactionOutput(
      tx,
      receipt,
      provider,
      explorerDeserializationFormat,
      explorerDeserializationSchema,
      fromAddress
    );
  }

  private static getProvider(slip44ChainId: number): ethers.JsonRpcProvider {
    const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
    const isDevnet = rpcUrl.includes("devnet");

    switch (slip44ChainId) {
        case 60: // Ethereum
        if (isDevnet) {
          const url =
            process.env.SEPOLIA_RPC_URL ||
            `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`;
          console.log("  🌐 Using Ethereum Sepolia");
          return new ethers.JsonRpcProvider(url);
        } else {
          const url =
            process.env.ETHEREUM_RPC_URL || "https://eth.llamarpc.com";
          console.log("  🌐 Using Ethereum Mainnet");
          return new ethers.JsonRpcProvider(url);
        }
      default:
        throw new Error(`Unsupported SLIP-44 chain ID: ${slip44ChainId}`);
    }
  }

  private static async extractTransactionOutput(
    tx: ethers.TransactionResponse,
    receipt: ethers.TransactionReceipt,
    provider: ethers.JsonRpcProvider,
    explorerDeserializationFormat: number,
    explorerDeserializationSchema: any,
    fromAddress: string
  ): Promise<TransactionOutput> {
    const isContractCall = tx.data && tx.data !== "0x" && tx.data.length > 2;

    if (isContractCall && explorerDeserializationFormat === 1) {
      try {
        console.log("  📞 Getting function return value...");

        const callResult = await provider.call({
          to: tx.to,
          data: tx.data,
          from: fromAddress,
          blockTag: receipt.blockNumber - 1,
        });

        const schemaStr =
          typeof explorerDeserializationSchema === "string"
            ? explorerDeserializationSchema
            : new TextDecoder().decode(
                new Uint8Array(explorerDeserializationSchema)
              );

        const schema = JSON.parse(schemaStr);
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          schema.map((s: any) => s.type),
          callResult
        );

        const decodedOutput: any = {};
        schema.forEach((field: any, index: number) => {
          decodedOutput[field.name] = decoded[index];
        });

        console.log("  📊 Decoded output:", decodedOutput);
        return { success: true, output: decodedOutput };
      } catch (e) {
        console.error("  ⚠️ Error getting function return value:", e);
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