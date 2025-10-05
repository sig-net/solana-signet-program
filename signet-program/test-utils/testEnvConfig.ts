import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load from project root .env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const testEnvSchema = z.object({
  MPC_ROOT_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid hex private key'),
  SOLANA_PRIVATE_KEY: z.string().min(1, 'Solana private key is required'),
  INFURA_API_KEY: z.string().min(1, 'Infura API key is required'),
});

type TestEnvConfig = z.infer<typeof testEnvSchema>;

function validateTestEnv(): TestEnvConfig {
  try {
    const env = testEnvSchema.parse({
      MPC_ROOT_KEY: process.env.MPC_ROOT_KEY,
      SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
      INFURA_API_KEY: process.env.INFURA_API_KEY,
    });

    return env;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Test environment validation failed:');
      error.issues.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      throw new Error('Invalid test environment configuration');
    }
    throw error;
  }
}

export const testEnvConfig = validateTestEnv();
