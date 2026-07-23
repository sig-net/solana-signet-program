import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo-root .env (fakenet-signer/src/config → three levels up)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z
  .object({
    // Skips the entire Solana leg (connection, program init, event listeners,
    // backfill) so the responder can run Midnight-only without a reachable
    // Solana RPC. SOLANA_PRIVATE_KEY / PROGRAM_ID become optional when set.
    DISABLE_SOLANA: z
      .string()
      .optional()
      .transform((val) => val === 'true' || val === '1'),
    SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
    SOLANA_PRIVATE_KEY: z.string().optional(),
    MPC_ROOT_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
    // The EVM endpoint e.g.:
    // - a local dev node: http://127.0.0.1:8545
    // - sepolia via infura: https://sepolia.infura.io/v3/<api-key-here>
    EVM_RPC_URL: z.string().url({ message: 'EVM RPC URL is required' }),
    PROGRAM_ID: z.string().optional(),
    VERBOSE: z
      .string()
      .optional()
      .transform((val) => val === 'true'),
    BITCOIN_NETWORK: z
      .enum(['regtest', 'testnet'])
      .optional()
      .default('testnet'),
    SUBSTRATE_WS_URL: z.string().url().optional(),
    // Midnight config
    MIDNIGHT_NETWORK_ID: z.string().optional().default('undeployed'),
    MIDNIGHT_INDEXER_URL: z.string().url().optional(),
    MIDNIGHT_INDEXER_WS_URL: z.string().optional(),
    MIDNIGHT_NODE_URL: z.string().url().optional(),
    MIDNIGHT_PROOF_SERVER_URL: z.string().url().optional(),
    MIDNIGHT_SIGNET_CONTRACT_ADDRESS: z.string().optional(),
    MIDNIGHT_WALLET_SEED: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.DISABLE_SOLANA) {
      if (!env.SOLANA_PRIVATE_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['SOLANA_PRIVATE_KEY'],
          message: 'Solana private key is required',
        });
      }
      if (!env.PROGRAM_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['PROGRAM_ID'],
          message: 'Program ID is required',
        });
      }
    }
  });

type EnvConfig = z.infer<typeof envSchema>;

/** Treat empty-string env vars as unset (e.g. `PROGRAM_ID=` when Solana is disabled). */
function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function validateEnv(): EnvConfig {
  try {
    const env = envSchema.parse({
      DISABLE_SOLANA: process.env.DISABLE_SOLANA,
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
      SOLANA_PRIVATE_KEY: nonEmpty(process.env.SOLANA_PRIVATE_KEY),
      MPC_ROOT_KEY: process.env.MPC_ROOT_KEY,
      EVM_RPC_URL: process.env.EVM_RPC_URL,
      PROGRAM_ID: nonEmpty(process.env.PROGRAM_ID),
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
