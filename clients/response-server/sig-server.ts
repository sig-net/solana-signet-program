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
import bs58 from "bs58";
import { ANCHOR_EMIT_CPI_CALL_BACK_DISCRIMINATOR } from "../../signet-program/test-utils/constants";

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
  if (process.env.SOLANA_PRIVATE_KEY) {
    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    try {
      const privateKey = JSON.parse(privateKeyString);
      return Keypair.fromSecretKey(new Uint8Array(privateKey));
    } catch (e) {
      throw new Error(`Failed to parse SOLANA_PRIVATE_KEY: ${e}`);
    }
  }

  try {
    const keypairPath =
      process.env.KEYPAIR_PATH ||
      path.join(os.homedir(), ".config", "solana", "id.json");
    const keypairString = fs.readFileSync(keypairPath, { encoding: "utf-8" });
    const keypairData = JSON.parse(keypairString);
    return Keypair.fromSecretKey(new Uint8Array(keypairData));
  } catch (e) {
    throw new Error(`Failed to load keypair from file: ${e}`);
  }
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

async function parseCpiEvents(
  connection: Connection,
  signature: string,
  targetProgramId: string,
  program: Program<ChainSignaturesProject>
): Promise<any[]> {
  const events: any[] = [];

  try {
    // Get the transaction with JsonParsed encoding to access inner instructions
    // CPI events appear as inner instructions when emit_cpi! is used
    const tx = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) return events;

    // Inner instructions contain CPI calls made during transaction execution
    // When emit_cpi! is used, it creates an inner instruction to the program itself
    const innerInstructions = tx.meta.innerInstructions || [];

    for (const innerIxSet of innerInstructions) {
      for (const instruction of innerIxSet.instructions) {
        // Check for PartiallyDecoded instructions from our target program
        if (
          "programId" in instruction &&
          "data" in instruction &&
          instruction.programId.toString() === targetProgramId
        ) {
          try {
            // Decode the base58 instruction data
            const ixData = bs58.decode(instruction.data);

            // Check if this is an emit_cpi! instruction
            // The instruction data format is:
            // [0-8]:   emit_cpi! instruction discriminator
            // [8-16]:  event discriminator (identifies which event type)
            // [16+]:   event data (the actual event fields)
            if (
              ixData.length >= 16 &&
              Buffer.compare(
                ixData.subarray(0, 8),
                ANCHOR_EMIT_CPI_CALL_BACK_DISCRIMINATOR
              ) === 0
            ) {
              // Extract the event discriminator (bytes 8-16)
              const eventDiscriminator = ixData.subarray(8, 16);

              // Extract the event data (after byte 16)
              const eventData = ixData.subarray(16);

              // Match the event discriminator against our IDL to identify the event type
              // The IDL contains the discriminator for each event as an array of bytes
              // For example, SignatureRequestedEvent has discriminator [171, 129, 105, 91, 154, 49, 160, 34]
              // which is ab81695b9a31a022 in hex
              let matchedEvent = null;
              for (const event of program.idl.events || []) {
                // Convert the discriminator array from IDL to Buffer for comparison
                const idlDiscriminator = Buffer.from(event.discriminator);

                if (
                  Buffer.compare(eventDiscriminator, idlDiscriminator) === 0
                ) {
                  matchedEvent = event;
                  break;
                }
              }

              if (matchedEvent) {
                try {
                  // Reconstruct the full event buffer for Anchor's BorshEventCoder
                  // The coder expects: [event discriminator (8 bytes) + event data]
                  const fullEventData = Buffer.concat([
                    eventDiscriminator,
                    eventData,
                  ]);

                  // Decode using Anchor's BorshEventCoder
                  const eventCoder = new anchor.BorshEventCoder(program.idl);
                  const decodedEvent = eventCoder.decode(
                    fullEventData.toString("base64")
                  );

                  if (decodedEvent) {
                    events.push(decodedEvent);
                  }
                } catch (decodeError) {
                  console.log("Failed to decode event data:", decodeError);
                }
              }
            }
          } catch (e) {
            // Not our event, continue
          }
        }
      }
    }
  } catch (error) {
    console.error("Error parsing transaction for CPI events:", error);
  }

  return events;
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
  console.log("Watching program:", program.programId.toString());

  // Check wallet balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Wallet balance:", balance / 1e9, "SOL");
  if (balance < 0.01 * 1e9) {
    console.warn(
      "⚠️  Low balance! You may need more SOL to respond to signature requests."
    );
  }

  // Subscribe to program logs - same approach as Rust code
  const subscriptionId = connection.onLogs(
    program.programId,
    async (logs) => {
      // Skip failed transactions - CPI events require valid transactions
      if (logs.err) {
        return;
      }

      // Check if this is a Sign instruction
      if (logs.logs.some((log) => log.includes("Instruction: Sign"))) {
        // Parse CPI events from inner instructions
        const events = await parseCpiEvents(
          connection,
          logs.signature,
          program.programId.toString(),
          program
        );

        if (events.length === 0) {
          return; // No events found
        }

        for (const event of events) {
          // Note: Anchor's BorshEventCoder returns event names in camelCase
          // even though the IDL shows "SignatureRequestedEvent", it's decoded as "signatureRequestedEvent"
          if (event.name === "signatureRequestedEvent") {
            console.log("\nSignatureRequestedEvent received!");
            console.log("Sender:", event.data.sender.toString());
            console.log(
              "Payload:",
              Buffer.from(event.data.payload).toString("hex")
            );
            console.log("Path:", event.data.path);
            console.log("Key version:", event.data.keyVersion);

            try {
              const requestId = generateRequestId(
                event.data.sender.toString(),
                event.data.payload,
                event.data.path,
                event.data.keyVersion,
                0,
                event.data.algo,
                event.data.dest,
                event.data.params
              );

              console.log("\nGenerated request ID:", requestId);

              const requestIdBytes = Array.from(
                Buffer.from(requestId.slice(2), "hex")
              );

              const derivedPrivateKeyHex = await deriveSigningKey(
                event.data.path,
                event.data.sender.toString(),
                process.env.PRIVATE_KEY_TESTNET!
              );

              console.log(
                "Payload to sign:",
                Buffer.from(event.data.payload).toString("hex")
              );

              const signature = await signMessage(
                event.data.payload,
                derivedPrivateKeyHex
              );

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
              console.error("Error processing event:", error);
            }
          }
        }
      }
    },
    "confirmed"
  );

  console.log("Server running. Press Ctrl+C to exit.");
  console.log("Subscription ID:", subscriptionId);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await connection.removeOnLogsListener(subscriptionId);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
