import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from monorepo root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  // Solana Configuration
  RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  SOLANA_PRIVATE_KEY: z.string().min(1, 'Solana private key is required'),

  // Ethereum Configuration
  PRIVATE_KEY_TESTNET: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
  INFURA_API_KEY: z.string().min(1, 'Infura API key is required'),
  SEPOLIA_RPC_URL: z.string().url().optional(),
  ETHEREUM_RPC_URL: z.string().url().optional(),
});

type EnvConfig = z.infer<typeof envSchema>;

function validateEnv(): EnvConfig {
  try {
    const env = envSchema.parse({
      RPC_URL: process.env.RPC_URL,
      SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
      PRIVATE_KEY_TESTNET: process.env.PRIVATE_KEY_TESTNET,
      INFURA_API_KEY: process.env.INFURA_API_KEY,
      SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
      ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL,
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
