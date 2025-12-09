//! # Solana → EVM Destination Chain Integration Guide
//!
//! This module provides detailed documentation for integrating `sign_bidirectional`
//! with EVM destination chains (Ethereum, Arbitrum, Optimism, Base, Polygon, etc.).
//!
//! ## Overview
//!
//! The bidirectional flow enables Solana programs to:
//! 1. Execute transactions on EVM chains
//! 2. Receive cryptographically verified execution results back on Solana
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────────┐
//! │                        SOLANA → EVM FLOW                                │
//! ├─────────────────────────────────────────────────────────────────────────┤
//! │                                                                         │
//! │  Solana Program              MPC Network              EVM Chain         │
//! │       │                           │                       │             │
//! │       │ sign_bidirectional()      │                       │             │
//! │       ├──────────────────────────►│                       │             │
//! │       │                           │ Sign tx               │             │
//! │       │◄──── SignatureResponded ──┤                       │             │
//! │       │                           │                       │             │
//! │       │              User broadcasts signed tx ──────────►│             │
//! │       │                           │                       │             │
//! │       │                           │◄─── Light client ─────┤             │
//! │       │                           │     observes tx       │             │
//! │       │                           │                       │             │
//! │       │◄─ RespondBidirectional ───┤                       │             │
//! │       │   (execution result)      │                       │             │
//! │                                                                         │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Building EVM Transactions
//!
//! ## Transaction Encoding
//!
//! EVM transactions must be RLP-encoded before passing to `sign_bidirectional`.
//! Use libraries like `alloy` or `signet-rs` for encoding.
//!
//! ### Using signet-rs (Recommended for Solana Programs)
//!
//! ```rust,ignore
//! use signet_rs::{TransactionBuilder, TxBuilder, EVM};
//!
//! let evm_tx = TransactionBuilder::new::<EVM>()
//!     .chain_id(1)                              // Ethereum mainnet
//!     .nonce(0)
//!     .to([0x12, 0x34, ...])                    // Contract address [u8; 20]
//!     .value(0)                                 // ETH value in wei
//!     .input(call_data)                         // ABI-encoded function call
//!     .gas_limit(100_000)
//!     .max_fee_per_gas(20_000_000_000)          // 20 gwei
//!     .max_priority_fee_per_gas(1_000_000_000)  // 1 gwei
//!     .build();
//!
//! let rlp_encoded = evm_tx.build_for_signing();
//! ```
//!
//! # Serialization Schemas
//!
//! The bidirectional flow uses two schemas to handle cross-chain data encoding.
//! These schemas are JSON-encoded and passed as `Vec<u8>` to `sign_bidirectional`.
//!
//! ## Output Deserialization Schema (ABI Format)
//!
//! Tells the MPC how to parse the EVM contract's return value.
//! Uses Ethereum ABI type notation in JSON format.
//!
//! ### Generating from Solidity ABI (Recommended)
//!
//! ```rust,ignore
//! use alloy_sol_types::SolCall;
//!
//! // Define your contract interface
//! sol! {
//!     interface IERC20 {
//!         function transfer(address to, uint256 amount) returns (bool);
//!         function balanceOf(address account) returns (uint256);
//!     }
//! }
//!
//! // Get the ABI outputs for the function
//! let functions = IERC20::abi::functions();
//! let transfer_func = functions.get("transfer").unwrap().first().unwrap();
//!
//! // Serialize to JSON bytes
//! let output_schema = serde_json::to_vec(&transfer_func.outputs).unwrap();
//! // Result: [{"name":"","type":"bool"}]
//! ```
//!
//! ## Respond Serialization Schema (Borsh Format)
//!
//! Tells the MPC how to serialize the response for Solana consumption.
//! The response is Borsh-encoded for efficient on-chain deserialization.
//!
//! ### Simple Boolean Response
//!
//! For ERC20 `transfer` which returns `bool`:
//!
//! ```rust,ignore
//! // Schema: just the type name as JSON string
//! let respond_schema = serde_json::to_vec(&serde_json::json!("bool")).unwrap();
//! // Result: "bool"
//!
//! // On-chain deserialization:
//! let success: bool = BorshDeserialize::try_from_slice(&serialized_output)?;
//! ```
//!
//! ### Struct Response
//!
//! For complex return types, define a matching Borsh struct:
//!
//! ```rust,ignore
//! use borsh::{BorshDeserialize, BorshSerialize, BorshSchema};
//!
//! #[derive(BorshDeserialize, BorshSerialize, BorshSchema)]
//! pub struct SwapResult {
//!     pub amount_out: u128,
//!     pub fee: u128,
//! }
//!
//! // Schema from BorshSchema
//! let respond_schema = serde_json::to_vec(
//!     &serde_json::json!([
//!         {"name": "amount_out", "type": "u128"},
//!         {"name": "fee", "type": "u128"}
//!     ])
//! ).unwrap();
//!
//! // On-chain deserialization:
//! let result: SwapResult = BorshDeserialize::try_from_slice(&serialized_output)?;
//! ```
//!
//! ### Bytes Wrapper Response
//!
//! For raw bytes passthrough:
//!
//! ```rust,ignore
//! let respond_schema = serde_json::to_vec(
//!     &serde_json::json!([{"name": "output", "type": "bytes"}])
//! ).unwrap();
//! ```
//!
//! # Complete Integration Example
//!
//! ## Rust (Solana Program with CPI)
//!
//! ```rust,ignore
//! use alloy_primitives::{Address, U256};
//! use alloy_sol_types::SolCall;
//! use chain_signatures::cpi::accounts::SignBidirectional;
//! use chain_signatures::cpi::sign_bidirectional;
//! use signet_rs::{TransactionBuilder, TxBuilder, EVM};
//!
//! sol! {
//!     interface IERC20 {
//!         function transfer(address to, uint256 amount) returns (bool);
//!     }
//! }
//!
//! pub fn deposit_erc20(
//!     ctx: Context<DepositErc20>,
//!     erc20_address: [u8; 20],
//!     recipient: [u8; 20],
//!     amount: u128,
//!     tx_params: EvmTxParams,
//! ) -> Result<()> {
//!     // 1. Build the ERC20 transfer call data
//!     let call = IERC20::transferCall {
//!         to: Address::from_slice(&recipient),
//!         amount: U256::from(amount),
//!     };
//!
//!     // 2. Build the EVM transaction
//!     let evm_tx = TransactionBuilder::new::<EVM>()
//!         .chain_id(tx_params.chain_id)
//!         .nonce(tx_params.nonce)
//!         .to(erc20_address)
//!         .value(0)
//!         .input(call.abi_encode())
//!         .gas_limit(tx_params.gas_limit)
//!         .max_fee_per_gas(tx_params.max_fee_per_gas)
//!         .max_priority_fee_per_gas(tx_params.max_priority_fee_per_gas)
//!         .build();
//!
//!     let rlp_encoded = evm_tx.build_for_signing();
//!
//!     // 3. Generate schemas
//!     let functions = IERC20::abi::functions();
//!     let transfer_func = functions.get("transfer").unwrap().first().unwrap();
//!     let output_schema = serde_json::to_vec(&transfer_func.outputs)?;
//!     let respond_schema = serde_json::to_vec(&serde_json::json!("bool"))?;
//!
//!     // 4. Generate CAIP-2 chain ID
//!     let caip2_id = format!("eip155:{}", tx_params.chain_id);
//!
//!     // 5. CPI to sign_bidirectional (source chain → destination chain)
//!     sign_bidirectional(
//!         cpi_ctx,
//!         rlp_encoded,            // Transaction to execute on destination chain
//!         caip2_id,               // Destination chain ID (e.g., "eip155:1")
//!         0,                      // key_version
//!         path,                   // derivation path for user's key
//!         "".to_string(),         // algo (reserved)
//!         "".to_string(),         // dest (reserved)
//!         "".to_string(),         // params (reserved)
//!         crate::ID,              // callback program (reserved)
//!         output_schema,          // How to parse destination chain output
//!         respond_schema,         // How to serialize response for source chain
//!     )?;
//!
//!     Ok(())
//! }
//! ```
//!
//! ## Processing the Response
//!
//! After the MPC observes the EVM transaction and calls `respond_bidirectional`:
//!
//! ```rust,ignore
//! use borsh::BorshDeserialize;
//! use anchor_lang::solana_program::keccak;
//! use anchor_lang::solana_program::secp256k1_recover::secp256k1_recover;
//!
//! /// Magic prefix indicating failed EVM transaction
//! const ERROR_PREFIX: [u8; 4] = [0xDE, 0xAD, 0xBE, 0xEF];
//!
//! pub fn claim_deposit(
//!     ctx: Context<ClaimDeposit>,
//!     request_id: [u8; 32],
//!     serialized_output: Vec<u8>,
//!     signature: chain_signatures::Signature,
//! ) -> Result<()> {
//!     // 1. Verify the signature
//!     let message_hash = hash_response(&request_id, &serialized_output);
//!     verify_signature(&message_hash, &signature, &ctx.accounts.config.mpc_address)?;
//!
//!     // 2. Check for error prefix
//!     if serialized_output.len() >= 4 && serialized_output[..4] == ERROR_PREFIX {
//!         // Transaction failed on EVM - handle error case
//!         return Err(ErrorCode::EvmTransactionFailed.into());
//!     }
//!
//!     // 3. Deserialize the result (bool for ERC20 transfer)
//!     let success: bool = BorshDeserialize::try_from_slice(&serialized_output)?;
//!     require!(success, ErrorCode::TransferReturnedFalse);
//!
//!     // 4. Update on-chain state
//!     ctx.accounts.user_balance.amount += pending.amount;
//!
//!     Ok(())
//! }
//!
//! fn hash_response(request_id: &[u8; 32], output: &[u8]) -> [u8; 32] {
//!     let mut data = Vec::with_capacity(32 + output.len());
//!     data.extend_from_slice(request_id);
//!     data.extend_from_slice(output);
//!     keccak::hash(&data).to_bytes()
//! }
//!
//! fn verify_signature(
//!     message_hash: &[u8; 32],
//!     signature: &chain_signatures::Signature,
//!     expected_address: &[u8; 20],
//! ) -> Result<()> {
//!     let mut sig_bytes = [0u8; 64];
//!     sig_bytes[..32].copy_from_slice(&signature.big_r.x);
//!     sig_bytes[32..].copy_from_slice(&signature.s);
//!
//!     let recovered = secp256k1_recover(message_hash, signature.recovery_id, &sig_bytes)?;
//!     let pubkey_hash = keccak::hash(&recovered.to_bytes());
//!     let address = &pubkey_hash.to_bytes()[12..];
//!
//!     require!(address == expected_address, ErrorCode::InvalidSignature);
//!     Ok(())
//! }
//! ```
//!
//! # CAIP-2 Chain Identifiers
//!
//! Use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format
//! for the `caip2_id` parameter:
//!
//! | Chain | CAIP-2 ID | Chain ID |
//! |-------|-----------|----------|
//! | Ethereum Mainnet | `eip155:1` | 1 |
//!
//! # Request ID Generation
//!
//! Each request must have a unique ID. Generate it using packed ABI encoding:
//!
//! ```rust,ignore
//! use alloy_sol_types::SolValue;
//! use anchor_lang::solana_program::keccak;
//!
//! fn generate_request_id(
//!     sender: &Pubkey,
//!     transaction_data: &[u8],
//!     caip2_id: &str,
//!     key_version: u32,
//!     path: &str,
//!     algo: &str,
//!     dest: &str,
//!     params: &str,
//! ) -> [u8; 32] {
//!     let encoded = (
//!         sender.to_string(),
//!         transaction_data,
//!         caip2_id,
//!         key_version,
//!         path,
//!         algo,
//!         dest,
//!         params,
//!     ).abi_encode_packed();
//!
//!     keccak::hash(&encoded).to_bytes()
//! }
//! ```
//!
//! # Error Handling
//!
//! ## Magic Error Prefix
//!
//! Failed EVM transactions return output prefixed with `0xDEADBEEF`:
//!
//! ```rust,ignore
//! const ERROR_PREFIX: [u8; 4] = [0xDE, 0xAD, 0xBE, 0xEF];
//!
//! fn is_error_response(output: &[u8]) -> bool {
//!     output.len() >= 4 && output[..4] == ERROR_PREFIX
//! }
//! ```
//!
//! # Response Signature Verification
//!
//! The response signature uses a **different derivation path** than the transaction signature:
//!
//! | Signature | Derivation Path |
//! |-----------|-----------------|
//! | Transaction signature | User's `path` parameter |
//! | Response signature | `"solana response key"` (hardcoded) |
//!
//! This means you must derive the expected response public key using:
//! ```text
//! epsilon = derive_epsilon(key_version, sender, "solana response key")
//! response_pubkey = derive_key(mpc_root_pubkey, epsilon)
//! response_address = keccak256(response_pubkey)[12..32]
//! ```
