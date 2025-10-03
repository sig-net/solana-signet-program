import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
  PublicKey,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { ChainSignatures } from '../../signet-program/target/types/chain_signatures';
import IDL from '../../signet-program/target/idl/chain_signatures.json';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function loadKeypair(): Keypair {
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), '.config', 'solana', 'id.json');
  const keypairString = fs.readFileSync(keypairPath, { encoding: 'utf-8' });
  const keypairData = JSON.parse(keypairString);
  return Keypair.fromSecretKey(new Uint8Array(keypairData));
}

const SIGNATURE_DEPOSIT = new anchor.BN(0.01 * LAMPORTS_PER_SOL); // 0.01 SOL
const CHAIN_ID = process.env.CHAIN_ID || 'solana:devnet'; // CAIP-2 chain identifier

async function main() {
  const connection = new Connection(
    process.env.RPC_URL || 'https://api.devnet.solana.com',
    'confirmed'
  );
  const wallet = new anchor.Wallet(loadKeypair());
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const program = new Program<ChainSignatures>(IDL, provider);

  console.log('Using wallet:', wallet.publicKey.toString());

  const [programStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('program-state')],
    program.programId
  );

  console.log('Program State PDA:', programStatePDA.toString());

  try {
    console.log('Initializing program...');
    console.log('Chain ID:', CHAIN_ID);
    console.log('Signature deposit:', SIGNATURE_DEPOSIT.toString(), 'lamports');

    const tx = await program.methods
      .initialize(SIGNATURE_DEPOSIT, CHAIN_ID)
      .accounts({
        admin: wallet.publicKey,
      })
      .rpc();

    console.log('Program initialized successfully!');
    console.log('Transaction signature:', tx);
    console.log('Program State PDA:', programStatePDA.toString());
  } catch (error) {
    console.error('Error initializing program:', error);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
