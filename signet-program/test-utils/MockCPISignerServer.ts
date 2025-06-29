import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ChainSignaturesProject } from "../target/types/chain_signatures_project";
import { contracts } from "signet.js";
import { getEnv } from "./utils";
import { PublicKey } from "@solana/web3.js";
import { deriveSigningKey, signMessage } from "./sign";

const env = getEnv();

async function parseCPIEvents(
  connection: anchor.web3.Connection,
  signature: string,
  targetProgramId: PublicKey,
  program: Program<ChainSignaturesProject>
): Promise<any[]> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx?.meta) {
    return [];
  }

  const targetProgramStr = targetProgramId.toString();
  const events: any[] = [];
  const innerIxs = tx.meta.innerInstructions || [];

  for (const innerIxSet of innerIxs) {
    for (const instruction of innerIxSet.instructions) {
      const programIndex = instruction.programIdIndex;

      let accountKeys: anchor.web3.PublicKey[] = [];
      if ("accountKeys" in tx.transaction.message) {
        accountKeys = tx.transaction.message.accountKeys;
      } else {
        accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;
      }

      if (programIndex < accountKeys.length) {
        const programId = accountKeys[programIndex].toString();
        if (programId === targetProgramStr && instruction.data) {
          try {
            const rawData = anchor.utils.bytes.bs58.decode(instruction.data);
            const base64Data = anchor.utils.bytes.base64.encode(
              rawData.subarray(8)
            );
            const event = program.coder.events.decode(base64Data);

            if (event && event.name === "signatureRequestedEvent") {
              events.push(event.data);
            }
          } catch (e) {
            // Ignore decode errors for non-event instructions
          }
        }
      }
    }
  }

  return events;
}

/**
 * Mock signer server that subscribes to CPI events from the signet program
 */
export class MockCPISignerServer {
  private program: Program<ChainSignaturesProject>;
  private solContract: contracts.solana.ChainSignatureContract;
  private wallet: any;
  private provider: anchor.AnchorProvider;
  private signetProgramId: PublicKey;
  private subscriptionActive: boolean = false;
  private logSubscriptionId: number | null = null;

  constructor({
    provider,
    signetSolContract,
    signetProgramId,
  }: {
    provider: anchor.AnchorProvider;
    signetSolContract: contracts.solana.ChainSignatureContract;
    signetProgramId: PublicKey;
  }) {
    this.wallet = provider.wallet;
    this.provider = provider;
    this.program = anchor.workspace
      .chainSignaturesProject as Program<ChainSignaturesProject>;
    this.solContract = signetSolContract;
    this.signetProgramId = signetProgramId;
  }

  async start(): Promise<void> {
    this.subscriptionActive = true;

    try {
      await this.subscribeToSignatureRequestedEvents();
    } catch (error) {
      console.error("Failed to start CPI event subscription:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.subscriptionActive = false;

    if (this.logSubscriptionId !== null) {
      await this.provider.connection.removeOnLogsListener(
        this.logSubscriptionId
      );
      this.logSubscriptionId = null;
    }
  }

  private async subscribeToSignatureRequestedEvents(): Promise<void> {
    const connection = this.provider.connection;

    this.logSubscriptionId = connection.onLogs(
      this.signetProgramId,
      async (logs) => {
        if (!this.subscriptionActive) return;

        try {
          const signature = logs.signature;
          const events = await parseCPIEvents(
            connection,
            signature,
            this.signetProgramId,
            this.program
          );

          for (const event of events) {
            await this.handleSignatureRequest(event);
          }
        } catch (error) {
          console.error("Error processing CPI event:", error);
        }
      },
      "confirmed"
    );
  }

  private async handleSignatureRequest(eventData: any): Promise<void> {
    try {
      const requestId = this.solContract.getRequestId(
        {
          payload: eventData.payload,
          path: eventData.path,
          key_version: eventData.keyVersion,
        },
        {
          algo: eventData.algo,
          dest: eventData.dest,
          params: eventData.params,
        }
      );

      const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), "hex"));

      const derivedPrivateKeyHex = await deriveSigningKey(
        eventData.path,
        eventData.sender.toString(),
        env.PRIVATE_KEY_TESTNET
      );

      const signature = await signMessage(
        eventData.payload,
        derivedPrivateKeyHex
      );

      await this.program.methods
        .respond([requestIdBytes], [signature])
        .accounts({
          responder: this.wallet.publicKey,
        })
        .rpc();
    } catch (error) {
      console.error("Error sending signature response for CPI:", error);
    }
  }
}
