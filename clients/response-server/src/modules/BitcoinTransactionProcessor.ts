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
 * - Testnet4 (testing) - uses bitcoin.networks.testnet
 * - Mainnet (production) - uses bitcoin.networks.bitcoin
 *
 * Requirements:
 * - Client provides PSBT bytes (BIP-174 format)
 * - All inputs must be P2WPKH (native SegWit) addresses:
 *   - Mainnet: bc1q...
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
    caip2Id: string,
    config: ServerConfig
  ): Promise<ProcessedTransaction> {
    const network = this.getNetwork(caip2Id, config);

    const privateKeyBuffer = Buffer.from(privateKeyHex.slice(2), 'hex');
    const keyPair = ECPair.fromPrivateKey(privateKeyBuffer, { network });

    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network,
    });

    const networkName = config.bitcoinNetwork === 'regtest' ? 'Regtest' :
                        config.bitcoinNetwork === 'testnet' ? 'Testnet4' : 'Mainnet';
    console.log(pc.cyan(`\n🔐 Processing Bitcoin Transfer (P2WPKH - ${pc.magenta(networkName)})`));
    console.log(pc.blue(`  👤 Address: ${pc.yellow(address!)}`));

    // Parse PSBT (includes witnessUtxo metadata for SegWit signing)
    const psbt = bitcoin.Psbt.fromBuffer(Buffer.from(psbtBytes), { network });

    console.log(pc.blue(`  📥 Inputs: ${pc.white(psbt.data.inputs.length.toString())}`));
    console.log(pc.blue(`  📤 Outputs: ${pc.white(psbt.data.outputs.length.toString())}`));

    // Validate that all inputs have witnessUtxo (required for P2WPKH signing)
    for (let i = 0; i < psbt.data.inputs.length; i++) {
      const input = psbt.data.inputs[i];
      if (!input.witnessUtxo) {
        throw new Error(
          `Input ${i} is missing witnessUtxo field. ` +
            `For P2WPKH (SegWit) transactions, each input must include witnessUtxo with: ` +
            `{ script: Buffer (scriptPubKey), value: number (satoshis) }. ` +
            `Example: psbt.addInput({ hash, index, witnessUtxo: { script: Buffer.from(scriptPubKey, 'hex'), value: amount } })`
        );
      }
    }

    // Sign all inputs with derived key
    for (let i = 0; i < psbt.data.inputs.length; i++) {
      psbt.signInput(i, keyPair);
    }

    // Validate all signatures
    const allSigned = psbt.validateSignaturesOfAllInputs(
      (pubkey, msghash, sig) =>
        ECPair.fromPublicKey(pubkey).verify(msghash, sig)
    );

    if (!allSigned) {
      throw new Error('PSBT signature validation failed');
    }

    // Finalize inputs (add witness data)
    psbt.finalizeAllInputs();

    // Extract signed transaction
    const tx = psbt.extractTransaction();

    // Calculate txid
    // IMPORTANT: bitcoinjs-lib's getId() returns DISPLAY format (reversed for humans)
    // This is what block explorers and RPC APIs use for monitoring
    const txidDisplay = tx.getId(); // Display format (for monitoring)
    const txidInternal = Buffer.from(txidDisplay, 'hex').reverse(); // Internal format (for reference)

    console.log(pc.green(`\n  ✅ Signed transaction`));
    console.log(pc.cyan(`  🔐 TXID Calculation Details:`));
    console.log(pc.blue(`     • Method: tx.getId()`));
    console.log(pc.blue(`     • Raw hash: doubleSHA256(serialize_without_witness(tx))`));
    console.log(pc.blue(`     • Display format: ${pc.yellow('reverse(raw_hash)')} ← used by block explorers`));
    console.log(pc.blue(`     • Internal format: ${pc.gray('raw_hash')} ← used by Rust txid()`));
    console.log(pc.blue(`     • Canonical: ${pc.green('YES')} (excludes witness data)`));
    console.log(pc.blue(`     • Stability: ${pc.green('STABLE')} (same before/after signing for SegWit)`));
    console.log(pc.blue(`  📋 TXID Formats:`));
    console.log(pc.blue(`     • Display (for monitoring): ${pc.yellow(txidDisplay)}`));
    console.log(pc.blue(`     • Internal (Rust format):   ${pc.gray(txidInternal.toString('hex'))}`));
    console.log(pc.blue(`     • Display bytes (first 8):  [${pc.yellow(Array.from(Buffer.from(txidDisplay, 'hex')).slice(0, 8).join(', '))}...]`));
    console.log(pc.blue(`     • Internal bytes (first 8): [${pc.gray(Array.from(txidInternal).slice(0, 8).join(', '))}...]`));
    console.log(pc.blue(`  📦 Size: ${pc.white(tx.virtualSize().toString())} vbytes (includes witness)`));

    // Extract all signatures from witness data
    const signatures = this.extractAllSolanaSignatures(tx);
    console.log(
      pc.blue(`  🔏 Extracted ${pc.white(signatures.length.toString())} signature(s) from ${pc.white(tx.ins.length.toString())} input(s)`)
    );

    // Return display format for monitoring (block explorers use this)
    return {
      signedTxHash: txidDisplay,
      signature: signatures,
      signedTransaction: tx.toHex(),
      fromAddress: address!,
      nonce: 0,
    };
  }

  private static getNetwork(
    _caip2Id: string,
    config: ServerConfig
  ): bitcoin.Network {
    switch (config.bitcoinNetwork) {
      case 'mainnet':
        return bitcoin.networks.bitcoin;
      case 'testnet':
        return bitcoin.networks.testnet;
      case 'regtest':
        return bitcoin.networks.regtest;
    }
  }

  /**
   * Extracts all signatures from Bitcoin transaction for Solana verification.
   *
   * For PSBTs with multiple inputs, each input has its own signature.
   * This implementation extracts and returns ALL signatures from ALL inputs.
   */
  private static extractAllSolanaSignatures(
    tx: bitcoin.Transaction
  ): SignatureResponse[] {
    const signatures: SignatureResponse[] = [];

    for (let i = 0; i < tx.ins.length; i++) {
      const witness = tx.ins[i]?.witness;

      if (!witness || witness.length < 2) {
        throw new Error(`Missing witness data in input ${i}`);
      }

      // Witness[0] is DER signature + sighash byte
      const signatureWithSighash = witness[0];

      // Decode DER signature to get r and s (64 bytes total)
      const decoded = bitcoin.script.signature.decode(signatureWithSighash);
      const r = Buffer.from(decoded.signature.subarray(0, 32));
      const s = Buffer.from(decoded.signature.subarray(32, 64));

      // Reconstruct R point (x, y) from r value
      // Try both possible y-coordinates (even=0x02, odd=0x03)
      let uncompressed: Uint8Array | null = null;
      let recoveryId = 0;

      for (const parity of [0x02, 0x03]) {
        const compressed = Buffer.concat([Buffer.from([parity]), r]);

        if (ecc.isPoint(compressed)) {
          // Decompress to get full 65-byte point (0x04 + 32-byte x + 32-byte y)
          uncompressed = ecc.pointCompress(compressed, false);
          recoveryId = parity === 0x02 ? 0 : 1;
          break;
        }
      }

      if (!uncompressed || uncompressed.length !== 65) {
        throw new Error(`Failed to reconstruct R point for input ${i}`);
      }

      // Extract x and y coordinates (skip first byte 0x04)
      const rx = Buffer.from(uncompressed.subarray(1, 33));
      const ry = Buffer.from(uncompressed.subarray(33, 65));

      signatures.push({
        bigR: {
          x: Array.from(rx),
          y: Array.from(ry),
        },
        s: Array.from(s),
        recoveryId,
      });
    }

    return signatures;
  }
}
