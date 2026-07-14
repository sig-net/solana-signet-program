import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo-root .env (fakenet-signer/src/config → three levels up)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  SOLANA_PRIVATE_KEY: z.string().min(1, 'Solana private key is required'),
  MPC_ROOT_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
  INFURA_API_KEY: z.string().min(1, 'Infura API key is required'),
  // Overrides the Infura-derived EVM endpoint for ALL eip155 chains — point
  // it at a local dev node (e.g. http://127.0.0.1:8545) to sign/verify
  // against a local EVM instead of Sepolia/mainnet.
  EVM_RPC_URL: z.string().url().optional(),
  PROGRAM_ID: z.string().min(1, 'Program ID is required'),
  VERBOSE: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
  BITCOIN_NETWORK: z.enum(['regtest', 'testnet']).optional().default('testnet'),
  SUBSTRATE_WS_URL: z.string().url().optional(),
  // Midnight config
  MIDNIGHT_NETWORK_ID: z.string().optional().default('undeployed'),
  MIDNIGHT_INDEXER_URL: z.string().url().optional(),
  MIDNIGHT_INDEXER_WS_URL: z.string().optional(),
  MIDNIGHT_NODE_URL: z.string().url().optional(),
  MIDNIGHT_PROOF_SERVER_URL: z.string().url().optional(),
  MIDNIGHT_SIGNET_CONTRACT_ADDRESS: z.string().optional(),
  MIDNIGHT_WALLET_SEED: z.string().optional(),
});

type EnvConfig = z.infer<typeof envSchema>;

function validateEnv(): EnvConfig {
  try {
    const env = envSchema.parse({
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
      SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
      MPC_ROOT_KEY: process.env.MPC_ROOT_KEY,
      INFURA_API_KEY: process.env.INFURA_API_KEY,
      EVM_RPC_URL: process.env.EVM_RPC_URL,
      PROGRAM_ID: process.env.PROGRAM_ID,
      VERBOSE: process.env.VERBOSE,
      BITCOIN_NETWORK: process.env.BITCOIN_NETWORK,
      SUBSTRATE_WS_URL: process.env.SUBSTRATE_WS_URL,
      MIDNIGHT_NETWORK_ID: process.env.MIDNIGHT_NETWORK_ID,
      MIDNIGHT_INDEXER_URL: process.env.MIDNIGHT_INDEXER_URL,
      MIDNIGHT_INDEXER_WS_URL: process.env.MIDNIGHT_INDEXER_WS_URL,
      MIDNIGHT_NODE_URL: process.env.MIDNIGHT_NODE_URL,
      MIDNIGHT_PROOF_SERVER_URL: process.env.MIDNIGHT_PROOF_SERVER_URL,
      MIDNIGHT_SIGNET_CONTRACT_ADDRESS:
        process.env.MIDNIGHT_SIGNET_CONTRACT_ADDRESS,
      MIDNIGHT_WALLET_SEED: process.env.MIDNIGHT_WALLET_SEED,
    });

    return env;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Environment validation failed:');
      error.issues.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      throw new Error('Invalid environment configuration');
    }
    throw error;
  }
}

export const envConfig = validateEnv();
