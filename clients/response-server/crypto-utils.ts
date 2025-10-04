import { CONFIG } from './config';
import { ethers } from 'ethers';
import { SignatureResponse } from './types';

export class CryptoUtils {
  static deriveEpsilon(requester: string, path: string): bigint {
    const derivationPath = `${CONFIG.EPSILON_DERIVATION_PREFIX},${CONFIG.SOLANA_CHAIN_ID},${requester},${path}`;
    const hash = ethers.keccak256(ethers.toUtf8Bytes(derivationPath));
    return BigInt(hash);
  }

  static async deriveSigningKey(
    path: string,
    predecessor: string,
    basePrivateKey: string
  ): Promise<string> {
    const epsilon = this.deriveEpsilon(predecessor, path);
    const privateKeyBigInt = BigInt(basePrivateKey);
    const derivedPrivateKey =
      (privateKeyBigInt + epsilon) % BigInt(CONFIG.SECP256K1_N);
    return '0x' + derivedPrivateKey.toString(16).padStart(64, '0');
  }

  static async signMessage(
    msgHash: number[] | string,
    privateKeyHex: string
  ): Promise<SignatureResponse> {
    const msgHashHex =
      typeof msgHash === 'string'
        ? msgHash
        : '0x' + Buffer.from(msgHash).toString('hex');

    const signingKey = new ethers.SigningKey(privateKeyHex);
    const signature = signingKey.sign(msgHashHex);

    const recoveredPublicKey = ethers.SigningKey.recoverPublicKey(
      msgHashHex,
      signature
    );
    const publicKeyPoint = ethers.getBytes(recoveredPublicKey);

    const y = publicKeyPoint.slice(33, 65);

    return {
      bigR: {
        x: Array.from(Buffer.from(signature.r.slice(2), 'hex')),
        y: Array.from(y),
      },
      s: Array.from(Buffer.from(signature.s.slice(2), 'hex')),
      recoveryId: signature.v - 27,
    };
  }

  static async signBidirectionalResponse(
    requestId: Uint8Array,
    serializedOutput: Uint8Array,
    privateKeyHex: string
  ): Promise<SignatureResponse> {
    const combined = new Uint8Array(requestId.length + serializedOutput.length);
    combined.set(requestId);
    combined.set(serializedOutput, requestId.length);
    const messageHash = ethers.keccak256(combined);
    return this.signMessage(messageHash, privateKeyHex);
  }
}
