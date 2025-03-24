import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { ChainSignaturesProject } from "./types/chain_signatures_project";
import IDL from "./idl/chain_signatures_project.json";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const EPSILON_DERIVATION_PREFIX = "sig.network v1.0.0 epsilon derivation";

function generateRequestId(
  addr: string,
  payload: number[],
  path: string,
  keyVersion: number,
  chainId: number | string,
  algo: string,
  dest: string,
  params: string
): string {
  const payloadHex = "0x" + Buffer.from(payload).toString("hex");

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "string",
      "bytes",
      "string",
      "uint32",
      "uint256",
      "string",
      "string",
      "string",
    ],
    [addr, payloadHex, path, keyVersion, chainId, algo, dest, params]
  );

  return ethers.keccak256(encoded);
}

function loadSolanaKeypair(): Keypair {
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  const keypairString = fs.readFileSync(keypairPath, { encoding: "utf-8" });
  const keypairData = JSON.parse(keypairString);
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

function deriveEpsilonSol(requester: string, path: string): bigint {
  const chainId = "0x800001f5";

  const derivationPath = `${EPSILON_DERIVATION_PREFIX},${chainId},${requester},${path}`;
  console.log("Derivation path:", derivationPath);

  const hash = ethers.keccak256(ethers.toUtf8Bytes(derivationPath));
  return BigInt(hash);
}

async function deriveSigningKey(
  path: string,
  predecessor: string,
  basePrivateKey: string
): Promise<string> {
  const epsilon = deriveEpsilonSol(predecessor, path);
  const privateKeyBigInt = BigInt(basePrivateKey);
  const curveOrder = BigInt(
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
  );
  const derivedPrivateKey = (privateKeyBigInt + BigInt(epsilon)) % curveOrder;
  return "0x" + derivedPrivateKey.toString(16).padStart(64, "0");
}

function modularSquareRoot(n: bigint, p: bigint): bigint {
  if (n === 0n) return 0n;
  if (p % 4n === 3n) {
    const sqrt = powerMod(n, (p + 1n) / 4n, p);
    return sqrt;
  }
  throw new Error("Modulus not supported");
}

function powerMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base = base % modulus;
  while (exponent > 0n) {
    if (exponent % 2n === 1n) {
      result = (result * base) % modulus;
    }
    base = (base * base) % modulus;
    exponent = exponent / 2n;
  }
  return result;
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

  const rBigInt = BigInt(signature.r);
  const p = BigInt(
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F"
  );
  const ySquared = (rBigInt ** 3n + 7n) % p;
  const y = modularSquareRoot(ySquared, p);
  const recoveryId = signature.v - 27;
  const yParity = recoveryId;
  const rY = y % 2n === BigInt(yParity) ? y : p - y;

  return {
    bigR: {
      x: Array.from(Buffer.from(signature.r.slice(2), "hex")),
      y: Array.from(Buffer.from(rY.toString(16).padStart(64, "0"), "hex")),
    },
    s: Array.from(Buffer.from(signature.s.slice(2), "hex")),
    recoveryId,
  };
}

async function main() {
  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  const wallet = new anchor.Wallet(loadSolanaKeypair());
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program<ChainSignaturesProject>(IDL, provider);

  console.log("Using Solana wallet:", wallet.publicKey.toString());
  console.log(
    "Using Ethereum private key:",
    process.env.PRIVATE_KEY_TESTNET!.slice(0, 6) +
      "..." +
      process.env.PRIVATE_KEY_TESTNET!.slice(-4)
  );
  console.log("Starting to listen for signature requests...");

  program.addEventListener("signatureRequestedEvent", async (event, slot) => {
    console.log("New signature request received at slot:", slot);
    console.log("Event:", event);

    try {
      const requestId = generateRequestId(
        event.sender.toString(),
        event.payload,
        event.path,
        event.keyVersion,
        0,
        event.algo,
        event.dest,
        event.params
      );

      console.log("Generated request ID:", requestId);

      const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

      const derivedPrivateKeyHex = await deriveSigningKey(
        event.path,
        event.sender.toString(),
        process.env.PRIVATE_KEY_TESTNET!
      );

      console.log(
        "Payload to sign:",
        Buffer.from(event.payload).toString("hex")
      );

      const signature = await signMessage(event.payload, derivedPrivateKeyHex);

      console.log("Generated signature:", signature);

      const tx = await program.methods
        .respond([requestIdBytes], [signature])
        .accounts({
          responder: wallet.publicKey,
        })
        .rpc();

      console.log("Signature response sent successfully!");
      console.log("Transaction signature:", tx);
    } catch (error) {
      console.error("Error sending signature response:", error);
    }
  });

  console.log("Server running. Press Ctrl+C to exit.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
