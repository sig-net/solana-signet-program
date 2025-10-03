# Signet Solana Program Deployment Guide

This guide covers the complete process for deploying and initializing the Signet chain signatures program on Solana.

## Prerequisites

- Solana CLI installed and configured
- Anchor CLI installed
- Node.js and Yarn/npm installed
- A funded Solana wallet (devnet or mainnet)

## Understanding Program IDs

In Solana/Anchor programs, the **program ID** is derived from a keypair and must match across three critical locations:

1. **Program Keypair**: `target/deploy/chain_signatures-keypair.json`
   - Generated during `anchor build`
   - The public key of this keypair IS your program ID

2. **Source Code**: `programs/signet/src/lib.rs`
   - Declared with `declare_id!("...")`
   - Compiled into the program binary

3. **Anchor Configuration**: `Anchor.toml`
   - Lists program IDs for each network (localnet, devnet, testnet)

**CRITICAL**: All three must use the same address, or the program will fail at runtime due to PDA derivation mismatches and Anchor security checks.

## Deployment Process

### Step 1: Get Your Program ID

The program ID comes from the deployment keypair:

```bash
solana-keygen pubkey signet-program/target/deploy/chain_signatures-keypair.json
```

Example output: `85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV`

### Step 2: Update Program ID in Source Code

Update `programs/signet/src/lib.rs`:

```rust
declare_id!("85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV");
```

### Step 3: Update Program ID in Anchor.toml

Update all network configurations in `Anchor.toml`:

```toml
[programs.localnet]
chain_signatures = "85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV"

[programs.devnet]
chain_signatures = "85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV"

[programs.testnet]
chain_signatures = "85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV"
```

### Step 4: Update Client Code (if applicable)

Search for any hardcoded program IDs in client code:

```bash
grep -r "OLD_PROGRAM_ID" clients/ --exclude-dir=node_modules
```

Update files like `clients/request-client/sig-client.ts`:

```typescript
const contractAddress = '85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV';
```

### Step 5: Rebuild the Program

This regenerates the IDL with the correct program address:

```bash
cd signet-program
anchor build
```

The build process:

- Compiles the Rust program with the new `declare_id!`
- Generates `target/idl/chain_signatures.json` with the updated address
- Creates `target/types/chain_signatures.ts` for TypeScript clients

### Step 6: Deploy to Solana

Deploy to devnet:

```bash
anchor deploy --provider.cluster devnet
```

Or for mainnet:

```bash
anchor deploy --provider.cluster mainnet-beta
```

Expected output:

```
Deploying cluster: https://api.devnet.solana.com
Deploying program "chain_signatures"...
Program Id: 85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV
Deploy success
```

### Step 7: Verify Deployment

Check the deployed program:

```bash
solana program show 85hZuPHErQ6y1o59oMGjVCjHz4xgzKzjVCpgPm6kdBTV
```

You should see:

- Program ID
- Upgrade authority (your wallet)
- Last deployed slot
- Program size
- Balance

## Initialization

After deployment, the program must be initialized to create the program state account.

### Configuration

Create a `.env` file in the project root:

```env
# RPC endpoint (optional, defaults to devnet)
RPC_URL=https://api.devnet.solana.com

# Wallet keypair path (optional, defaults to ~/.config/solana/id.json)
KEYPAIR_PATH=/path/to/your/wallet.json

# CAIP-2 chain identifier (optional, defaults to solana:devnet)
CHAIN_ID=solana:devnet
```

### Run Initialization Script

```bash
cd clients/deploy-client
yarn install
yarn start
```

Or with custom configuration:

```bash
CHAIN_ID=solana:mainnet RPC_URL=https://api.mainnet-beta.solana.com yarn start
```

### What Initialization Does

The script:

1. Connects to the specified Solana cluster
2. Loads your wallet keypair
3. Derives the program state PDA (Program Derived Address)
4. Calls `initialize()` with:
   - `signature_deposit`: 0.01 SOL (10,000,000 lamports)
   - `chain_id`: CAIP-2 identifier (e.g., "solana:devnet")
5. Sets the caller as the program admin

Expected output:

```
Using wallet: Dewq9xyD1MZi1rE588XZFvK7uUqkcHLgCnDsn9Ns4H9M
Program State PDA: 8fH3K...
Initializing program...
Chain ID: solana:devnet
Signature deposit: 10000000 lamports
Program initialized successfully!
Transaction signature: 5xY2...
```

## Troubleshooting

### "Account already initialized" Error

The program has already been initialized. You can only initialize once. To reinitialize:

1. Close the program state account (if you have authority)
2. Or deploy to a new program ID

### PDA Derivation Errors

Symptoms: `AccountNotFound` or account validation errors

Cause: Mismatch between `declare_id!` and actual deployed address

Fix: Ensure all three locations (keypair, lib.rs, Anchor.toml) use the same program ID

### Insufficient Funds

The initialization requires:

- Rent for program state account (~0.002 SOL)
- Transaction fees (~0.000005 SOL)

Solution: Fund your wallet with at least 0.01 SOL for devnet

## Program State Management

After initialization, you can:

- **Update signature deposit**: Call `update_deposit()` (admin only)
- **Withdraw funds**: Call `withdraw_funds()` (admin only)
- **Transfer admin**: Call `transfer_admin()` (admin only)

## Network Deployments

### Devnet

- Purpose: Testing and development
- Faucet: https://faucet.solana.com
- Explorer: https://explorer.solana.com/?cluster=devnet

### Mainnet-Beta

- Purpose: Production deployment
- Requires real SOL for deployment costs
- Explorer: https://explorer.solana.com

## Security Considerations

1. **Upgrade Authority**: After deployment, consider transferring upgrade authority to a multisig
2. **Admin Key**: Store admin keypair securely; it controls all program parameters
3. **Keypair Backup**: Backup `target/deploy/chain_signatures-keypair.json` - losing it means you can't upgrade the program

## Common Commands

```bash
# Check Solana config
solana config get

# Check wallet balance
solana balance

# Get program info
solana program show <PROGRAM_ID>

# View transaction
solana confirm <SIGNATURE> -v

# Set cluster
solana config set --url devnet
solana config set --url mainnet-beta
```
