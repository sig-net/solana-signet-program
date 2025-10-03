# Response Server

A Chain Signature Server that listens for signature requests from a Solana program, derives chain-specific signing keys deterministically, signs transactions, and monitors execution to return results back to Solana. Supports both simple message signing and bidirectional transaction flows with output callbacks.

## How to Run

### Prerequisites

- Node.js >= 16
- Yarn >= 1.22

### Setup

1. Install dependencies:

```bash
yarn install
```

2. Configure environment variables in `../../.env`:

```bash
# Solana Configuration
RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY='[1,2,3,...]'  # JSON array OR use KEYPAIR_PATH

# Ethereum Configuration
PRIVATE_KEY_TESTNET=0x...  # Ethereum private key
INFURA_API_KEY=your_key    # Required for Ethereum RPC
```

3. Validate environment (optional):

```bash
yarn validate-env
```

4. Start the server:

```bash
yarn start
```

The server will begin listening for signature requests and monitoring transactions.
