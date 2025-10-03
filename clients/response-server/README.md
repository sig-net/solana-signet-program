# Response Server

Listens for Solana signature requests, signs transactions, monitors execution, and returns results.

## Setup

```bash
yarn install
```

Configure `../../.env`:

```bash
RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY='[1,2,3,...]'
PRIVATE_KEY_TESTNET=0x...
INFURA_API_KEY=your_key
```

## Run

```bash
yarn start
```
