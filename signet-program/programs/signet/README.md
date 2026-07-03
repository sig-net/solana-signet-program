# Signet Chain Signatures Program

Solana program for cross-chain signature requests with verified response callbacks.

## Overview

This program enables users to request ECDSA signatures from the Signet MPC network,
supporting both simple signing and bidirectional cross-chain transactions.

It is the **Solana source-chain implementation** of the Signet Sign Bidirectional
protocol. The chain-agnostic lifecycle — flow phases, serialization schemas, error
handling, address derivation, and security properties — is documented once in the
[Sign Bidirectional Flow](https://docs.sig.network/architecture/sign-bidirectional)
docs. This README covers only what is Solana-specific.

## Instructions Reference

### Developer Instructions

These are the primary instructions for building applications:

| Instruction                                                                                                                                       | Description                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`sign`](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/chain_signatures/fn.sign.html)                                   | Request signature on a 32-byte payload           |
| [`sign_bidirectional`](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/chain_signatures/fn.sign_bidirectional.html)       | Cross-chain tx with execution result callback    |
| [`get_signature_deposit`](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/chain_signatures/fn.get_signature_deposit.html) | Query the current deposit amount (view function) |

## Sign Bidirectional on Solana

`sign_bidirectional` emits `SignBidirectionalEvent`; the MPC answers with
`SignatureRespondedEvent` (the transaction signature — the user broadcasts, the MPC
does not) and, after observing the destination chain, `RespondBidirectionalEvent`
(the signed execution result). Failed destination transactions are reported with the
`0xdeadbeef` magic prefix on the output.

See the [Sign Bidirectional Flow](https://docs.sig.network/architecture/sign-bidirectional)
for the full lifecycle diagram and phase-by-phase description.

## Request ID Generation (Solana encoding)

Each request has a unique ID for tracking. On Solana it uses **packed encoding**:

```text
// For sign_bidirectional:
request_id = keccak256(
    sender || serialized_tx || caip2_id || key_version ||
    path || algo || dest || params
)
```

## Response Signature Verification (Solana specifics)

The `respond_bidirectional` response is signed over
`keccak256(request_id || serialized_output)` using the **fixed Solana response
derivation path**:

```text
const RESPONSE_DERIVATION_PATH: &str = "solana response key";
```

To verify, recover the public key from the signature with `secp256k1_recover` and
compare it against the response child key derived from the MPC root with the
requester's `sender` and the `"solana response key"` path. Why a dedicated response
key exists — and the generic derivation formula — is covered in the
[canonical flow docs](https://docs.sig.network/architecture/sign-bidirectional#response-signature-verification).

## Destination Chain Guides

For detailed integration guides with real code examples, see:

- [EVM](https://docs.rs/chain-signatures-solana-program/latest/chain_signatures/evm/index.html) - Solana → EVM (Ethereum, Arbitrum, Optimism, Base, Polygon)

## License

MIT
