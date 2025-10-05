import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),
  SOLANA_PRIVATE_KEY: z.string().min(1, 'Solana private key is required'),
  MPC_ROOT_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
  INFURA_API_KEY: z.string().min(1, 'Infura API key is required'),
  VERBOSE: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
});

type EnvConfig = z.infer<typeof envSchema>;

function validateEnv(): EnvConfig {
  try {
    const env = envSchema.parse({
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
      SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
      MPC_ROOT_KEY: process.env.MPC_ROOT_KEY,
      INFURA_API_KEY: process.env.INFURA_API_KEY,
      VERBOSE: process.env.VERBOSE,
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
