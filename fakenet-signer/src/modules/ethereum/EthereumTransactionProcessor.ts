import { ethers } from 'ethers';
import {
  ProcessedTransaction,
  ServerConfig,
  SignatureResponse,
} from '../../types';
import { getNamespaceFromCaip2 } from '../ChainUtils';

export class EthereumTransactionProcessor {
  private static fundingProvider: ethers.JsonRpcProvider | null = null;
  private static fundingProviderError: boolean = false;

  static async processTransactionForSigning(
    rlpEncodedTx: Uint8Array,
    privateKey: string,
    caip2Id: string,
    config: ServerConfig
  ): Promise<ProcessedTransaction> {
    console.log('\n🔐 Processing the Transaction for Signing');
    console.log('  📋 RLP-encoded transaction:', ethers.hexlify(rlpEncodedTx));
    console.log('  🔗 Chain ID:', caip2Id);

    // Detect transaction type
    const isEIP1559 = rlpEncodedTx[0] === 0x02;
    const txType = isEIP1559 ? 0x02 : 0x00;
    const rlpData = isEIP1559 ? rlpEncodedTx.slice(1) : rlpEncodedTx;

    console.log(`  📝 Transaction type: ${isEIP1559 ? 'EIP-1559' : 'Legacy'}`);

    // Create wallet and sign
    const wallet = new ethers.Wallet(privateKey);
    console.log('  👤 Signing address:', wallet.address);

    const unsignedTxHash = ethers.keccak256(rlpEncodedTx);
    const signature = wallet.signingKey.sign(unsignedTxHash);

    // Decode and prepare signed transaction
    const decoded = ethers.decodeRlp(rlpData) as string[];
    const nonceField = isEIP1559 ? decoded[1] : decoded[0];
    if (nonceField === undefined) {
      throw new Error('Missing nonce field in RLP-decoded transaction');
    }
    const nonce =
      nonceField === '' || nonceField === '0x' ? 0 : parseInt(nonceField, 16);
    if (Number.isNaN(nonce)) {
      throw new Error('Invalid nonce field in RLP-decoded transaction');
    }
    console.log(' 📝 Transaction nonce:', nonce);
    const yParity = signature.yParity ?? signature.v - 27;
    let vValue: number | bigint;
    if (isEIP1559) {
      vValue = yParity;
    } else {
      if (decoded.length >= 7) {
        const chainIdField = decoded[6];
        let chainId = 0n;
        if (chainIdField && chainIdField !== '0x') {
          try {
            chainId = BigInt(chainIdField);
          } catch {
            chainId = 0n;
          }
        }
        vValue = 35n + 2n * chainId + BigInt(yParity);
      } else {
        vValue = signature.v;
      }
    }

    const signedFields = [
      ...decoded,
      ethers.toBeHex(vValue, 1),
      signature.r,
      signature.s,
    ];

    const signedRlp = ethers.encodeRlp(signedFields);
    const signedTransaction = isEIP1559
      ? ethers.concat([new Uint8Array([txType]), signedRlp])
      : signedRlp;

    // Get correct transaction hash
    let signedTxHash: string;
    try {
      const parsedTx = ethers.Transaction.from(signedTransaction);
      signedTxHash = parsedTx.hash ?? ethers.keccak256(signedTransaction);
    } catch {
      signedTxHash = ethers.keccak256(signedTransaction);
    }

    // Convert signature to Solana format (single signature for EVM transactions)
    const solanaSignature = this.toSolanaSignature(signature);

    const namespace = getNamespaceFromCaip2(caip2Id);
    if (namespace === 'eip155') {
      /// FUNDING DERIVED ADDRESS WITH ETH CODE
      const tx = ethers.Transaction.from(ethers.hexlify(rlpEncodedTx));
      const gasPrice = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
      const gasNeeded = tx.gasLimit * gasPrice + tx.value;

      // Don't retry if we already know it's broken
      if (this.fundingProviderError) {
        console.error(
          'Funding provider is unavailable, skipping balance check'
        );
        return {
          signedTxHash,
          signature: [solanaSignature], // EVM has single signature
          signedTransaction: ethers.hexlify(signedTransaction),
          fromAddress: wallet.address,
          nonce,
        };
      }

      try {
        if (!this.fundingProvider) {
          console.log(`  🔗 EthereumTxProcessor: initializing funding provider...`);
          const url = `https://sepolia.infura.io/v3/${config.infuraApiKey}`;
          this.fundingProvider = new ethers.JsonRpcProvider(url);
          await this.fundingProvider.getNetwork();
          console.log(`  ✓ EthereumTxProcessor: funding provider ready`);
        }

        console.log(`  🔗 EthereumTxProcessor: checking balance for ${wallet.address}...`);
        const balance = await this.fundingProvider.getBalance(wallet.address);
        console.log(`  ✓ EthereumTxProcessor: balance=${ethers.formatEther(balance)} ETH, needed=${ethers.formatEther(gasNeeded)} ETH`);
        if (balance < gasNeeded) {
          const fundingWallet = new ethers.Wallet(
            config.mpcRootKey,
            this.fundingProvider
          );
          const fundingAmount = gasNeeded - balance;
          console.log(`  💸 EthereumTxProcessor: funding ${ethers.formatEther(fundingAmount)} ETH...`);
          console.log(`  ⏳ EthereumTxProcessor: sending funding tx and waiting for confirmation (THIS CAN HANG)...`);
          await fundingWallet
            .sendTransaction({
              to: wallet.address,
              value: fundingAmount,
            })
            .then((tx) => {
              console.log(`  📤 EthereumTxProcessor: funding tx sent: ${tx.hash}`);
              return tx.wait();
            });
          console.log(`  ✅ EthereumTxProcessor: funding confirmed`);
        }
      } catch (error) {
        console.error('Funding provider error:', error);
        this.fundingProviderError = true;
      }
    }

    return {
      signedTxHash,
      signature: [solanaSignature], // EVM has single signature
      signedTransaction: ethers.hexlify(signedTransaction),
      fromAddress: wallet.address,
      nonce,
    };
  }

  private static toSolanaSignature(
    signature: ethers.Signature
  ): SignatureResponse {
    const prefix = signature.yParity === 0 ? '02' : '03';
    const compressed = prefix + signature.r.slice(2);
    const point = ethers.SigningKey.computePublicKey('0x' + compressed, false);
    const pointBytes = ethers.getBytes(point);

    return {
      bigR: {
        x: Array.from(Buffer.from(signature.r.slice(2), 'hex')),
        y: Array.from(pointBytes.slice(33, 65)),
      },
      s: Array.from(Buffer.from(signature.s.slice(2), 'hex')),
      recoveryId: signature.yParity || 0,
    };
  }
}
