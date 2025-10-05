# Fakenet Signer

[![npm version](https://img.shields.io/npm/v/fakenet-signer.svg)](https://www.npmjs.com/package/fakenet-signer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Multi-chain signature orchestrator for Solana that bridges blockchain networks through MPC-based chain signatures. Listens for signature requests on Solana, executes transactions on target chains (Ethereum, etc.), monitors their completion, and returns results back to Solana.

## Features

- 🔐 **MPC-Based Key Derivation** - Hierarchical deterministic key derivation from a single root key
- 🌉 **Multi-Chain Support** - Execute transactions on Ethereum (EIP-1559 & Legacy), with extensible architecture for more chains
- 📡 **Event-Driven Architecture** - Subscribes to Solana CPI events for real-time request processing
- ⚡ **Transaction Monitoring** - Intelligent polling with exponential backoff for transaction confirmation
- 🔄 **Bidirectional Responses** - Sign transactions, execute them, and return structured outputs to Solana
- 💰 **Automatic Gas Funding** - Funds derived addresses from root key when needed
- 🛡️ **Type-Safe** - Full TypeScript support with comprehensive type definitions
- 📦 **Dual Package** - Supports both ESM and CommonJS

## Installation

```bash
npm install fakenet-signer
# or
yarn add fakenet-signer
# or
pnpm add fakenet-signer
```

## Quick Start

### 1. Environment Setup

Create a `.env` file with required configuration:

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY='[1,2,3,...]'  # Keypair array format
MPC_ROOT_KEY=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
INFURA_API_KEY=your_infura_api_key_here
PROGRAM_ID=YourProgramIdHere11111111111111111111111
VERBOSE=true  # Optional: enable detailed logging
```

### 2. Basic Usage

```typescript
import { ChainSignatureServer } from 'fakenet-signer';

const config = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  mpcRootKey: process.env.MPC_ROOT_KEY,
  infuraApiKey: process.env.INFURA_API_KEY,
  programId: process.env.PROGRAM_ID,
  isDevnet: true,
  verbose: true,
};

const server = new ChainSignatureServer(config);
await server.start();

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.shutdown();
  process.exit(0);
});
```

### 3. Run Standalone Server

```bash
npm start
# or
yarn start
```

## Architecture

### Core Components

#### `ChainSignatureServer`

Main orchestrator that manages the entire signature lifecycle:

- Initializes Solana connection and Anchor program
- Subscribes to CPI events from the on-chain program
- Processes signature requests and bidirectional transactions
- Monitors pending transactions with exponential backoff

#### `CpiEventParser`

Parses Solana CPI events emitted via Anchor's `emit_cpi!` macro:

- Subscribes to program logs
- Extracts events from inner instructions
- Decodes event data using Borsh

#### `CryptoUtils`

Handles cryptographic operations:

- **Epsilon Derivation**: `epsilon = keccak256(prefix, chain_id, requester, path)`
- **Key Derivation**: `derived_key = (root_key + epsilon) % secp256k1_n`
- **Signature Formatting**: Converts ECDSA signatures to Solana format

#### `TransactionProcessor`

Signs and prepares transactions:

- Supports EIP-1559 and Legacy Ethereum transactions
- Decodes RLP, signs, and re-encodes with signature
- Auto-funds derived addresses when needed

#### `EthereumMonitor`

Monitors transaction lifecycle:

- Polls for transaction receipts
- Detects: pending, success, reverted, replaced states
- Extracts return values from contract calls
- Provider caching for efficiency

#### `OutputSerializer`

Multi-format output serialization:

- **Borsh** (format 0) - For Solana chains
- **ABI** (format 1) - For EVM chains
- Schema-driven encoding/decoding

## API Reference

### `ChainSignatureServer`

```typescript
class ChainSignatureServer {
  constructor(config: ServerConfig);
  async start(): Promise<void>;
  async shutdown(): Promise<void>;
}
```

#### `ServerConfig`

```typescript
interface ServerConfig {
  solanaRpcUrl: string; // Solana RPC endpoint
  solanaPrivateKey: string; // Server keypair (JSON array format)
  mpcRootKey: string; // Hex private key for MPC derivations
  infuraApiKey: string; // Infura API key for Ethereum RPC
  programId: string; // Solana program ID
  isDevnet: boolean; // Network flag
  signatureDeposit?: string; // Optional deposit amount
  chainId?: string; // Optional chain identifier
  verbose?: boolean; // Enable detailed logging
}
```

### Exported Utilities

```typescript
// Crypto utilities
import { CryptoUtils } from 'fakenet-signer';
await CryptoUtils.deriveSigningKey(path, predecessor, basePrivateKey);
await CryptoUtils.signMessage(msgHash, privateKeyHex);
await CryptoUtils.signBidirectionalResponse(requestId, output, privateKey);

// Transaction processing
import { TransactionProcessor } from 'fakenet-signer';
await TransactionProcessor.processTransactionForSigning(
  rlpEncodedTx,
  privateKey,
  caip2Id,
  config
);

// Ethereum monitoring
import { EthereumMonitor } from 'fakenet-signer';
await EthereumMonitor.waitForTransactionAndGetOutput(
  txHash,
  caip2Id,
  schema,
  fromAddress,
  nonce,
  config
);

