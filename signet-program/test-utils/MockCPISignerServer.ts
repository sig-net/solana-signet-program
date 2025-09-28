import * as anchor from '@coral-xyz/anchor';

import {
  ANCHOR_EMIT_CPI_CALL_BACK_DISCRIMINATOR,
  eventNames,
} from './constants';
import { deriveSigningKey, signMessage } from './utils';

import type { SignatureRequestedEvent } from './types';
import type { ChainSignatures } from '../target/types/chain_signatures';
import type { Program } from '@coral-xyz/anchor';
import type { contracts } from 'signet.js';

export async function parseCPIEvents(
  connection: anchor.web3.Connection,
  signature: string,
  program: Program<ChainSignatures>
): Promise<SignatureRequestedEvent[]> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx?.meta?.innerInstructions) {
    return [];
  }

  const events: SignatureRequestedEvent[] = [];

  // Get account keys properly based on transaction type
  const getAccountKeys = (): anchor.web3.PublicKey[] => {
    const message = tx.transaction.message;
    if ('accountKeys' in message) {
      // Legacy transaction
      return message.accountKeys;
    } else {
      // Versioned transaction
      return message.getAccountKeys().staticAccountKeys;
    }
  };

  const accountKeys = getAccountKeys();

  for (const innerIxSet of tx.meta.innerInstructions) {
    for (const instruction of innerIxSet.instructions) {
      if (!instruction.data || instruction.programIdIndex >= accountKeys.length)
        continue;

      try {
        const rawData = anchor.utils.bytes.bs58.decode(instruction.data);

        if (
          !rawData
            .subarray(0, 8)
            .equals(ANCHOR_EMIT_CPI_CALL_BACK_DISCRIMINATOR)
        ) {
          continue;
        }

        const eventData = anchor.utils.bytes.base64.encode(rawData.subarray(8));
        const event = program.coder.events.decode(eventData);

        if (event?.name === eventNames.signatureRequested) {
          events.push(event.data as SignatureRequestedEvent);
        }
      } catch {
        // Ignore non-event instructions
      }
    }
  }

  return events;
}

export class MockCPISignerServer {
  private readonly program: Program<ChainSignatures>;
  private readonly solContract: contracts.solana.ChainSignatureContract;
  private readonly wallet: anchor.Wallet;
  private readonly connection: anchor.web3.Connection;
  private readonly basePrivateKey: string;
  private logSubscriptionId: number | null = null;

  constructor({
    connection,
    program,
    wallet,
    signetSolContract,
    basePrivateKey,
  }: {
    connection: anchor.web3.Connection;
    program: Program<ChainSignatures>;
    wallet: anchor.Wallet;
    signetSolContract: contracts.solana.ChainSignatureContract;
    basePrivateKey: string;
  }) {
    this.connection = connection;
    this.wallet = wallet;
    this.program = program;
    this.solContract = signetSolContract;
    this.basePrivateKey = basePrivateKey;
  }

  async start(): Promise<void> {
    this.subscribeToEvents();
  }

  async stop(): Promise<void> {
    if (this.logSubscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.logSubscriptionId);
      this.logSubscriptionId = null;
    }
  }

  private subscribeToEvents(): void {
    this.logSubscriptionId = this.connection.onLogs(
      'all',
      (logs) => {
        void (async () => {
          try {
            const events = await parseCPIEvents(
              this.connection,
              logs.signature,
              this.program
            );

            await Promise.all(
              events.map((event) => this.handleSignatureRequest(event))
            );
          } catch (error) {
            console.error('Error processing CPI event:', error);
          }
        })();
      },
      'confirmed'
    );
  }

  private async handleSignatureRequest(
    eventData: SignatureRequestedEvent
  ): Promise<void> {
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

      const requestIdBytes = Array.from(Buffer.from(requestId.slice(2), 'hex'));

      const derivedPrivateKey = await deriveSigningKey(
        eventData.path,
        eventData.sender.toString(),
        this.basePrivateKey
      );

      const signature = await signMessage(eventData.payload, derivedPrivateKey);

      await this.program.methods
        .respond([requestIdBytes], [signature])
        .accounts({ responder: this.wallet.publicKey })
        .rpc();
    } catch (error) {
      console.error('Error sending signature response:', error);
    }
  }
}
