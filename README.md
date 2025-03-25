### Prerequisites

- Node.js v16+ and npm 
- Rust and Cargo
- Solana CLI v2.0.0+
- Anchor Framework v0.29.0+
- Solana wallet with testnet SOL
- Responder private key

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/sig-net/chain-signatures-solana-stub.git
   cd chain-signatures-solana-stub
   ```

2. **Install project dependencies**
   ```bash
   
   # Client dependencies
   cd clients/deploy-client
   yarn
   cd ../request-client
   yarn
   cd ../response-server
   yarn
   ```

3. **Build the Solana program**
   ```bash
   # Build the smart contract
   anchor build
   
   # Get the Program ID
   solana address -k target/deploy/chain_signatures-keypair.json
   ```

4. **Update Program ID**
   
   Update the Program ID in the following files:
   - `programs/chain-signatures/src/lib.rs` (in `declare_id!` macro)
   - `Anchor.toml` (under `[programs.testnet]`)

   After updating the Program ID, build the contract again
   ```bash
   anchor build
   ```

### Configuration

1. **Create a .env file in the project root**
   ```
   # Solana Configuration
   RPC_URL=https://api.devnet.solana.com
   KEYPAIR_PATH=~/.config/solana/id.json
   
   # Ethereum Signing Keys
   PRIVATE_KEY_TESTNET=0x... # Your Responder private key
   
   # For client verification
   RESPONDER_BASE_PUBLIC_KEY=0x... # Uncompressed (0x04...) public key
   ```

2. **Prepare your Solana wallet**
   ```bash
   # Set the Solana RPC URL
   solana config set --url https://api.devnet.solana.com
   
   # Check if you have a Solana keypair
   solana address
   
   # If not, create one
   solana-keygen new
   
   # Fund your wallet with testnet SOL
   solana airdrop 2
   ```

## Running the System

### 1. Deploy the Solana Program (Optional)

```bash
# Deploy the program with your specified Program ID
solana program deploy --program-id <YOUR_PROGRAM_ID> target/deploy/chain_signatures.so

# Initialize the program state
cd clients/deploy-client
npx ts-node deploy.ts
```

### 2. Start the Responder Service

```bash
# In a new terminal window
cd clients/response-server
npx ts-node sig-server.ts
```

The responder will start listening for signature requests on the Solana blockchain and automatically respond using your Responder private key.

### 3. Request a Signature

```bash
# In a new terminal window
cd clients/request-client
npx ts-node sig-client.ts
```