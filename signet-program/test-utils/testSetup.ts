import type { Program } from '@coral-xyz/anchor';
import type { ChainSignatures } from '../target/types/chain_signatures';
import { BN } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import { contracts } from 'signet.js';
import { getEnv, bigintPrivateKeyToNajPublicKey } from './utils';
import { detectNetwork, shouldUseMockSigner } from './networkConfig';
import { MockCPISignerServer } from './MockCPISignerServer';

// Must be a function to get the correct context
export function testSetup() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.chainSignatures as Program<ChainSignatures>;

  const connection = new anchor.web3.Connection(
    provider.connection.rpcEndpoint
  );

  const env = getEnv();

  const rootPublicKey = bigintPrivateKeyToNajPublicKey(env.PRIVATE_KEY_TESTNET);

  const signetSolContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: program.programId,
    config: {
      rootPublicKey,
    },
  });

  const mockCPISignerServer = new MockCPISignerServer({
    connection,
    program,
    wallet: provider.wallet as anchor.Wallet,
    signetSolContract,
    basePrivateKey: env.PRIVATE_KEY_TESTNET,
  });

  const [programStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from('program-state')],
    program.programId
  );

  const network = detectNetwork(provider);
  const useMockSigner = shouldUseMockSigner(network);

  before(async () => {
    if (useMockSigner) {
      await mockCPISignerServer.start();
    }

    // Make sure we initialize the program only once as Anchor shares the execution environment with all tests
    try {
      await program.account.programState.fetch(programStatePda);

      return;
    } catch {
      const tx = await program.methods
        .initialize(new BN('100000'), 'solana:localnet')
        .rpc();

      const latestBlockhash = await connection.getLatestBlockhash();

      await connection.confirmTransaction(
        {
          signature: tx,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        'confirmed'
      );
    }
  });

  after(async () => {
    if (useMockSigner) {
      await mockCPISignerServer?.stop();
    }
  });

  return {
    provider,
    connection,
    program,
    signetSolContract,
  };
}
