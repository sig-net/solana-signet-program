# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical Rule

**NEVER MISS AN EVENT.** Processing an event twice or posting a signature twice is acceptable. Missing an event is NOT acceptable. When implementing event handling, error recovery, or subscription logic, always err on the side of reprocessing rather than potentially missing events.

## Commands

```bash
# Build
yarn build              # Build ESM and CJS bundles to ./dist
yarn build:watch        # Watch mode for development

# Run
yarn start              # Run the CLI server (tsx src/cli/Run.ts)

# Type checking
yarn tsc --noEmit       # Type check without emitting files

# Publishing
yarn release:beta       # Prerelease version, build, publish as beta
yarn release:patch      # Patch bump, build, publish
```

## Architecture

This is a multi-chain signature orchestrator for Solana. It listens for signature requests on Solana, executes transactions on target chains (Ethereum, Bitcoin), monitors completion, and returns results back to Solana.

### Core Flow

1. **Event Subscription** (`CpiEventParser`): Subscribes to Solana program logs and parses CPI events emitted via Anchor's `emit_cpi!` macro
2. **ChainSignatureServer**: Main orchestrator that processes signature requests and manages the transaction lifecycle
3. **Chain Processors**: Sign transactions for target chains (Ethereum: EIP-1559/Legacy, Bitcoin: PSBT)
4. **Monitors**: Track transaction confirmations with exponential backoff polling
5. **Bidirectional Handlers**: For sign-and-respond flows that write results back to Solana

### Key Components

| Component                    | Location                | Purpose                                                                     |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| ChainSignatureServer         | `src/server/`           | Main orchestrator, event subscription, transaction lifecycle                |
| CpiEventParser               | `src/events/`           | Parses Anchor CPI events from Solana logs                                   |
| EthereumTransactionProcessor | `src/modules/ethereum/` | Signs EIP-1559 and Legacy transactions                                      |
| BitcoinTransactionProcessor  | `src/modules/bitcoin/`  | Builds PSBT signing plans                                                   |
| OutputSerializer             | `src/modules/`          | Multi-format serialization (Borsh for Solana, ABI for EVM)                  |
| Bitcoin Adapters             | `src/adapters/`         | Unified interface for Bitcoin RPC (regtest) and mempool.space API (testnet) |

### Two Workflows

1. **Simple Signature Request**: Sign transaction → post signature to Solana
2. **Bidirectional**: Sign → broadcast to target chain → monitor → write result back to Solana

### Key Types

- `SignatureRequestedEvent`: Initial signature request from Solana
- `BidirectionalSignatureRequestedEvent`: Sign-and-respond flow
- Events use CAIP-2 chain IDs (e.g., `eip155:1` for Ethereum mainnet, `bip122:...` for Bitcoin)

## Configuration

Environment variables loaded from `.env` (4 levels up):

- `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`, `MPC_ROOT_KEY`, `INFURA_API_KEY`, `PROGRAM_ID` (required)
- `VERBOSE`, `BITCOIN_NETWORK` (optional)

Runtime config in `src/config/Config.ts` includes polling intervals, timeouts, and key derivation settings.

## TypeScript

Strict mode enabled with `noUncheckedIndexedAccess`. Uses Zod for runtime config validation.
