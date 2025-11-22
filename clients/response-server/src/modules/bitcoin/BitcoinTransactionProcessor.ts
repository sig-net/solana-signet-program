import * as bitcoin from 'bitcoinjs-lib';
import type { ServerConfig } from '../../types';
import { AppLogger } from '../logger/AppLogger';

export interface BitcoinInputSigningPlan {
  inputIndex: number;
  sighash: Uint8Array;
  prevTxid: string;
  vout: number;
}

export interface BitcoinSigningPlan {
  /**
   * Explorer-facing txid (Transaction.getId). Always the hex string you would
   * paste into a block explorer; never the little-endian buffer that
   * bitcoinjs-lib exposes internally.
   */
  explorerTxid: string;
  inputs: BitcoinInputSigningPlan[];
}

/**
 * Pre-compute signing material for each PSBT input.
 *
 * The MPC signer derives the per-input BIP-143 digest once, responds one
 * signature per request ID, and never needs to mutate the PSBT afterwards.
 */
export class BitcoinTransactionProcessor {
  static createSigningPlan(
    psbtBytes: Uint8Array,
    config: ServerConfig,
    logger: AppLogger
  ): BitcoinSigningPlan {
    const network = this.getNetwork(config);
    const psbt = bitcoin.Psbt.fromBuffer(Buffer.from(psbtBytes), { network });
    /**
     * In bitcoinjs-lib v6 the unsigned transaction inside a PSBT is a
     * `PsbtTransaction` (no hash helpers). Convert it to a full
     * `bitcoin.Transaction` via its `toBuffer()` method so we can call
     * `hashForWitnessV0` idiomatically without peeking at private caches.
     */
    const unsignedTxBuffer = psbt.data.globalMap.unsignedTx.toBuffer();
    const unsignedTx = bitcoin.Transaction.fromBuffer(unsignedTxBuffer);

    const colors = AppLogger.colors;
    logger.info(
      `🔐 Bitcoin PSBT: ${colors.value(psbt.data.inputs.length)} input(s), ${colors.value(psbt.data.outputs.length)} output(s)`
    );

    const inputs: BitcoinInputSigningPlan[] = [];

    for (let i = 0; i < psbt.data.inputs.length; i++) {
      const inputData = psbt.data.inputs[i];
      const witnessUtxo = inputData.witnessUtxo;

      if (!witnessUtxo) {
        throw new Error(
          `Input ${i} missing witnessUtxo (required for SegWit signing)`
        );
      }

      // Derive the correct scriptCode for SegWit v0 P2WPKH:
      // scriptCode = legacy P2PKH script over the witness program's pubkey hash.
      const isP2wpkh =
        witnessUtxo.script.length === 22 &&
        witnessUtxo.script[0] === 0x00 &&
        witnessUtxo.script[1] === 0x14;
      const scriptCode = isP2wpkh
        ? bitcoin.payments.p2pkh({
            hash: witnessUtxo.script.slice(2),
            network,
          }).output!
        : witnessUtxo.script;

      const sighashType =
        inputData.sighashType ?? bitcoin.Transaction.SIGHASH_ALL;
      const sighash = unsignedTx.hashForWitnessV0(
        i,
        scriptCode,
        witnessUtxo.value,
        sighashType
      );

      logger.info(
        {
          inputIndex: i,
          scriptCodeHex: Buffer.from(scriptCode).toString('hex'),
          witnessScriptHex: Buffer.from(witnessUtxo.script).toString('hex'),
          value: witnessUtxo.value,
          sighashType,
          sighashHex: Buffer.from(sighash).toString('hex'),
        },
        '🧮 Computed sighash for input'
      );

      const prevTxid = Buffer.from(psbt.txInputs[i].hash)
        .reverse()
        .toString('hex');
      const vout = psbt.txInputs[i].index;

      inputs.push({
        inputIndex: i,
        sighash: new Uint8Array(sighash),
        prevTxid,
        vout,
      });
    }

    return {
      explorerTxid: unsignedTx.getId(),
      inputs,
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
}
