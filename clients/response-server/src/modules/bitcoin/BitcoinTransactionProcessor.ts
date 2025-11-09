import * as bitcoin from 'bitcoinjs-lib';
import pc from 'picocolors';
import type { ServerConfig } from '../../types';

export interface BitcoinInputSigningPlan {
  inputIndex: number;
  sighash: Uint8Array;
  prevTxid: string;
  vout: number;
}

export interface BitcoinSigningPlan {
  txid: string; // canonical (big-endian) txid
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
    config: ServerConfig
  ): BitcoinSigningPlan {
    const network = this.getNetwork(config);
    const psbt = bitcoin.Psbt.fromBuffer(Buffer.from(psbtBytes), { network });
    const unsignedTx = psbt.data.globalMap
      .unsignedTx as unknown as bitcoin.Transaction;

    console.log(
      pc.cyan(
        `🔐 Bitcoin PSBT: ${pc.white(psbt.data.inputs.length)} input(s), ${pc.white(psbt.data.outputs.length)} output(s)`
      )
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

      const sighashType =
        inputData.sighashType ?? bitcoin.Transaction.SIGHASH_ALL;
      const sighash = unsignedTx.hashForWitnessV0(
        i,
        witnessUtxo.script,
        witnessUtxo.value,
        sighashType
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
      txid: unsignedTx.getId(),
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
