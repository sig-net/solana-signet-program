import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { contracts } from "signet.js";
import { getEnv, deriveSigningKey, signMessage } from "./utils";
import { eventNames } from "./constants";
import { SignatureRequestedEvent } from "./types";

const env = getEnv();

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
      eventNames.signatureRequested,
      async (event: SignatureRequestedEvent) => {
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
    if (this.eventListenerId !== null) {
      await this.program.removeEventListener(this.eventListenerId);
      this.eventListenerId = null;
    }
  }
}
