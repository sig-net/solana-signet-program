import { Program } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { ethers } from "ethers";
import { getSolanaProgram } from "./utils";

interface SignatureResponse {
  isValid: boolean;
  recoveredAddress?: string;
  derivedAddress?: string;
  error?: string;
}

export class SignatureRespondedSubscriber {
  private program: Program<ChainSignaturesProject>;

  constructor(
    program: Program<ChainSignaturesProject>,
    connection: Connection
  ) {
    this.program = program;
  }

  async waitForSignatureResponse(
    requestId: string,
    expectedPayload: Buffer,
    expectedDerivedAddress: string,
    timeoutMs: number = 60000
  ): Promise<SignatureResponse> {
    return new Promise((resolve, reject) => {
      let listener: number;

      const cleanup = async () => {
        if (listener !== undefined) {
          await this.program.removeEventListener(listener);
        }
      };

      listener = this.program.addEventListener(
        "signatureRespondedEvent",
        async (event) => {
          try {
            const eventRequestIdHex =
              "0x" + Buffer.from(event.requestId).toString("hex");

            if (eventRequestIdHex !== requestId) {
              return;
            }

            const signature = event.signature;
            const bigRx = "0x" + Buffer.from(signature.bigR.x).toString("hex");
            const s = "0x" + Buffer.from(signature.s).toString("hex");
            const recoveryId = signature.recoveryId;

            const sig = {
              r: bigRx,
              s,
              v: recoveryId + 27,
            };

            try {
              const payloadHex = "0x" + expectedPayload.toString("hex");
              const recoveredAddress = ethers.recoverAddress(payloadHex, sig);

              const isValid =
                recoveredAddress.toLowerCase() ===
                expectedDerivedAddress.toLowerCase();

              await cleanup();
              resolve({
                isValid,
                recoveredAddress,
                derivedAddress: expectedDerivedAddress,
              });
            } catch (error: any) {
              await cleanup();
              resolve({
                isValid: false,
                error: error.message,
              });
            }
          } catch (error) {
            await cleanup();
            reject(error);
          }
        }
      );

      setTimeout(async () => {
        await cleanup();
        reject(new Error("Timeout waiting for signature response"));
      }, timeoutMs);
    });
  }
}
