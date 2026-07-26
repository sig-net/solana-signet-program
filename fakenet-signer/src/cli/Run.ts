import { ChainSignatureServer } from '../server/ChainSignatureServer.js';
import { envConfig } from '../config/EnvConfig.js';
import type { ServerConfig } from '../types/index.js';

async function main() {
  const config: ServerConfig = {
    disableSolana: envConfig.DISABLE_SOLANA,
    solanaRpcUrl: envConfig.SOLANA_RPC_URL,
    solanaPrivateKey: envConfig.SOLANA_PRIVATE_KEY,
    mpcRootKey: envConfig.MPC_ROOT_KEY,
    evmRpcUrl: envConfig.EVM_RPC_URL,
    programId: envConfig.PROGRAM_ID,
    isDevnet: envConfig.SOLANA_RPC_URL.includes('devnet'),
    verbose: envConfig.VERBOSE,
    bitcoinNetwork: envConfig.BITCOIN_NETWORK,
    substrateWsUrl: envConfig.SUBSTRATE_WS_URL,
    midnightNetworkId: envConfig.MIDNIGHT_NETWORK_ID,
    midnightIndexerUrl: envConfig.MIDNIGHT_INDEXER_URL,
    midnightIndexerWsUrl: envConfig.MIDNIGHT_INDEXER_WS_URL,
    midnightNodeUrl: envConfig.MIDNIGHT_NODE_URL,
    midnightProofServerUrl: envConfig.MIDNIGHT_PROOF_SERVER_URL,
    midnightSignetContractAddress: envConfig.MIDNIGHT_SIGNET_CONTRACT_ADDRESS,
    midnightWalletSeed: envConfig.MIDNIGHT_WALLET_SEED,
  };

  const server = new ChainSignatureServer(config);
  await server.start();

  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await server.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
