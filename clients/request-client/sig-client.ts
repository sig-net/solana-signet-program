import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { ChainSignaturesProject } from "../../chain-signatures-project/target/types/chain_signatures_project";
import IDL from "../../chain-signatures-project/target/idl/chain_signatures_project.json";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dotenv from "dotenv";
import * as crypto from "crypto";
import { ethers } from "ethers";
import { derivePublicKey } from "./kdf";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function loadSolanaKeypair(): Keypair {
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  const keypairString = fs.readFileSync(keypairPath, { encoding: "utf-8" });
  const keypairData = JSON.parse(keypairString);
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

function generateRequestId(
  addr: string,
  payload: Uint8Array | number[],
  path: string,
  keyVersion: number,
  chainId: number | string,
  algo: string,
  dest: string,
  params: string
): string {
  const payloadHex = "0x" + Buffer.from(payload as any).toString("hex");

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

async function main() {
  const basePublicKey = process.env.RESPONDER_BASE_PUBLIC_KEY!;
  console.log("Base public key:", basePublicKey);

  const connection = new Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  const wallet = new anchor.Wallet(loadSolanaKeypair());
  console.log("Connected wallet address:", wallet.publicKey.toString());

  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new Program<ChainSignaturesProject>(IDL, provider);

  const [programStatePDA, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("program-state")],
    program.programId
  );

  console.log("Checking program state account for deposit amount...");
  try {
    const programState = await program.account.programState.fetch(
      programStatePDA
    );
    const depositAmount = programState.signatureDeposit;
    console.log(
      "Required deposit amount:",
      depositAmount.toString(),
      "lamports"
    );
  } catch (error) {
    console.log(
      "Program state not initialized yet or error fetching it:",
      error
    );
  }

  const path = "testPath";
  const payload = crypto.randomBytes(32);
  const keyVersion = 0;
  const algo = "";
  const dest = "";
  const params = "";

  const requestId = generateRequestId(
    wallet.publicKey.toString(),
    Array.from(payload),
    path,
    keyVersion,
    0,
    algo,
    dest,
    params
  );
  console.log("Requesting signature...");
  console.log("Request ID:", requestId);
  try {
    const tx = await program.methods
      .sign(Array.from(payload), keyVersion, path, algo, dest, params)
      .accounts({
        requester: wallet.publicKey,
      })
      .rpc();

    console.log("Transaction sent, waiting for confirmation...");
    console.log("Transaction signature:", tx);

    const latestBlockhash = await connection.getLatestBlockhash();
    const confirmation = await connection.confirmTransaction({
      signature: tx,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    if (confirmation.value.err) {
      console.error("Transaction failed:", confirmation.value.err);
    } else {
      console.log("Signature requested. Waiting for response...");
      await pollForSignatureResponse(
        program,
        requestId,
        wallet,
        payload,
        path,
        basePublicKey
      );
    }
  } catch (error) {
    console.error("Error requesting signature:", error);
  }
}

async function pollForSignatureResponse(
  program: Program<ChainSignaturesProject>,
  requestId: string,
  wallet: anchor.Wallet,
  payload: Buffer,
  path: string,
  basePublicKey: string
) {
  return new Promise((resolve, reject) => {
    let listener: number;

    listener = program.addEventListener(
      "signatureRespondedEvent",
      async (event, slot) => {
        try {
          console.log("Signature response event detected at slot:", slot);
          console.log("Event:", event);

          const eventRequestIdHex =
            "0x" + Buffer.from(event.requestId).toString("hex");
          const ourRequestIdHex = requestId;

          console.log("Event request ID:", eventRequestIdHex);
          console.log("Our request ID:  ", ourRequestIdHex);

          if (eventRequestIdHex !== ourRequestIdHex) {
            console.log(
              "This event is for a different request. Continuing to wait..."
            );
            return;
          }

          console.log("Signature response found for our request!");

          const signature = event.signature;

          const bigRx = "0x" + Buffer.from(signature.bigR.x).toString("hex");
          const bigRy = "0x" + Buffer.from(signature.bigR.y).toString("hex");
          const s = "0x" + Buffer.from(signature.s).toString("hex");
          const recoveryId = signature.recoveryId;

          console.log("Signature data:", {
            responder: event.responder.toString(),
            bigR: {
              x: bigRx,
              y: bigRy,
            },
            s,
            recoveryId,
          });

          try {
            const derivedPublicKey = derivePublicKey(
              path,
              wallet.publicKey.toString(),
              basePublicKey
            );

            const sig = {
              r: bigRx,
              s,
              v: recoveryId + 27,
            };

            console.log("Signature components for verification:", {
              r: sig.r,
              s: sig.s,
              v: sig.v,
            });

            try {
              const payloadHex = "0x" + payload.toString("hex");

              const recoveredAddress = ethers.recoverAddress(payloadHex, sig);

              const derivedAddress = ethers.computeAddress(derivedPublicKey);

              console.log("Recovered address:", recoveredAddress);
              console.log("Derived address:", derivedAddress);

              if (
                recoveredAddress.toLowerCase() === derivedAddress.toLowerCase()
              ) {
                console.log("✅ Signature verified successfully!");
              } else {
                console.log("❌ Signature verification failed!");
              }

              await program.removeEventListener(listener);

              resolve({
                isValid:
                  recoveredAddress.toLowerCase() ===
                  derivedAddress.toLowerCase(),
                recoveredAddress,
                derivedAddress,
              });
              process.exit(recoveredAddress.toLowerCase() === derivedAddress.toLowerCase() ? 0 : 1);
            } catch (error: any) {
              console.log("⚠️ Error recovering address:", error.message);

              await program.removeEventListener(listener);

              resolve({
                isValid: false,
                error: error.message,
              });
            }
          } catch (error) {
            console.error("Error deriving public key:", error);

            await program.removeEventListener(listener);

            reject(error);
            process.exit(1);
          }
        } catch (error) {
          console.error("Error processing event:", error);
        }
      }
    );

    setTimeout(async () => {
      await program.removeEventListener(listener);
      reject(new Error("Timeout waiting for signature response"));
      process.exit(1);
    }, 600000);

    console.log("Waiting for signature response event...");
  });
}

main().catch(console.error);
