import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { ethers } from "ethers";
import { contracts } from "signet.js";
import {
  EPSILON_DERIVATION_PREFIX,
  SOLANA_CHAIN_ID,
  SECP256K1_CURVE_ORDER,
} from "./constants";
import { getEnv } from "./utils";

const eventNames = {
  signatureRequestedEvent: "signatureRequestedEvent",
  signatureResponseEvent: "signatureResponseEvent",
} as const;

const env = getEnv();

/**
 * Derives a signing key for a specific path and predecessor using epsilon derivation.
 * This function combines epsilon calculation and key derivation into a single operation.
 *
 * @param path - The derivation path
 * @param predecessor - The predecessor address (requester)
 * @param basePrivateKey - The base private key to derive from
 * @returns The derived private key as a hex string
 */
async function deriveSigningKey(
  path: string,
  predecessor: string,
  basePrivateKey: string
): Promise<string> {
  const derivationPath = `${EPSILON_DERIVATION_PREFIX},${SOLANA_CHAIN_ID},${predecessor},${path}`;

  const epsilonHash = ethers.keccak256(ethers.toUtf8Bytes(derivationPath));
  const epsilon = BigInt(epsilonHash);

  // Derive the new private key by adding epsilon to the base key (mod curve order)
  const basePrivateKeyBigInt = BigInt(basePrivateKey);
  const derivedPrivateKey =
    (basePrivateKeyBigInt + epsilon) % SECP256K1_CURVE_ORDER;

  return "0x" + derivedPrivateKey.toString(16).padStart(64, "0");
}

async function signMessage(
  msgHash: number[] | string,
  privateKeyHex: string
): Promise<any> {
  const msgHashHex =
    typeof msgHash === "string"
      ? msgHash
      : "0x" + Buffer.from(msgHash).toString("hex");

  const signingKey = new ethers.SigningKey(privateKeyHex);
  const signature = signingKey.sign(msgHashHex);

  // Use ethers.js built-in recovery functionality
  const recoveredPublicKey = ethers.SigningKey.recoverPublicKey(
    msgHashHex,
    signature
  );
  const publicKeyPoint = ethers.getBytes(recoveredPublicKey);

  // Extract x and y coordinates from the uncompressed public key
  // Skip the first byte (0x04 prefix) and get x (32 bytes) and y (32 bytes)
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
export class MockSignerServer {
  private program: Program<ChainSignaturesProject>;
  private solContract: contracts.solana.ChainSignatureContract;
  private wallet: any;
  private eventListenerId: number | null = null;

  constructor({
    provider,
    signetSolContract,
  }: {
    provider: anchor.AnchorProvider;
    signetSolContract: contracts.solana.ChainSignatureContract;
  }) {
    this.wallet = provider.wallet;
    this.program = anchor.workspace
      .chainSignaturesProject as Program<ChainSignaturesProject>;
    this.solContract = signetSolContract;
  }

  async start(): Promise<void> {
    this.eventListenerId = this.program.addEventListener(
      eventNames.signatureRequestedEvent,
      async (event, slot) => {
        try {
          const requestId = this.solContract.getRequestId(
            {
              payload: event.payload,
              path: event.path,
              key_version: event.keyVersion,
            },
            {
              algo: event.algo,
              dest: event.dest,
              params: event.params,
            }
          );

          const requestIdBytes = Array.from(
            Buffer.from(requestId.slice(2), "hex")
          );

          const derivedPrivateKeyHex = await deriveSigningKey(
            event.path,
            event.sender.toString(),
            env.PRIVATE_KEY_TESTNET
          );

          const signature = await signMessage(
            event.payload,
            derivedPrivateKeyHex
          );

          await this.program.methods
            .respond([requestIdBytes], [signature])
            .accounts({
              responder: this.wallet.publicKey,
            })
            .rpc();
        } catch (error) {
          console.error("Error sending signature response:", error);
        }
      }
    );
  }

  async stop(): Promise<void> {
    // Remove all event listeners
    if (this.eventListenerId !== null) {
      this.program.removeEventListener(this.eventListenerId);
      this.eventListenerId = null;
    }
  }
}
