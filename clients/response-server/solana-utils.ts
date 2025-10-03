import { Keypair } from '@solana/web3.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { envConfig } from './envConfig';

export class SolanaUtils {
  static loadKeypair(): Keypair {
    if (envConfig.SOLANA_PRIVATE_KEY) {
      try {
        const privateKey = JSON.parse(envConfig.SOLANA_PRIVATE_KEY);
        return Keypair.fromSecretKey(new Uint8Array(privateKey));
      } catch (e) {
        throw new Error(`Failed to parse SOLANA_PRIVATE_KEY: ${e}`);
      }
    }

    try {
      const keypairPath =
        envConfig.KEYPAIR_PATH ||
        path.join(os.homedir(), '.config', 'solana', 'id.json');
      const keypairString = fs.readFileSync(keypairPath, { encoding: 'utf-8' });
      const keypairData = JSON.parse(keypairString);
      return Keypair.fromSecretKey(new Uint8Array(keypairData));
    } catch (e) {
      throw new Error(`Failed to load keypair from file: ${e}`);
    }
  }
}
