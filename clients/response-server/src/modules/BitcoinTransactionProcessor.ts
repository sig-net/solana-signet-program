import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import pc from 'picocolors';
import type {
  ProcessedTransaction,
  SignatureResponse,
  ServerConfig,
} from '../types';

const ECPair = ECPairFactory(ecc);

/**
 * Bitcoin PSBT transaction processor for P2WPKH (SegWit) transfers
 *
 * Accepts PSBT (Partially Signed Bitcoin Transaction) bytes from client.
 * PSBT format is REQUIRED because it includes witnessUtxo metadata needed for SegWit signing.
 *
 * Supported networks:
 * - Regtest (local development) - uses bitcoin.networks.regtest
 * - Testnet4 (public testing) - uses bitcoin.networks.testnet
 *
 * Requirements:
 * - Client provides PSBT bytes (BIP-174 format)
 * - All inputs must be P2WPKH (native SegWit) addresses:
 *   - Testnet: tb1q...
 *   - Regtest: bcrt1q...
 * - Each input MUST have witnessUtxo with:
 *   - script: Buffer containing the scriptPubKey
 *   - value: Amount in satoshis (number)
 *
 * Why PSBT with witnessUtxo is required:
 * - SegWit signing requires previous output value (not in raw transaction)
 * - SegWit signing requires previous scriptPubKey (not in raw transaction)
 * - witnessUtxo provides this metadata efficiently for P2WPKH
 *
 * Integration with signet.rs:
 * - signet.rs must export transactions as PSBT format (NOT raw bytes)
 * - See BITCOIN_INTEGRATION.md for implementation details
 *
 * @example
 * // Testnet4 CAIP-2 ID format:
 * // "bip122:00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043"
 * // (testnet4 genesis block hash)
 *
 * const result = await BitcoinTransactionProcessor.processTransactionForSigning(
 *   psbtBytes,
 *   derivedPrivateKey,
 *   "bip122:00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
 *   config
 * );
 */
export class BitcoinTransactionProcessor {
  static async processTransactionForSigning(
    psbtBytes: Uint8Array,
    privateKeyHex: string,
    config: ServerConfig
  ): Promise<ProcessedTransaction> {
    const network = this.getNetwork(config);

    const privateKeyBuffer = Buffer.from(privateKeyHex.slice(2), 'hex');
    const keyPair = ECPair.fromPrivateKey(privateKeyBuffer, { network });

    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network,
    });

    const psbt = bitcoin.Psbt.fromBuffer(Buffer.from(psbtBytes), { network });

    console.log(
      pc.cyan(
        `🔐 Bitcoin P2WPKH: ${pc.white(psbt.data.inputs.length)} input(s), ${pc.white(psbt.data.outputs.length)} output(s)`
      )
    );

    for (let i = 0; i < psbt.data.inputs.length; i++) {
      if (!psbt.data.inputs[i].witnessUtxo) {
        throw new Error(`Input ${i} missing witnessUtxo (required for P2WPKH)`);
      }
    }

    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txidDisplay = tx.getId();
    const signedTxHex = tx.toHex();

    console.log(pc.green(`✅ Signed: ${pc.yellow(txidDisplay)}`));
    console.log(
      pc.gray(`   Address: ${address}, Size: ${tx.virtualSize()} vbytes`)
    );

    const signatures = this.extractAllSolanaSignatures(tx);

    return {
      signedTxHash: txidDisplay,
      signature: signatures,
      signedTransaction: signedTxHex,
      fromAddress: address!,
      nonce: 0,
    };
  }

  private static getNetwork(config: ServerConfig): bitcoin.Network {
    switch (config.bitcoinNetwork) {
      case 'testnet':
        return bitcoin.networks.testnet;
      case 'regtest':
        return bitcoin.networks.regtest;
      default:
        throw new Error(
          `Unsupported Bitcoin network '${config.bitcoinNetwork}'. Only regtest and testnet are available.`
        );
    }
  }

  private static extractAllSolanaSignatures(
    tx: bitcoin.Transaction
  ): SignatureResponse[] {
    return tx.ins.map((input, i) => {
      if (!input.witness || input.witness.length < 2) {
        throw new Error(`Missing witness data in input ${i}`);
      }

      const decoded = bitcoin.script.signature.decode(input.witness[0]);
      const r = decoded.signature.subarray(0, 32);
      const s = decoded.signature.subarray(32, 64);

      for (const parity of [0x02, 0x03]) {
        const compressed = Buffer.concat([Buffer.from([parity]), r]);
        if (!ecc.isPoint(compressed)) continue;

        const uncompressed = ecc.pointCompress(compressed, false);
        if (uncompressed.length !== 65) continue;

        return {
          bigR: {
            x: Array.from(uncompressed.subarray(1, 33)),
            y: Array.from(uncompressed.subarray(33, 65)),
          },
          s: Array.from(s),
          recoveryId: parity === 0x02 ? 0 : 1,
        };
      }

      throw new Error(`Failed to reconstruct R point for input ${i}`);
    });
  }
}