// Output serialization
import { OutputSerializer } from 'fakenet-signer';
await OutputSerializer.serialize(output, format, schema);

// Request ID generation
import { RequestIdGenerator } from 'fakenet-signer';

// For bidirectional sign-and-respond flows (with transaction execution & monitoring)
RequestIdGenerator.generateSignBidirectionalRequestId(
  sender,
  txData,
  caip2Id,
  keyVersion,
  path,
  algo,
  dest,
  params
);

// For simple signature requests (signature only, no execution)
RequestIdGenerator.generateSignRequestId(
  addr,
  payload,
  path,
  keyVersion,
  chainId,
  algo,
  dest,
  params
);

// CPI event parsing
import { CpiEventParser } from 'fakenet-signer';
CpiEventParser.subscribeToCpiEvents(connection, program, eventHandlers);

// Chain utilities
import { getNamespaceFromCaip2, getSerializationFormat } from 'fakenet-signer';
```

### Event Types

```typescript
interface SignBidirectionalEvent {
  sender: PublicKey;
  serializedTransaction: Buffer;
  caip2Id: string;
  keyVersion: number;
  deposit: bigint;
  path: string;
  algo: string;
  dest: string;
  params: string;
  outputDeserializationSchema: Buffer;
  respondSerializationSchema: Buffer;
}

interface SignatureRequestedEvent {
  sender: PublicKey;
  payload: number[];
  keyVersion: number;
  deposit: bigint;
  chainId: string;
  path: string;
  algo: string;
  dest: string;
  params: string;
  feePayer: PublicKey | null;
}
```

## Workflows

### Bidirectional Sign & Respond

```
1. Receive SignBidirectionalEvent from Solana
2. Generate deterministic request ID
3. Derive signing key from path + sender
4. Sign transaction → get txHash + signature
5. Respond to Solana with signature immediately
6. Monitor transaction on target chain (exponential backoff)
7. On success:
   - Extract output (simulate call for contracts)
   - Serialize output
   - Sign: keccak256(request_id + output)
   - Send respond_bidirectional to Solana
8. On error:
   - Send signed error response (0xDEADBEEF prefix)
```

### Simple Signature Request

```
1. Receive SignatureRequestedEvent
2. Generate request ID
3. Derive signing key
4. Sign payload hash
5. Respond to Solana with signature
```

## CAIP-2 Chain IDs

Supported chain identifiers:

- `eip155:1` - Ethereum Mainnet (ABI serialization)
- `eip155:11155111` - Sepolia Testnet (ABI serialization)
- `solana:mainnet` - Solana Mainnet (Borsh serialization)
- `solana:devnet` - Solana Devnet (Borsh serialization)
- `solana:localnet` - Solana Localnet (Borsh serialization)

## Configuration

### Transaction Monitoring

- **Poll Interval**: 5 seconds (configurable via `CONFIG.POLL_INTERVAL_MS`)
- **Exponential Backoff**:
  - 0-5 checks: every 5s
  - 6-10 checks: every 10s
  - 11-20 checks: every 30s
  - 20+ checks: every 60s

### Gas Funding

For Ethereum transactions, the server automatically funds derived addresses:

```typescript
gasNeeded = gasLimit * maxFeePerGas + value;
if (balance < gasNeeded) {
  fundingWallet.sendTransaction({
    to: derivedAddress,
    value: gasNeeded - balance,
  });
}
```

## Security Model

1. **MPC Root Key** - Single sensitive key derives all child keys deterministically
2. **Deterministic Derivation** - Same inputs always produce same derived key (verifiable)
3. **Signed Responses** - All responses include signature over `request_id + data`
4. **Request ID Hashing** - Prevents replay/tampering attacks

## TypeScript Support

Full type definitions are included:

```typescript
import type {
  ServerConfig,
  SignBidirectionalEvent,
  SignatureRequestedEvent,
  PendingTransaction,
  TransactionOutput,
  SignatureResponse,
  ProcessedTransaction,
} from 'fakenet-signer';
```

## Publishing

### Beta Release

To publish a beta version to npm:

```bash
yarn publish:beta
```

This will:

1. Bump version to next prerelease (e.g., `1.0.0` → `1.0.1-beta.0`)
2. Build the package
3. Publish to npm with `beta` tag

Users can install beta versions:

```bash
npm install fakenet-signer@beta
```

### Official Release

To publish an official release:

```bash
# For patch version (1.0.0 → 1.0.1)
yarn version:patch && yarn publish:official

# For minor version (1.0.0 → 1.1.0)
yarn version:minor && yarn publish:official

# For major version (1.0.0 → 2.0.0)
yarn version:major && yarn publish:official
```

**Note**: Requires npm authentication (`npm login`) and publish permissions.

## Contributing

Contributions are welcome! Please ensure:

- Code passes `yarn lint`
- Code is formatted with `yarn format`
- Types check with `yarn typecheck`

## License

MIT

## Related

- [Anchor Framework](https://www.anchor-lang.com/)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Ethers.js](https://docs.ethers.org/)
- [CAIP-2: Chain ID Specification](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md)
