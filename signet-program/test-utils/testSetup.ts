import type { Program } from '@coral-xyz/anchor';
import type { ChainSignatures } from '../target/types/chain_signatures';
import * as anchor from '@coral-xyz/anchor';
import { contracts } from 'signet.js';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { ChainSignatureServer, type ServerConfig } from 'fakenet-signer';
import { testEnvConfig } from './testEnvConfig';

function privateKeyToNajPublicKey(privateKey: string): `secp256k1:${string}` {
  const signingKey = new ethers.SigningKey(privateKey);
  const publicKeyHex = signingKey.publicKey.slice(4);
  const xBytes = Buffer.from(publicKeyHex.slice(0, 64), 'hex');
  const yBytes = Buffer.from(publicKeyHex.slice(64, 128), 'hex');
  const publicKeyBytes = Buffer.concat([xBytes, yBytes]);
  return `secp256k1:${bs58.encode(publicKeyBytes)}`;
}

export function testSetup() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.chainSignatures as Program<ChainSignatures>;

  const connection = new anchor.web3.Connection(
    provider.connection.rpcEndpoint
  );

  const rootPublicKey = privateKeyToNajPublicKey(testEnvConfig.MPC_ROOT_KEY);

  const signetSolContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: program.programId,
    config: {
      rootPublicKey,
    },
  });

  const config: ServerConfig = {
    solanaRpcUrl: provider.connection.rpcEndpoint,
    solanaPrivateKey: testEnvConfig.SOLANA_PRIVATE_KEY,
    mpcRootKey: testEnvConfig.MPC_ROOT_KEY,
    infuraApiKey: testEnvConfig.INFURA_API_KEY,
    programId: program.programId.toString(),
    isDevnet: provider.connection.rpcEndpoint.includes('devnet'),
    signatureDeposit: '100000',
    chainId: 'solana:localnet',
    verbose: false,
    bitcoinNetwork: 'regtest',
  };

  const server = new ChainSignatureServer(config);

  const rpcEndpoint = provider.connection.rpcEndpoint.toLowerCase();
  const isLocalnet =
    rpcEndpoint.includes('localhost') ||
    rpcEndpoint.includes('127.0.0.1') ||
    rpcEndpoint.includes(':8899');

  before(async () => {
    if (isLocalnet) {
      try {
        await server.start();
      } catch (error) {
        console.error('Error starting server:', error);
        throw error;
      }
    }
  });

  after(async () => {
    if (isLocalnet) {
      await server?.shutdown();
    }
  });

  return {
    provider,
    connection,
    program,
    signetSolContract,
  };
}
