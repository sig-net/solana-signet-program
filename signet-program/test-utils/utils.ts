import * as path from "path";
import * as dotenv from "dotenv";
import { z } from "zod";
import { ethers } from "ethers";
import bs58 from "bs58";

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const envSchema = z.object({
  PRIVATE_KEY_TESTNET: z.string().min(1, "PRIVATE_KEY_TESTNET is required"),
});

export const getEnv = () => {
  const result = envSchema.safeParse({
    PRIVATE_KEY_TESTNET: process.env.PRIVATE_KEY_TESTNET,
  });

  if (!result.success) {
    throw new Error(`Environment validation failed: ${result.error.message}`);
  }

  return result.data;
};

/**
 * Converts a private key to a NEAR Account JSON (NAJ) formatted public key.
 *
 * @param privateKey - The private key in hex format (with or without 0x prefix)
 * @returns A NEAR-formatted public key string in the format `secp256k1:{base58_encoded_coordinates}`
 *
 * @example
 * ```typescript
 * const privateKey = "0x1234567890abcdef...";
 * const najPublicKey = bigintPrivateKeyToNajPublicKey(privateKey);
 * // Returns: "secp256k1:ABC123..." where ABC123... is the base58-encoded x,y coordinates
 * ```
 */
export const bigintPrivateKeyToNajPublicKey = (
  privateKey: string
): `secp256k1:${string}` => {
  const signingKey = new ethers.SigningKey(privateKey);
  const publicKeyPoint = signingKey.publicKey;

  const publicKeyHex = publicKeyPoint.slice(4); // Remove '0x04' prefix
  const xCoord = publicKeyHex.slice(0, 64); // First 32 bytes (64 hex chars)
  const yCoord = publicKeyHex.slice(64, 128); // Second 32 bytes (64 hex chars)

  const xBytes = Buffer.from(xCoord, "hex");
  const yBytes = Buffer.from(yCoord, "hex");
  const publicKeyBytes = Buffer.concat([xBytes, yBytes]);

  const publicKeyBase58 = bs58.encode(publicKeyBytes);

  return `secp256k1:${publicKeyBase58}`;
};
