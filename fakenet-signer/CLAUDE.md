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

This is a multi-chain signature orchestrator for Solana and Midnight. It listens for signature requests on the source chain (Solana CPI events, or the Midnight signet contract's notification events), executes transactions on target chains (Ethereum, Bitcoin), monitors completion, and returns results to the source chain. The respond shapes differ: Solana's `RespondBidirectionalEvent` carries the full serialized output on-chain, while Midnight's carries the attestation without the output (the request id, the destination block height, the output kind, the output's byte width, the Poseidon `transientHash` digest over those and the serialized output, and the MPC's ECDSA signature over that digest), so Midnight clients obtain the output bytes themselves (recomputed from the trace, or downloaded from the output cache this server simulates), recompute the digest and verify the posted signature over them.

### Core Flow

1. **Event Subscription** (`CpiEventParser`): Subscribes to Solana program logs and parses CPI events emitted via Anchor's `emit_cpi!` macro
2. **ChainSignatureServer**: Main orchestrator that processes signature requests and manages the transaction lifecycle
3. **Chain Processors**: Sign transactions for target chains (Ethereum: EIP-1559/Legacy, Bitcoin: PSBT)
4. **Monitors**: Track transaction confirmations with exponential backoff polling
5. **Bidirectional Handlers**: For sign-and-respond flows that write results back to the source chain (full output to Solana, an attestation without the output to Midnight)

### Key Components

| Component                    | Location                            | Purpose                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChainSignatureServer         | `src/server/`                       | Main orchestrator, event subscription, transaction lifecycle                                                                                                                             |
| CpiEventParser               | `src/events/`                       | Parses Anchor CPI events from Solana logs                                                                                                                                                |
| EthereumTransactionProcessor | `src/modules/ethereum/`             | Signs EIP-1559 and Legacy transactions                                                                                                                                                   |
| BitcoinTransactionProcessor  | `src/modules/bitcoin/`              | Builds PSBT signing plans                                                                                                                                                                |
| Output serialization         | `src/server/` + `@sig-net/midnight` | Borsh for Solana (ChainSignatureServer), schema-driven packed respond bytes for Midnight (abi-serde)                                                                                     |
| MidnightMonitor              | `src/modules/`                      | Polls the Midnight signet contract's notification events for requests, signs and posts attestations with the sender-scoped response key                                                  |
| OutputCache                  | `src/server/`                       | In-memory twin of the MPC's output cache bucket: each Midnight attestation's exact bytes, stored before posting and served under the bucket's layout (a convenience, never an authority) |
| Bitcoin Adapters             | `src/adapters/`                     | Unified interface for Bitcoin RPC (regtest) and mempool.space API (testnet)                                                                                                              |

### Two Workflows

1. **Simple Signature Request**: Sign transaction → post signature to Solana
2. **Bidirectional**: Sign → broadcast to target chain → monitor → write result back to Solana

### Key Types

- `SignatureRequestedEvent`: Initial signature request from Solana
- `BidirectionalSignatureRequestedEvent`: Sign-and-respond flow
- Events use CAIP-2 chain IDs (e.g., `eip155:1` for Ethereum mainnet, `bip122:...` for Bitcoin)

## Configuration

Environment variables loaded from the repo-root `.env`:

- `EVM_RPC_URL` (required, any EVM endpoint; hosted providers carry their credential in the URL, e.g. for Infura: `https://sepolia.infura.io/v3/<api-key-here>`)
- `MPC_ROOT_KEY` (required)
- `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`, `PROGRAM_ID` (required unless `DISABLE_SOLANA=true`)
- `MIDNIGHT_SIGNET_CONTRACT_ADDRESS`, `MIDNIGHT_WALLET_SEED` plus the `MIDNIGHT_*` endpoint overrides (`MIDNIGHT_NETWORK_ID`, `MIDNIGHT_NODE_URL`, `MIDNIGHT_INDEXER_URL`, `MIDNIGHT_INDEXER_WS_URL`, `MIDNIGHT_PROOF_SERVER_URL`) enable the Midnight leg (optional)
- `OUTPUT_CACHE_PORT`, `OUTPUT_CACHE_PREFIX` (optional, defaults 3040 and `v1/fakenet`: where the output cache simulation is served)
- `DISABLE_SOLANA`, `VERBOSE`, `BITCOIN_NETWORK` (optional)

Runtime config in `src/config/Config.ts` includes polling intervals, timeouts, and key derivation settings.

## TypeScript

Strict mode enabled with `noUncheckedIndexedAccess`. Uses Zod for runtime config validation.

## No startup probe for debug-trace support

Never add a boot-time check that the configured `EVM_RPC_URL` supports
`debug_traceTransaction`. Every possible probe design is wrong:

- Tracing a dummy or historical tx hash: a forked dev node (anvil
  `--fork-url`) forwards traces of transactions it did not mine to its fork
  upstream and relays the answer, so the probe measures the upstream's debug
  support, not the node's. A debug-less upstream then kills a responder whose
  actual workload (tracing locally mined txs) works fine.
- Probing `debug_traceCall` as a stand-in: hosted providers gate trace
  methods individually, so a plan with `debug_traceTransaction` but without
  `debug_traceCall` gets wrongly killed.
- Mining a local tx to trace: needs funded keys or anvil-only cheatcodes,
  and a probe must never broadcast anything.

The exact check already exists where it matters: output extraction in
`EthereumMonitor.waitForTransactionAndGetOutput` treats a missing method as
an immediate `fatal_error` (`debug_trace_not_supported`) with a log line
naming the fix, and the source chain gets an error response, a designed-for
outcome clients handle with refund branches.
