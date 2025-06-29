import { ethers } from "ethers";
import {
  EPSILON_DERIVATION_PREFIX,
  SOLANA_CHAIN_ID,
  SECP256K1_CURVE_ORDER,
} from "./constants";

/**
 * Derives a signing key for a specific path and predecessor using epsilon derivation.
 */
export async function deriveSigningKey(
  path: string,
  predecessor: string,
  basePrivateKey: string
): Promise<string> {
  const derivationPath = `${EPSILON_DERIVATION_PREFIX},${SOLANA_CHAIN_ID},${predecessor},${path}`;

  const epsilonHash = ethers.keccak256(ethers.toUtf8Bytes(derivationPath));
  const epsilon = BigInt(epsilonHash);

  const basePrivateKeyBigInt = BigInt(basePrivateKey);
  const derivedPrivateKey =
    (basePrivateKeyBigInt + epsilon) % SECP256K1_CURVE_ORDER;

  return "0x" + derivedPrivateKey.toString(16).padStart(64, "0");
}

export async function signMessage(
  msgHash: number[] | string,
  privateKeyHex: string
): Promise<any> {
  const msgHashHex =
    typeof msgHash === "string"
      ? msgHash
      : "0x" + Buffer.from(msgHash).toString("hex");

  const signingKey = new ethers.SigningKey(privateKeyHex);
  const signature = signingKey.sign(msgHashHex);

  const recoveredPublicKey = ethers.SigningKey.recoverPublicKey(
    msgHashHex,
    signature
  );
  const publicKeyPoint = ethers.getBytes(recoveredPublicKey);

  const x = publicKeyPoint.slice(1, 33);
  const y = publicKeyPoint.slice(33, 65);

  return {
    bigR: {
      x: Array.from(Buffer.from(signature.r.slice(2), "hex")),
      y: Array.from(y),
    },
    s: Array.from(Buffer.from(signature.s.slice(2), "hex")),
    recoveryId: signature.v - 27,
  };
}
