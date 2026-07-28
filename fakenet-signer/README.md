# Fakenet Signer

[![npm version](https://img.shields.io/npm/v/fakenet-signer.svg)](https://www.npmjs.com/package/fakenet-signer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Multi-chain signature orchestrator that bridges blockchain networks through MPC-based chain signatures. Listens for signature requests on a source chain (Solana CPI events, the Midnight signet contract's notification registry, or a Substrate signet pallet), executes transactions on target chains (Ethereum, Bitcoin), monitors their completion, and returns results back to the source chain.

## Features

- 🔐 **MPC-Based Key Derivation** - Hierarchical deterministic key derivation from a single root key
- 🌉 **Multi-Chain Support** - Execute transactions on Ethereum (EIP-1559 & Legacy) and Bitcoin (PSBT), with extensible architecture for more chains
- 🌙 **Midnight Support**: Polls the signet contract's notification registry, signs requests with per-contract derived keys, and posts signature-only respond-bidirectional attestations
- ₿ **Bitcoin Adapters** - Unified interface for Bitcoin operations with mempool.space API and Bitcoin Core RPC support
- 📡 **Event-Driven Architecture** - Subscribes to Solana CPI events for real-time request processing
- ⚡ **Transaction Monitoring** - Intelligent polling with exponential backoff for transaction confirmation
- 🔄 **Bidirectional Responses** - Sign transactions, execute them, and return structured outputs to the source chain
- 💰 **Automatic Gas Funding** - Funds derived addresses from root key when needed (Ethereum)
- 🧪 **Bitcoin Regtest Support** - Docker-based local Bitcoin development with auto-mining and web explorer
- 🛡️ **Type-Safe** - Full TypeScript support with comprehensive type definitions
- 📦 **Dual Package** - Supports both ESM and CommonJS
- 🐳 **Docker Image**: Published to ghcr.io/sig-net/fakenet for containerised deployments

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
# The EVM RPC endpoint e.g.:
# - for a local dev node: http://127.0.0.1:8545
# - for sepolia via infura: https://sepolia.infura.io/v3/<api-key-here>
EVM_RPC_URL=http://127.0.0.1:8545
PROGRAM_ID=YourProgramIdHere11111111111111111111111
VERBOSE=true  # Optional: enable detailed logging

# Bitcoin Configuration
BITCOIN_NETWORK=testnet  # Options: regtest, testnet
```

This is the minimal Solana-sourced setup. The full reference, including the `DISABLE_SOLANA`, `SUBSTRATE_WS_URL`, `MIDNIGHT_*`, and `RESPONSES_API_PORT` variables, is under [Configuration](#configuration).

### 2. Basic Usage

```typescript
import { ChainSignatureServer } from 'fakenet-signer';

const config = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  mpcRootKey: process.env.MPC_ROOT_KEY,
  evmRpcUrl: process.env.EVM_RPC_URL,
  programId: process.env.PROGRAM_ID,
  isDevnet: true,
  verbose: true,
  bitcoinNetwork: 'testnet', // 'regtest' | 'testnet'
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

## Bitcoin Adapters

The package provides a unified interface for Bitcoin operations across different networks. The adapter automatically selects the appropriate backend based on the network configuration:

- **regtest** → Bitcoin Core RPC (localhost:18443)
- **testnet** → mempool.space testnet4 API

Each supported network uses different address prefixes:

- **Testnet**: `tb1q...` addresses
- **Regtest**: `bcrt1q...` addresses

### Quick Start

```typescript
import {
  BitcoinAdapterFactory,
  type IBitcoinAdapter,
  type UTXO,
  type BitcoinTransactionInfo,
} from 'fakenet-signer';

// Auto-selects adapter based on network
const adapter: IBitcoinAdapter = await BitcoinAdapterFactory.create('testnet');

// Monitor transaction
const tx: BitcoinTransactionInfo = await adapter.getTransaction('a1b2c3d4...');
console.log('Confirmations:', tx.confirmations);

// Fetch UTXOs for building transactions
const utxos: UTXO[] = await adapter.getAddressUtxos('tb1q...');
console.log(`Found ${utxos.length} UTXOs`);

// Broadcast signed transaction
const txid = await adapter.broadcastTransaction(signedTxHex);
console.log('Broadcast successful! txid:', txid);
```

### Adapter Types

#### MempoolSpaceAdapter

For testnet using mempool.space API:

```typescript
import { MempoolSpaceAdapter } from 'fakenet-signer';

const adapter = MempoolSpaceAdapter.create('testnet');

// Supported networks:
// - Testnet4: https://mempool.space/testnet4/api
// (regtest uses Bitcoin Core RPC via Docker)
```

#### BitcoinCoreRpcAdapter

For regtest/local development using Bitcoin Core RPC:

```typescript
import { BitcoinCoreRpcAdapter } from 'fakenet-signer';

// Use default regtest config
const adapter = BitcoinCoreRpcAdapter.createRegtestAdapter();

// Or custom config
const customAdapter = new BitcoinCoreRpcAdapter({
  host: 'localhost',
  port: 18443,
  username: 'test',
  password: 'test123',
});

// Regtest-only: fund address (faucet for testing)
if (adapter.fundAddress) {
  const txid = await adapter.fundAddress('bcrt1q...', 10); // Send 10 BTC
  console.log(`Funded address, txid: ${txid}`);
}

// Regtest-only: mine blocks
if (adapter.mineBlocks) {
  const blocks = await adapter.mineBlocks(10, 'bcrt1q...');
  console.log(`Mined ${blocks.length} blocks`);
}
```

#### BitcoinAdapterFactory

Auto-selects the appropriate adapter:

```typescript
import { BitcoinAdapterFactory } from 'fakenet-signer';

// Automatically chooses based on network:
// - 'regtest' -> BitcoinCoreRpcAdapter
// - 'testnet' -> MempoolSpaceAdapter

const adapter = await BitcoinAdapterFactory.create('testnet');

// If regtest not running, throws helpful error message:
// ❌ Bitcoin regtest is not running!
//
// To start bitcoin-regtest with Docker:
//   1. Clone: git clone https://github.com/Pessina/bitcoin-regtest.git
//   2. Run: yarn docker:dev
//   3. Wait for Bitcoin Core to start
//   4. Restart this server
```

### Complete Example: Bitcoin Transaction Lifecycle

```typescript
import {
  BitcoinAdapterFactory,
  type IBitcoinAdapter,
  type UTXO,
} from 'fakenet-signer';
import * as bitcoin from 'bitcoinjs-lib';

async function bitcoinExample() {
  // 1. Setup adapter (auto-selects based on URL)
  const adapter = await BitcoinAdapterFactory.create(
    'https://mempool.space/testnet4/api'
  );

  // 2. Fetch UTXOs for transaction building
  const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const utxos: UTXO[] = await adapter.getAddressUtxos(address);

  console.log(
    `Found ${utxos.length} UTXOs with total value: ${utxos.reduce(
      (sum, u) => sum + u.value,
      0
    )} sats`
  );

  // 3. Build PSBT
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });

  // Add inputs from UTXOs with witnessUtxo (required for P2WPKH SegWit)
  for (const utxo of utxos.slice(0, 1)) {
    // Use first UTXO
    // For P2WPKH, derive scriptPubKey from address
    const payment = bitcoin.payments.p2wpkh({
      address: address,
      network: bitcoin.networks.testnet,
    });

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: payment.output!, // scriptPubKey for P2WPKH
        value: utxo.value,
      },
    });
  }

  // Add outputs
  psbt.addOutput({
    address: 'tb1q...',
    value: 50000, // 50k sats
  });

  psbt.addOutput({
    address: address, // change
    value: utxos[0].value - 50000 - 1000, // minus fee
  });

  // 4. Sign (with your keypair)
  // const keyPair = ECPair.fromWIF('...', bitcoin.networks.testnet);
  // psbt.signAllInputs(keyPair);
  // psbt.finalizeAllInputs();

  // 5. Broadcast
  const signedTxHex = psbt.extractTransaction().toHex();
  const txid = await adapter.broadcastTransaction(signedTxHex);

  console.log('Transaction broadcast! txid:', txid);

  // 6. Monitor confirmations
  let tx = await adapter.getTransaction(txid);
  while (tx.confirmations < 1) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    tx = await adapter.getTransaction(txid);
    console.log(`Confirmations: ${tx.confirmations}`);
  }

  console.log('Transaction confirmed in block:', tx.blockHeight);
}
```

### IBitcoinAdapter Interface

All adapters implement this unified interface:

```typescript
interface IBitcoinAdapter {
  // Transaction monitoring
  getTransaction(txid: string): Promise<BitcoinTransactionInfo>;
  getCurrentBlockHeight(): Promise<number>;
  isAvailable(): Promise<boolean>;

  // Transaction building & broadcasting
  getAddressUtxos(address: string): Promise<UTXO[]>;
  getTransactionHex(txid: string): Promise<string>;
  broadcastTransaction(txHex: string): Promise<string>;

  // Regtest-only operations (optional)
  mineBlocks?(count: number, address: string): Promise<string[]>;
  fundAddress?(address: string, amount: number): Promise<string>;
}
```

### Types

```typescript
interface BitcoinTransactionInfo {
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  confirmations: number;
}

interface UTXO {
  txid: string;
  vout: number;
  value: number; // satoshis
  status?: {
    confirmed: boolean;
    block_height?: number;
  };
}
```

### Bitcoin Regtest Development

For local Bitcoin development, use the Docker-based `bitcoin-regtest` environment:

```bash
# Clone the repository
git clone https://github.com/Pessina/bitcoin-regtest.git
cd bitcoin-regtest

# Build and run with Docker
yarn docker:dev

# View logs
yarn docker:logs

# Stop
yarn docker:stop
```

The Docker container includes:

- **Bitcoin Core** in regtest mode on `localhost:18443`
- **Auto-mining** every 10 seconds (101 initial blocks)
- **Web Explorer UI** at `http://localhost:5173`
- **Pre-configured wallet** with credentials `test:test123`

Then configure your response-server:

```bash
BITCOIN_NETWORK=regtest
```

**Features:**

- ⚡ Zero-config setup
- 🌐 Visual blockchain explorer
- 🔧 Programmatic API access
- 🐳 Single container deployment

See [GitHub](https://github.com/Pessina/bitcoin-regtest) for detailed documentation.

## Midnight

The server can act as the MPC responder for Midnight signet contracts. The leg starts when both `MIDNIGHT_INDEXER_URL` and `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` are set (see the environment variable reference below), and it can run alone by setting `DISABLE_SOLANA=true`.

### Request discovery

The responder needs only the central signet contract's address. It polls that contract's notification registry through the Midnight GraphQL indexer (the `SignetRequestFeed` from `@sig-net/midnight`): every requester contract registers a notification naming the ledger field where its request map lives, and the feed resolves each notification to an authenticated `SignBidirectionalEvent` read from the requester's own ledger. Forged or not-yet-indexed notifications are dropped and retried, so no requester contract list, compiled caller contract, or ZK keys are needed to read state. On restart, requests that already have a respond-bidirectional response on the signet contract are skipped rather than re-signed.

### Request signing

For each discovered request the responder rebuilds the unsigned EVM transaction from the on-ledger, contract-controlled parameters, derives the signing key from the MPC root key using the requesting contract's address and the request's 32-byte path (the signet library's v2 epsilon derivation, so clients derive the same expected signer), signs it, and posts the ECDSA signature record on-chain via the signet contract's `respond` circuit. The client polls the contract for the signature and broadcasts the EVM transaction itself.

### Signature-only respond path

Unlike Solana, where the full serialized output travels on-chain in the `RespondBidirectionalEvent`, the Midnight respond carries the MPC's signature alone:

1. After the EVM transaction confirms, the responder reads the mined call's actual return data via `debug_traceTransaction` (callTracer, top call only: the same RPC method the real MPC uses, which is why `EVM_RPC_URL` must point at a node with the debug namespace enabled). The server probes for support at startup and fails loudly without it, and extraction additionally treats a missing method as an immediate error response, never an endless retry.
2. The raw return bytes are ABI-decoded per the request's `outputDeserializationSchema` and re-packed per its `respondSerializationSchema` using the schema-driven packed encoding in `@sig-net/midnight` (abi-serde). The result is the exact unpadded byte string clients recompute at claim time. A non-function-call execution (plain transfer) has no output to decode, so schema-typed success defaults are synthesised instead, mirroring the real MPC (string fields become `non_function_call_success`, bool fields become `true`, any other type is an error).
3. The responder computes the attestation digest `keccak256(requestId || serializedOutput)` and ECDSA-signs it with the per-caller response key (derived from the MPC root key and the requesting contract's address on the fixed "midnight response key" path). The signature is posted on-chain via `respondBidirectional`, and neither the digest nor the output itself travels on-chain.
4. A failed execution (revert or replacement) is attested the same way over the fixed 5-byte failure output (the `0xDEADBEEF` sentinel plus `0x01`), one width for every respond schema, so client refund circuits can verify it without the receipt.

Clients fetch the raw output off-chain (for example from the `/responses/{requestId}` helper API below), recompute the digest, and verify the posted signature against the response public key their contract pinned at initialisation.

### The `/responses/{requestId}` helper API

The server exposes a small public HTTP API, `GET /responses/{requestId}` (request id as 64 hex chars, `0x` prefix optional), on `RESPONSES_API_PORT` (default 3040). It serves each request's raw traced EVM output exactly as `debug_traceTransaction` reported it, so clients need no debug-capable RPC access of their own:

```json
{
  "requestId": "abc1...64 hex chars",
  "success": true,
  "output": "0x0000...",
  "txHash": "0x...",
  "observedAt": "2026-01-01T00:00:00.000Z"
}
```

It answers 404 while no execution result has been observed yet, and `output` is `null` for a failed execution (which has no attested output: the MPC posts the fixed failure output instead). The API is a CONVENIENCE, never an authority: the data is unauthenticated, and a client must recompute the attestation digest from it and verify the MPC's posted signature before trusting it.

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

#### `EthereumTransactionProcessor`

Signs and prepares transactions:

- Supports EIP-1559 and Legacy Ethereum transactions
- Decodes RLP, signs, and re-encodes with signature
- Auto-funds derived addresses when needed

#### `EthereumMonitor`

Monitors Ethereum transaction lifecycle:

- Polls for transaction receipts
- Detects: pending, success, reverted, replaced states
- Extracts return values from contract calls
- Provider caching for efficiency

#### `BitcoinTransactionProcessor`

Builds per-input signing plans from PSBTs:

- Parses PSBT (Partially Signed Bitcoin Transaction)
- Validates SegWit metadata (witnessUtxo)
- Computes canonical txid and BIP-143 sighashes per input
- Allows MPC services to emit one signature per UTXO

#### `BitcoinMonitor`

Monitors Bitcoin transaction lifecycle:

- Uses adapter pattern for regtest/testnet only
- Tracks confirmations (default 1)
- Auto-selects Bitcoin Core RPC or mempool.space API
- Drops pending jobs if any prevout is spent elsewhere
- Caches adapters for efficiency

#### `MidnightMonitor`

Runs the Midnight leg end to end:

- Polls the signet contract's notification registry via the GraphQL indexer
- Resolves notifications to authenticated requests from each requester's ledger
- Posts signature responses and signature-only respond-bidirectional attestations
- Serialises all contract writes behind a single queue (the private-state store is single-writer)

#### `ResponsesApi`

Public `GET /responses/{requestId}` helper serving each request's raw traced EVM output (a convenience, never an authority: clients recompute the digest from it and signature-verify).

#### Output serialization

Handled inside `ChainSignatureServer`, per source chain:

- **Borsh**: Solana and Substrate responses, encoded against the request's respond schema
- **Packed respond bytes**: Midnight responses, schema-driven encoding via `@sig-net/midnight` (abi-serde)

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
  disableSolana?: boolean; // Skip the entire Solana leg (Midnight-only runs)
  solanaRpcUrl: string; // Solana RPC endpoint
  solanaPrivateKey?: string; // Server keypair (JSON array format), required unless disableSolana
  mpcRootKey: string; // Hex private key for MPC derivations
  evmRpcUrl: string; // EVM JSON-RPC endpoint (credential in the URL if hosted)
  programId?: string; // Solana program ID, required unless disableSolana
  isDevnet: boolean; // Network flag
  signatureDeposit?: string; // Optional deposit amount
  chainId?: string; // Optional chain identifier
  verbose?: boolean; // Enable detailed logging
  bitcoinNetwork: 'regtest' | 'testnet'; // Bitcoin adapter selection
  backfillBatchSize?: number; // Solana backfill batch size
  backfillMaxBatchSize?: number; // Solana backfill batch cap
  lastBackfillSignature?: string; // Solana backfill cursor
  substrateWsUrl?: string; // Substrate node WS URL, enables the Substrate leg
  midnightNetworkId?: string; // Midnight network id (default 'undeployed')
  midnightIndexerUrl?: string; // Midnight indexer GraphQL URL (required for the Midnight leg)
  midnightIndexerWsUrl?: string; // Indexer WS URL (derived from midnightIndexerUrl when unset)
  midnightNodeUrl?: string; // Midnight node RPC URL (default http://localhost:9944)
  midnightProofServerUrl?: string; // Proof server URL (default http://localhost:6300)
  midnightSignetContractAddress?: string; // Deployed signet contract (required for the Midnight leg)
  midnightWalletSeed?: string; // Responder wallet seed (defaults to the genesis account seed)
  responsesApiPort?: number; // /responses/{requestId} helper API port (default 3040)
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
import { EthereumTransactionProcessor } from 'fakenet-signer';
await EthereumTransactionProcessor.processTransactionForSigning(
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

// Bitcoin adapters
import {
  type IBitcoinAdapter,
  type BitcoinTransactionInfo,
  type UTXO,
  MempoolSpaceAdapter,
  BitcoinCoreRpcAdapter,
  BitcoinAdapterFactory,
} from 'fakenet-signer';

// Bitcoin transaction processing
import { BitcoinTransactionProcessor } from 'fakenet-signer';
const plan = BitcoinTransactionProcessor.createSigningPlan(psbtBytes, config);
for (const input of plan.inputs) {
  // Sign input.sighash with your derived key and respond per input
}

// Bitcoin monitoring
import { BitcoinMonitor } from 'fakenet-signer';
await BitcoinMonitor.waitForTransactionAndGetOutput(
  txid,
  plan.inputs.map(({ prevTxid, vout }) => ({ txid: prevTxid, vout })),
  config
);

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

### Bidirectional Sign & Respond (Ethereum)

```
1. Receive SignBidirectionalEvent from Solana
2. Generate deterministic request ID from full transaction data
3. Derive signing key from path + sender
4. Sign transaction → get txHash + signature
5. Respond to Solana with signature immediately
6. Monitor transaction on Ethereum (exponential backoff)
7. On success:
   - Extract output (simulate call for contracts)
   - Serialize output
   - Sign: keccak256(request_id + output)
   - Send respond_bidirectional to Solana
8. On error:
   - Send signed error response (0xDEADBEEF prefix)
```

### Bidirectional Sign & Respond (Bitcoin)

```
1. Receive SignBidirectionalEvent from Solana (contains PSBT bytes)
2. Extract canonical txid from PSBT (excludes witness data)
3. Generate deterministic request ID from txid (NOT full PSBT)
4. Derive signing key from path + sender
5. Sign PSBT inputs → return signed PSBT
6. Respond to Solana with signature immediately
7. Client broadcasts signed PSBT to Bitcoin network
8. Monitor transaction on Bitcoin (slower polling - 10s intervals):
   - Testnet: wait for 1 confirmation
   - Mainnet: wait for 6 confirmations
9. On success:
   - Return success=true (no contract output for Bitcoin)
   - Sign: keccak256(request_id + output)
   - Send respond_bidirectional to Solana
10. On error:
    - Send signed error response (0xDEADBEEF prefix)
```

**Key Difference:** Bitcoin uses txid (canonical, 32 bytes) for request ID generation, while Ethereum uses full transaction data. This ensures deterministic request IDs that work across different PSBT representations of the same transaction.

### Bidirectional Sign & Respond (Midnight)

```
1. Discover the request via the signet contract's notification registry (indexer poll)
2. Resolve it to an authenticated SignBidirectionalEvent from the requester's ledger
3. Derive the signing key from the requesting contract + path (v2 epsilon derivation)
4. Sign the EVM transaction, post the signature record on-chain (respond circuit)
5. Client broadcasts the EVM transaction, and the server monitors it
6. On success:
   - Extract the mined call's return data (debug_traceTransaction)
   - Decode per outputDeserializationSchema, re-pack per respondSerializationSchema
   - Sign the attestation digest keccak256(request_id + serialized_output)
     with the per-caller response key
   - Post the signature-only respondBidirectional record on-chain
7. On error:
   - Attest the fixed 5-byte failure output (0xDEADBEEF + 0x01) the same way
```

See the [Midnight](#midnight) section for the full detail.

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

**Ethereum (namespace: eip155)**

- `eip155:1` - Ethereum Mainnet (ABI serialization)
- `eip155:11155111` - Sepolia Testnet (ABI serialization)

**Bitcoin (namespace: bip122)**

- `bip122:000000000019d6689c085ae165831e93` - Bitcoin Mainnet (6 confirmations)
- `bip122:000000000933ea01ad0ee984209779ba` - Bitcoin Testnet4 (1 confirmation)
- `bip122:00000008819873e925422c1ff0f99f7c` - Bitcoin Signet (1 confirmation)

**Solana (namespace: solana)**

- `solana:mainnet` - Solana Mainnet (Borsh serialization)
- `solana:devnet` - Solana Devnet (Borsh serialization)
- `solana:localnet` - Solana Localnet (Borsh serialization)

## Configuration

### Environment Variables

Loaded from the repo-root `.env` (or the process environment) and validated at startup:

| Variable                           | Required                       | Description                                                                                                                                     |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MPC_ROOT_KEY`                     | yes                            | Hex private key (`0x` + 64 hex chars) all chain keys derive from                                                                                 |
| `EVM_RPC_URL`                      | yes                            | EVM JSON-RPC endpoint (credential in the URL if hosted). Must support `debug_traceTransaction`, probed at startup                                |
| `SOLANA_RPC_URL`                   | no (default devnet)            | Solana RPC endpoint (default `https://api.devnet.solana.com`)                                                                                    |
| `SOLANA_PRIVATE_KEY`               | unless `DISABLE_SOLANA`        | Server keypair in JSON array format                                                                                                              |
| `PROGRAM_ID`                       | unless `DISABLE_SOLANA`        | Solana program ID of the chain signatures contract                                                                                               |
| `DISABLE_SOLANA`                   | no                             | `true` or `1` skips the entire Solana leg, for Midnight-only runs                                                                                |
| `VERBOSE`                          | no                             | `true` enables detailed logging                                                                                                                  |
| `BITCOIN_NETWORK`                  | no (default `testnet`)         | `regtest` (Bitcoin Core RPC) or `testnet` (mempool.space testnet4 API)                                                                           |
| `SUBSTRATE_WS_URL`                 | no                             | Substrate node WebSocket URL, enables the Substrate (signet pallet) leg                                                                          |
| `MIDNIGHT_NETWORK_ID`              | no (default `undeployed`)      | Midnight network id                                                                                                                              |
| `MIDNIGHT_INDEXER_URL`             | for the Midnight leg           | Midnight indexer GraphQL URL. The Midnight leg starts only when this and `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` are both set                         |
| `MIDNIGHT_INDEXER_WS_URL`          | no                             | Indexer GraphQL WebSocket URL, derived from `MIDNIGHT_INDEXER_URL` (http to ws) when unset                                                       |
| `MIDNIGHT_NODE_URL`                | no (default `localhost:9944`)  | Midnight node RPC URL                                                                                                                            |
| `MIDNIGHT_PROOF_SERVER_URL`        | no (default `localhost:6300`)  | Midnight proof server URL                                                                                                                        |
| `MIDNIGHT_SIGNET_CONTRACT_ADDRESS` | for the Midnight leg           | Address of the deployed central signet contract the responder polls and posts to                                                                 |
| `MIDNIGHT_WALLET_SEED`             | no (default genesis seed)      | Seed of the Midnight wallet the responder posts responses from                                                                                   |
| `RESPONSES_API_PORT`               | no (default `3040`)            | TCP port of the public `/responses/{requestId}` helper API                                                                                       |

### Transaction Monitoring

- **Poll Interval**: 5 seconds (configurable via `CONFIG.POLL_INTERVAL_MS`)
- **Exponential Backoff (Ethereum)**:
  - 0-5 checks: every 5s
  - 6-10 checks: every 10s
  - 11-20 checks: every 30s
  - 20+ checks: every 60s
- **Exponential Backoff (Bitcoin)**:
  - 0-5 checks: every 10s
  - 6-10 checks: every 30s
  - 10+ checks: every 60s
  - Bitcoin has slower block times (~10 min) so polling is less frequent

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

## Docker

The server is published as a container image at `ghcr.io/sig-net/fakenet` (tagged per release plus `latest`, linux/amd64 and linux/arm64, pushed by the repository's `fakenet-v*` tag workflow). The image is based on `node:24-bookworm-slim`: a glibc base is required by the Midnight SDKs' native artifacts, and the Node version satisfies the midnight-js SDKs' Node 22 floor. Configuration comes entirely from the environment (there is no `.env` file inside the image).

Run it directly:

```bash
docker run --rm \
  -e MPC_ROOT_KEY=0x... \
  -e EVM_RPC_URL=http://host.docker.internal:8545 \
  -e DISABLE_SOLANA=true \
  -e MIDNIGHT_INDEXER_URL=http://host.docker.internal:8088/api/v3/graphql \
  -e MIDNIGHT_SIGNET_CONTRACT_ADDRESS=0200... \
  -p 3040:3040 \
  ghcr.io/sig-net/fakenet:latest
```

Or from a compose file:

```yaml
services:
  fakenet:
    image: ghcr.io/sig-net/fakenet:latest
    environment:
      MPC_ROOT_KEY: '0x...'
      EVM_RPC_URL: 'http://anvil:8545'
      DISABLE_SOLANA: 'true'
      MIDNIGHT_INDEXER_URL: 'http://indexer:8088/api/v3/graphql'
      MIDNIGHT_SIGNET_CONTRACT_ADDRESS: '0200...'
    ports:
      - '3040:3040'
```

To build locally, run from the repository root (the build needs the workspace lockfile):

```bash
docker build -f fakenet-signer/Dockerfile -t ghcr.io/sig-net/fakenet:dev .
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
