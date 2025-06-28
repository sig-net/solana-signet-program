import * as anchor from "@coral-xyz/anchor";
import * as path from "path";
import * as dotenv from "dotenv";
import { z } from "zod";
import { contracts } from "signet.js";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { Program } from "@coral-xyz/anchor";
import { ethers } from "ethers";
import bs58 from "bs58";
import { chainAdapters } from "signet.js";

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

export const bigIntPrivateKeyToNajKey = (
  privateKey: string
): `secp256k1:${string}` => {
  // Get the public key from the private key and encode as base58 x + y coordinates
  const signingKey = new ethers.SigningKey(privateKey);
  const publicKeyPoint = signingKey.publicKey;

  // Remove the '0x04' prefix (uncompressed format indicator) and get x, y coordinates
  const publicKeyHex = publicKeyPoint.slice(4); // Remove '0x04' prefix
  const xCoord = publicKeyHex.slice(0, 64); // First 32 bytes (64 hex chars)
  const yCoord = publicKeyHex.slice(64, 128); // Second 32 bytes (64 hex chars)

  // Convert to bytes and concatenate x + y
  const xBytes = Buffer.from(xCoord, "hex");
  const yBytes = Buffer.from(yCoord, "hex");
  const publicKeyBytes = Buffer.concat([xBytes, yBytes]);

  // Encode as base58
  const publicKeyBase58 = bs58.encode(publicKeyBytes);

  return `secp256k1:${publicKeyBase58}`;
};

export const getSolanaProgram = () => {
  const env = getEnv();
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
    .chainSignaturesProject as Program<ChainSignaturesProject>;

  const solContract = new contracts.solana.ChainSignatureContract({
    provider: anchor.AnchorProvider.env(),
    programId: program.programId,
    rootPublicKey: bigIntPrivateKeyToNajKey(env.PRIVATE_KEY_TESTNET),
  });

  return solContract;
};

export const getEVMChainAdapter = () => {
  const EVM = new chainAdapters.evm.EVM({
    publicClient: {} as any, // Mock viem public client
    contract: getSolanaProgram(),
  });

  return EVM;
};
