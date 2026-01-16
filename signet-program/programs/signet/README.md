# Signet Chain Signatures Program

Solana program for cross-chain signature requests with verified response callbacks.

## Overview

This program enables users to request ECDSA signatures from the Signet MPC network,
supporting both simple signing and bidirectional cross-chain transactions.

## Instructions Reference

### Developer Instructions

These are the primary instructions for building applications:

| Instruction | Description |
|-------------|-------------|
| [`sign`](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/chain_signatures/fn.sign.html) | Request signature on a 32-byte payload |
| [`sign_bidirectional`](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/chain_signatures/fn.sign_bidirectional.html) | Cross-chain tx with execution result callback |
| [`get_signature_deposit`](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/chain_signatures/fn.get_signature_deposit.html) | Query the current deposit amount (view function) |

## Sign Bidirectional Flow

The bidirectional flow enables cross-chain transaction execution with verified
response callbacks:

```text
User                    Solana (Source)         MPC Network        Destination Chain
  │                        │                         │                    │
  │ sign_bidirectional()   │                         │                    │
  ├───────────────────────►│                         │                    │
  │                        │  SignBidirectionalEvent │                    │
  │                        ├────────────────────────►│                    │
  │                        │◄──── respond() ─────────┤                    │
  │                        │                         │                    │
  │ Poll SignatureRespondedEvent                     │                    │
  │◄───────────────────────┤                         │                    │
  │                        │                         │                    │
  │ Broadcast signed tx ───┼─────────────────────────┼───────────────────►│
  │                        │                         │◄── Light client ───┤
  │                        │◄─ respond_bidirectional()                    │
  │                        │                         │                    │
  │ Poll RespondBidirectionalEvent                   │                    │
  │◄───────────────────────┤                         │                    │
```

### Phase 1: Sign Request

1. User calls `sign_bidirectional` with serialized unsigned transaction
2. Program emits `SignBidirectionalEvent`
3. MPC parses event and generates unique request ID

### Phase 2: Signature Delivery

1. MPC signs the transaction hash
2. Stores transaction in backlog for observation
3. Calls `respond`, emitting `SignatureRespondedEvent`
4. User polls for `SignatureRespondedEvent` to get signature

### Phase 3: User Broadcast

1. User assembles signed transaction (serialized data + signature)
2. User broadcasts to destination chain
3. **The MPC does NOT broadcast** - this is the user's responsibility

### Phase 4: Light Client Observation

1. MPC light client monitors destination chain blocks
2. Detects transaction confirmation by hash
3. Extracts execution status (success/failure)

### Phase 5: Output Extraction

1. For contract calls: MPC extracts return value
2. For simple transfers: empty success indicator
3. Output deserialized using `output_deserialization_schema`

### Phase 6: Respond Bidirectional

1. MPC serializes output using `respond_serialization_schema`
2. Signs `keccak256(request_id || serialized_output)`
3. Calls `respond_bidirectional`
4. Program emits `RespondBidirectionalEvent` for user to poll

## Request ID Generation

Each request has a unique ID for tracking:

```text
// For sign_bidirectional (packed encoding):
request_id = keccak256(
    sender || serialized_tx || caip2_id || key_version ||
    path || algo || dest || params
)
```

## Serialization Schemas

Cross-chain data encoding uses two schemas:

| Schema | Direction | Purpose |
|--------|-----------|---------|
| `output_deserialization_schema` | Destination → MPC | Parse execution result from destination chain |
| `respond_serialization_schema` | MPC → Source | Serialize response for source chain consumption |

See destination chain guides (e.g., [EVM](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/evm/index.html)) for format details and examples.

## Error Handling

Failed destination chain transactions are indicated with magic prefix:

```rust
const MAGIC_ERROR_PREFIX: [u8; 4] = [0xde, 0xad, 0xbe, 0xef];

// Check if response indicates failure:
fn is_error(output: &[u8]) -> bool {
    output.starts_with(&[0xde, 0xad, 0xbe, 0xef])
}
```

## Address Derivation

Each user gets a unique destination chain address derived from:

```text
epsilon = derive_epsilon(sender_pubkey, derivation_path)
user_pubkey = derive_key(mpc_root_pubkey, epsilon)
// Address format is chain-specific (see destination chain guides)
```

## Response Signature Verification

The `respond_bidirectional` response is signed using a **special derivation path**:

```text
const RESPONSE_DERIVATION_PATH: &str = "solana response key";

// Response epsilon derivation:
epsilon = derive_epsilon(key_version, sender_pubkey, "solana response key")
response_pubkey = derive_key(mpc_root_pubkey, epsilon)
```

The signature is computed over:

```text
message_hash = keccak256(request_id || serialized_output)
```

To verify the response signature, clients must:
1. Recover the public key from the signature using `secp256k1_recover`
2. Derive the expected response public key using the `"solana response key"` path
3. Compare the recovered public key with the expected response public key

## Security Considerations

### Security Properties

1. **Request ID Uniqueness**: Each request has a unique ID computed from
   `keccak256(sender || tx || chain_id || ...)` preventing replay attacks

2. **Response Authenticity**: Responses are signed over
   `keccak256(request_id || serialized_output)` using MPC threshold signatures

3. **Output Verification**: The `output_deserialization_schema` and
   `respond_serialization_schema` ensure consistent data encoding across chains

4. **Key Isolation**: Each user has isolated keys through unique derivation paths
   (`epsilon = derive_epsilon(predecessor, path)`)

5. **Light Client Security**: The MPC light client validates destination chain
   consensus without trusting an RPC provider

## Destination Chain Guides

For detailed integration guides with real code examples, see:

- [EVM](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/evm/index.html) - Solana → EVM (Ethereum, Arbitrum, Optimism, Base, Polygon)

## License

MIT
