# Deploy Client

Deploys and initializes the Signet Solana program.

## Deploy Program

1. Get program ID:
```bash
solana-keygen pubkey signet-program/target/deploy/chain_signatures-keypair.json
```

2. Update program ID in:
   - `programs/signet/src/lib.rs` (`declare_id!`)
   - `Anchor.toml` (all networks)
   - `clients/request-client/sig-client.ts` (if applicable)

3. Rebuild and deploy:
```bash
cd signet-program
anchor build
anchor deploy --provider.cluster devnet
```

4. Verify:
```bash
solana program show <PROGRAM_ID>
```

## Initialize Program

Configure `.env`:
```bash
RPC_URL=https://api.devnet.solana.com
KEYPAIR_PATH=/path/to/wallet.json
CHAIN_ID=solana:devnet
```

Run:
```bash
cd clients/deploy-client
yarn install
yarn start
```

Sets signature deposit to 0.01 SOL and configures the chain ID.
