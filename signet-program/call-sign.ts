/**
 * Simple script to call the sign() function
 * Run with: npm run sign
 */
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as anchor from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import type { ChainSignatures } from './target/types/chain_signatures';
import * as fs from 'fs';
import * as os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Hardcode mainnet URL
  process.env.ANCHOR_PROVIDER_URL = 'https://api.mainnet-beta.solana.com';

  // Set up wallet from default location
  if (!process.env.ANCHOR_WALLET) {
    const defaultKeypairPath = path.join(os.homedir(), '.config/solana/mainnet-deployer.json');
    
    if (fs.existsSync(defaultKeypairPath)) {
      process.env.ANCHOR_WALLET = defaultKeypairPath;
      console.log('✅ Using keypair from:', defaultKeypairPath);
    } else {
      console.error('❌ Error: No wallet found at', defaultKeypairPath);
      process.exit(1);
    }
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load IDL from file
  const idlPath = path.join(__dirname, './target/idl/chain_signatures.json');
  let idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));

  // Hardcode the program ID
  const programId = new anchor.web3.PublicKey('SigMcRMjKfnC7RDG5q4yUMZM1s5KJ9oYTPP4NmJRDRw');
  
  // Update IDL with the correct program ID
  idl.address = programId.toString();
  
  const program = new anchor.Program(idl, provider) as any as Program<ChainSignatures>;

  // Check if program exists
  console.log('Checking if program exists at:', programId.toString());
  const programAccount = await provider.connection.getAccountInfo(programId);
  
  if (!programAccount) {
    console.error('❌ Error: Program not found at', programId.toString());
    process.exit(1);
  }
  
  console.log('✅ Program found! Owner:', programAccount.owner.toString());
  console.log('   Executable:', programAccount.executable);
  console.log('   Lamports:', programAccount.lamports);

  // Hardcoded sign arguments
  const payload = Array.from({ length: 32 }, (_, i) => (i + 1) % 256);
  const keyVersion = 0;
  const signPath = 'test-path';
  const algo = 'secp256k1';
  const dest = 'solana';
  const params = '{}';

  console.log('Calling sign() on Mainnet:');
  console.log('  Program ID:', programId.toString());
  console.log('  payload:', payload);
  console.log('  keyVersion:', keyVersion);
  console.log('  path:', signPath);
  console.log('  algo:', algo);
  console.log('  dest:', dest);
  console.log('  params:', params);

  try {
    // Derive the program state PDA
    const [programStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('program-state')],
      programId
    );

    console.log('\n  Derived program_state PDA:', programStatePda.toString());
    console.log('  Wallet public key:', provider.wallet.publicKey.toString());
    console.log('  Program object programId:', (program as any)._programId?.toString());

    // Build the instruction manually
    const instruction = await program.methods
      .sign(payload, keyVersion, signPath, algo, dest, params)
      .instruction();

    console.log('\nInstruction details:');
    console.log('  Program ID in instruction:', instruction.programId.toString());
    console.log('  Number of accounts:', instruction.keys.length);
    
    instruction.keys.forEach((key, i) => {
      console.log(`    Account ${i}: ${key.pubkey.toString()} (signer: ${key.isSigner}, writable: ${key.isWritable})`);
    });

    const txSignature = await program.methods
      .sign(payload, keyVersion, signPath, algo, dest, params)
      .rpc();

    console.log('\n✅ Sign transaction successful!');
    console.log('Transaction signature:', txSignature);
  } catch (error) {
    console.error('\n❌ Error calling sign():', error);
    
    // Try to get more details if it's a SendTransactionError
    if (error instanceof Error && 'getLogs' in error) {
      try {
        const logs = (error as any).getLogs();
        console.error('\nDetailed logs:', logs);
      } catch (e) {
        // ignore
      }
    }
    
    process.exit(1);
  }
}

main().catch(console.error);
