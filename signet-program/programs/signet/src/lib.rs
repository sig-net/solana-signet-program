//! # Signet Chain Signatures Program
//!
//! Solana program for cross-chain signature requests with verified response callbacks.
//!
//! ## Overview
//!
//! This program enables users to request ECDSA signatures from the Signet MPC network,
//! supporting both simple signing and bidirectional cross-chain transactions.
//!
//! ## Supported Flows
//!
//! | Flow | Description |
//! |------|-------------|
//! | [`chain_signatures::sign`] | Request signature on a 32-byte payload |
//! | [`chain_signatures::sign_bidirectional`] | Cross-chain tx with execution result callback |
//!
//! ## Sign Bidirectional Flow
//!
//! The bidirectional flow enables cross-chain transaction execution with verified
//! response callbacks:
//!
//! ```text
//! User                    Solana                  MPC Network           Ethereum
//!   │                        │                         │                    │
//!   │ sign_bidirectional()   │                         │                    │
//!   ├───────────────────────►│                         │                    │
//!   │                        │  SignBidirectionalEvent │                    │
//!   │                        ├────────────────────────►│                    │
//!   │                        │◄──── respond() ─────────┤                    │
//!   │                        │                         │                    │
//!   │ Poll SignatureRespondedEvent                     │                    │
//!   │◄───────────────────────┤                         │                    │
//!   │                        │                         │                    │
//!   │ Broadcast signed tx ───┼─────────────────────────┼───────────────────►│
//!   │                        │                         │◄── Light client ───┤
//!   │                        │◄─ respond_bidirectional()                    │
//!   │                        │                         │                    │
//!   │ Poll RespondBidirectionalEvent                   │                    │
//!   │◄───────────────────────┤                         │                    │
//! ```
//!
//! ### Phase 1-2: Sign Request
//!
//! 1. User calls [`chain_signatures::sign_bidirectional`] with unsigned transaction (RLP-encoded)
//! 2. Program emits [`SignBidirectionalEvent`]
//! 3. MPC network signs and calls [`chain_signatures::respond`], emitting [`SignatureRespondedEvent`]
//!
//! ### Phase 3: User Broadcast
//!
//! User polls for signature, assembles signed tx, broadcasts to destination chain.
//! **The MPC network does NOT broadcast** - this is the user's responsibility.
//!
//! ### Phase 4-6: Observation & Response
//!
//! 1. MPC light client observes destination chain for tx confirmation
//! 2. Extracts execution output (for contract calls, simulates via `eth_call`)
//! 3. Calls [`chain_signatures::respond_bidirectional`] with serialized output and signature
//! 4. Program emits [`RespondBidirectionalEvent`] for user to poll
//!
//! ## Request ID Generation
//!
//! Each request has a unique ID for tracking:
//!
//! ```text
//! // For sign_bidirectional (packed encoding):
//! request_id = keccak256(
//!     sender || serialized_tx || caip2_id || key_version ||
//!     path || algo || dest || params
//! )
//! ```
//!
//! ## Serialization Schemas
//!
//! Cross-chain data encoding uses two schemas:
//!
//! | Schema | Format | Direction | Example |
//! |--------|--------|-----------|---------|
//! | `output_deserialization_schema` | ABI | Ethereum → MPC | `[{"name":"result","type":"uint256"}]` |
//! | `respond_serialization_schema` | Borsh | MPC → Solana | `[{"name":"output","type":"bytes"}]` |
//!
//! ## Error Handling
//!
//! Failed destination chain transactions are indicated with magic prefix:
//!
//! ```rust,ignore
//! const MAGIC_ERROR_PREFIX: [u8; 4] = [0xde, 0xad, 0xbe, 0xef];
//!
//! // Check if response indicates failure:
//! fn is_error(output: &[u8]) -> bool {
//!     output.starts_with(&[0xde, 0xad, 0xbe, 0xef])
//! }
//! ```
//!
//! ## Address Derivation
//!
//! Each user gets a unique destination chain address derived from:
//!
//! ```text
//! epsilon = derive_epsilon(sender_pubkey, derivation_path)
//! user_pubkey = derive_key(mpc_root_pubkey, epsilon)
//! eth_address = keccak256(user_pubkey)[12..32]
//! ```
//!
//! ## Response Signature Verification
//!
//! The `respond_bidirectional` response is signed using a **special derivation path**:
//!
//! ```text
//! const RESPONSE_DERIVATION_PATH: &str = "solana response key";
//!
//! // Response epsilon derivation:
//! epsilon = derive_epsilon(key_version, sender_pubkey, "solana response key")
//! response_pubkey = derive_key(mpc_root_pubkey, epsilon)
//! ```
//!
//! The signature is computed over:
//!
//! ```text
//! message_hash = keccak256(request_id || serialized_output)
//! ```
//!
//! To verify the response signature, clients must:
//! 1. Recover the public key from the signature using `secp256k1_recover`
//! 2. Derive the expected response public key using the `"solana response key"` path
//! 3. Compare the recovered public key with the expected response public key
//!
//! ## Security Notes
//!
//! - [`chain_signatures::respond`] and [`chain_signatures::respond_bidirectional`] can be called by any address
//! - Clients **must verify signature validity** off-chain
//! - Events are the source of truth, not on-chain state
//! - Response signatures use a different derivation path than transaction signatures
//!
//! # Solana → EVM Cross-Chain Guide
//!
//! This section documents how to use `sign_bidirectional` to execute transactions
//! on EVM chains (Ethereum, Arbitrum, etc.) from Solana and receive execution results.
//!
//! ## Flow Overview
//!
//! 1. Build an unsigned EVM transaction (RLP-encoded)
//! 2. Call `sign_bidirectional` on Solana with the serialized transaction
//! 3. Poll for [`SignatureRespondedEvent`] to get the signature
//! 4. Assemble and broadcast the signed transaction to the EVM chain
//! 5. Poll for [`RespondBidirectionalEvent`] to get the execution result
//!
//! ## Transaction Encoding
//!
//! EVM transactions must be RLP-encoded before passing to `sign_bidirectional`.
//! The MPC signs `keccak256(unsigned_rlp)`.
//!
//! ### EIP-1559 Transactions (Recommended)
//!
//! ```typescript,ignore
//! import { serializeTransaction, parseGwei } from 'viem'
//!
//! const unsignedTx = {
//!   type: 'eip1559',
//!   chainId: 1,
//!   nonce: 0,
//!   maxPriorityFeePerGas: parseGwei('1'),
//!   maxFeePerGas: parseGwei('20'),
//!   gas: 21000n,
//!   to: '0x...',
//!   value: 0n,
//!   data: '0x'
//! }
//!
//! const serializedTx = serializeTransaction(unsignedTx)
//! // Result: 0x02... (EIP-1559 prefix + RLP body)
//! ```
//!
//! **What Gets Signed**:
//!
//! ```text
//! Hash = keccak256(0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
//!                               gasLimit, to, value, data, accessList]))
//! ```
//!
//! ### Legacy Transactions
//!
//! ```text
//! Hash = keccak256(RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))
//! ```
//!
//! ## Parameters for EVM Destination
//!
//! | Parameter | Value |
//! |-----------|-------|
//! | `serialized_transaction` | RLP-encoded unsigned transaction bytes |
//! | `caip2_id` | `"eip155:1"` (mainnet), `"eip155:11155111"` (Sepolia) |
//! | `key_version` | MPC key version (typically `0`) |
//! | `path` | User derivation path (e.g., `""` or `"my_vault"`) |
//! | `algo` | `""` (default secp256k1) |
//! | `dest` | `"ethereum"` |
//! | `params` | `""` |
//!
//! ## Schemas
//!
//! ### Output Deserialization Schema (ABI Format)
//!
//! Defines how to parse the EVM contract's return value:
//!
//! ```json,ignore
//! [{"name": "result", "type": "uint256"}, {"name": "success", "type": "bool"}]
//! ```
//!
//! **Supported ABI Types**: `uint256`, `int256`, `bool`, `address`, `bytes32`, `bytes`, `string`
//!
//! ### Respond Serialization Schema (Borsh Format)
//!
//! Defines how to serialize the response for Solana:
//!
//! ```json,ignore
//! [{"name": "output", "type": "bytes"}]
//! ```
//!
//! For simple boolean results (e.g., ERC20 transfer):
//!
//! ```json,ignore
//! "bool"
//! ```
//!
//! ## Handling the Signature
//!
//! After `sign_bidirectional`, poll for [`SignatureRespondedEvent`]:
//!
//! ```typescript,ignore
//! const signature = event.signature
//! const r = '0x' + Buffer.from(signature.bigR.x).toString('hex')
//! const s = '0x' + Buffer.from(signature.s).toString('hex')
//! const v = 27n + BigInt(signature.recoveryId)
//!
//! // Assemble signed transaction
//! const signedTx = serializeTransaction(unsignedTx, { r, s, v })
//! ```
//!
//! ## Handling the Response
//!
//! Poll for [`RespondBidirectionalEvent`] after the EVM transaction confirms:
//!
//! ```typescript,ignore
//! const MAGIC_ERROR_PREFIX = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
//!
//! function parseResponse(serializedOutput: Uint8Array) {
//!   if (serializedOutput.slice(0, 4).every((b, i) => b === MAGIC_ERROR_PREFIX[i])) {
//!     return { success: false, error: 'Transaction reverted' }
//!   }
//!   return { success: true, data: deserializeBorsh(serializedOutput) }
//! }
//! ```
//!
//! ## CAIP-2 Chain Identifiers
//!
//! | Chain | CAIP-2 ID |
//! |-------|-----------|
//! | Ethereum Mainnet | `eip155:1` |
//! | Sepolia | `eip155:11155111` |
//! | Arbitrum One | `eip155:42161` |
//! | Optimism | `eip155:10` |
//! | Base | `eip155:8453` |
//! | Polygon | `eip155:137` |
//!
//! ## Light Client Observation
//!
//! The MPC uses [Helios](https://github.com/a16z/helios) to observe EVM chains:
//!
//! - Validates beacon chain headers (consensus sync)
//! - Verifies state without full node (execution proofs)
//! - Uses `eth_getBlockReceipts` for transaction status
//! - Uses `eth_call` to simulate and extract return data

#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("H5tHfpYoEnarrrzcV7sWBcZhiKMvL2aRpUYvb1ydWkwS");

#[program]
pub mod chain_signatures {
    use super::*;

    /// Initialize the program state.
    ///
    /// # Arguments
    ///
    /// * `signature_deposit` - Required deposit in lamports for signature requests
    /// * `chain_id` - CAIP-2 chain identifier (e.g., "solana:mainnet")
    ///
    /// # Accounts
    ///
    /// * `program_state` - PDA to store program configuration
    /// * `admin` - Admin account (becomes program admin)
    pub fn initialize(
        ctx: Context<Initialize>,
        signature_deposit: u64,
        chain_id: String,
    ) -> Result<()> {
        let program_state = &mut ctx.accounts.program_state;
        program_state.admin = ctx.accounts.admin.key();
        program_state.signature_deposit = signature_deposit;
        program_state.chain_id = chain_id;

        Ok(())
    }

    /// Update the required signature deposit amount. Admin only.
    ///
    /// # Arguments
    ///
    /// * `new_deposit` - New deposit amount in lamports
    ///
    /// # Emits
    ///
    /// * [`DepositUpdatedEvent`]
    pub fn update_deposit(ctx: Context<AdminOnly>, new_deposit: u64) -> Result<()> {
        let program_state = &mut ctx.accounts.program_state;
        let old_deposit = program_state.signature_deposit;
        program_state.signature_deposit = new_deposit;

        emit!(DepositUpdatedEvent {
            old_deposit,
            new_deposit,
        });

        Ok(())
    }

    /// Withdraw accumulated funds from the program. Admin only.
    ///
    /// # Arguments
    ///
    /// * `amount` - Amount to withdraw in lamports
    ///
    /// # Errors
    ///
    /// * [`ChainSignaturesError::InsufficientFunds`] - Program has insufficient balance
    /// * [`ChainSignaturesError::InvalidRecipient`] - Recipient is zero address
    ///
    /// # Emits
    ///
    /// * [`FundsWithdrawnEvent`]
    pub fn withdraw_funds(ctx: Context<WithdrawFunds>, amount: u64) -> Result<()> {
        let program_state = &ctx.accounts.program_state;
        let recipient = &ctx.accounts.recipient;

        let program_state_info = program_state.to_account_info();
        require!(
            program_state_info.lamports() >= amount,
            ChainSignaturesError::InsufficientFunds
        );

        require!(
            recipient.key() != Pubkey::default(),
            ChainSignaturesError::InvalidRecipient
        );

        // Transfer funds from program_state to recipient
        **program_state_info.try_borrow_mut_lamports()? -= amount;
        **recipient.try_borrow_mut_lamports()? += amount;

        emit!(FundsWithdrawnEvent {
            amount,
            recipient: recipient.key(),
        });

        Ok(())
    }

    /// Request a signature from the MPC network on a 32-byte payload.
    ///
    /// The payload is typically a transaction hash that needs to be signed.
    /// The MPC network will respond with a signature via [`respond`].
    ///
    /// # Arguments
    ///
    /// * `payload` - 32-byte data to sign (typically a transaction hash)
    /// * `key_version` - MPC key version to use
    /// * `path` - Derivation path for the user's key (e.g., `"eth"`, `"btc"`)
    /// * `algo` - Signing algorithm (e.g., `"secp256k1"`)
    /// * `dest` - Response destination chain
    /// * `params` - Additional parameters as JSON
    ///
    /// # Emits
    ///
    /// * [`SignatureRequestedEvent`]
    ///
    /// # Example
    ///
    /// ```typescript,ignore
    /// await program.methods
    ///   .sign(
    ///     Array.from(txHash),  // [u8; 32]
    ///     0,                    // key_version
    ///     "eth",                // path
    ///     "",                   // algo
    ///     "",                   // dest
    ///     ""                    // params
    ///   )
    ///   .accounts({ ... })
    ///   .rpc();
    /// ```
    pub fn sign(
        ctx: Context<Sign>,
        payload: [u8; 32],
        key_version: u32,
        path: String,
        algo: String,
        dest: String,
        params: String,
    ) -> Result<()> {
        let program_state = &ctx.accounts.program_state;
        let requester = &ctx.accounts.requester;
        let system_program = &ctx.accounts.system_program;

        let payer = match &ctx.accounts.fee_payer {
            Some(fee_payer) => fee_payer.to_account_info(),
            None => requester.to_account_info(),
        };

        require!(
            payer.lamports() >= program_state.signature_deposit,
            ChainSignaturesError::InsufficientDeposit
        );

        let transfer_instruction = anchor_lang::system_program::Transfer {
            from: payer,
            to: program_state.to_account_info(),
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(system_program.to_account_info(), transfer_instruction),
            program_state.signature_deposit,
        )?;

        emit_cpi!(SignatureRequestedEvent {
            sender: *requester.key,
            payload,
            key_version,
            deposit: program_state.signature_deposit,
            chain_id: program_state.chain_id.clone(),
            path,
            algo,
            dest,
            params,
            fee_payer: match &ctx.accounts.fee_payer {
                Some(payer) => Some(*payer.key),
                None => None,
            },
        });

        Ok(())
    }

    /// Initiate a bidirectional cross-chain transaction with execution result callback.
    ///
    /// This is the primary entry point for cross-chain transactions. The flow:
    /// 1. User submits unsigned transaction → MPC signs and responds
    /// 2. User broadcasts to destination chain
    /// 3. MPC observes execution via light client
    /// 4. MPC returns execution result via [`respond_bidirectional`]
    ///
    /// # Arguments
    ///
    /// * `serialized_transaction` - RLP-encoded unsigned transaction for destination chain
    /// * `caip2_id` - CAIP-2 chain identifier (e.g., `"eip155:1"` for Ethereum mainnet)
    /// * `key_version` - MPC key version to use
    /// * `path` - Derivation path for signing key
    /// * `algo` - Signing algorithm
    /// * `dest` - Response destination
    /// * `params` - Additional parameters as JSON
    /// * `program_id` - Callback program ID (reserved for future use)
    /// * `output_deserialization_schema` - ABI schema for parsing destination chain output
    /// * `respond_serialization_schema` - Borsh schema for serializing response to Solana
    ///
    /// # Schemas Format
    ///
    /// **output_deserialization_schema** (ABI):
    /// ```json,ignore
    /// [{"name": "result", "type": "uint256"}, {"name": "success", "type": "bool"}]
    /// ```
    ///
    /// **respond_serialization_schema** (Borsh):
    /// ```json,ignore
    /// [{"name": "output", "type": "bytes"}]
    /// ```
    ///
    /// # Emits
    ///
    /// * [`SignBidirectionalEvent`]
    ///
    /// # Errors
    ///
    /// * [`ChainSignaturesError::InvalidTransaction`] - Empty transaction data
    /// * [`ChainSignaturesError::InsufficientDeposit`] - Insufficient deposit
    pub fn sign_bidirectional(
        ctx: Context<SignBidirectional>,
        serialized_transaction: Vec<u8>,
        caip2_id: String,
        key_version: u32,
        path: String,
        algo: String,
        dest: String,
        params: String,
        program_id: Pubkey,
        output_deserialization_schema: Vec<u8>,
        respond_serialization_schema: Vec<u8>,
    ) -> Result<()> {
        let program_state = &ctx.accounts.program_state;
        let requester = &ctx.accounts.requester;
        let system_program = &ctx.accounts.system_program;

        let payer = match &ctx.accounts.fee_payer {
            Some(fee_payer) => fee_payer.to_account_info(),
            None => requester.to_account_info(),
        };

        require!(
            payer.lamports() >= program_state.signature_deposit,
            ChainSignaturesError::InsufficientDeposit
        );

        require!(
            !serialized_transaction.is_empty(),
            ChainSignaturesError::InvalidTransaction
        );

        let transfer_instruction = anchor_lang::system_program::Transfer {
            from: payer,
            to: program_state.to_account_info(),
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(system_program.to_account_info(), transfer_instruction),
            program_state.signature_deposit,
        )?;

        emit_cpi!(SignBidirectionalEvent {
            sender: *requester.key,
            serialized_transaction,
            caip2_id,
            key_version,
            deposit: program_state.signature_deposit,
            path,
            algo,
            dest,
            params,
            program_id,
            output_deserialization_schema,
            respond_serialization_schema
        });

        Ok(())
    }

    /// Respond to signature requests with generated signatures.
    ///
    /// Called by MPC responders after signature generation. Emits events
    /// in canonical order for batched requests (PSBT-style).
    ///
    /// # Security Note
    ///
    /// **Any address can call this function.** Clients must verify signature
    /// validity off-chain before trusting the response.
    ///
    /// # Arguments
    ///
    /// * `request_ids` - Array of 32-byte request identifiers
    /// * `signatures` - Corresponding ECDSA signatures
    ///
    /// # Emits
    ///
    /// * [`SignatureRespondedEvent`] for each signature
    pub fn respond(
        ctx: Context<Respond>,
        request_ids: Vec<[u8; 32]>,
        signatures: Vec<Signature>,
    ) -> Result<()> {
        require!(
            request_ids.len() == signatures.len(),
            ChainSignaturesError::InvalidInputLength
        );

        for i in 0..request_ids.len() {
            emit_cpi!(SignatureRespondedEvent {
                request_id: request_ids[i],
                responder: *ctx.accounts.responder.key,
                signature: signatures[i].clone(),
            });
        }

        Ok(())
    }

    /// Report signature generation errors from the MPC network.
    ///
    /// # Security Note
    ///
    /// **Any address can call this function.** Do not rely on error events
    /// for business logic decisions.
    ///
    /// # Arguments
    ///
    /// * `errors` - Array of error responses with request IDs and messages
    ///
    /// # Emits
    ///
    /// * [`SignatureErrorEvent`] for each error
    pub fn respond_error(ctx: Context<RespondError>, errors: Vec<ErrorResponse>) -> Result<()> {
        for error in errors {
            emit!(SignatureErrorEvent {
                request_id: error.request_id,
                responder: *ctx.accounts.responder.key,
                error: error.error_message,
            });
        }

        Ok(())
    }

    /// Get the current signature deposit amount. View function.
    ///
    /// # Returns
    ///
    /// Current signature deposit in lamports.
    pub fn get_signature_deposit(ctx: Context<GetSignatureDeposit>) -> Result<u64> {
        let program_state = &ctx.accounts.program_state;
        Ok(program_state.signature_deposit)
    }

    /// Finalize a bidirectional flow with execution results from the destination chain.
    ///
    /// Called by MPC responders after observing transaction confirmation on the
    /// destination chain. The signature proves the authenticity of the output.
    ///
    /// # Arguments
    ///
    /// * `request_id` - Original 32-byte request identifier
    /// * `serialized_output` - Borsh-serialized execution output per `respond_serialization_schema`
    /// * `signature` - ECDSA signature over `keccak256(request_id || serialized_output)`
    ///
    /// # Output Format
    ///
    /// For **successful transactions**:
    /// - Contract call: Serialized return value per schema
    /// - Simple transfer: Empty success indicator
    ///
    /// For **failed transactions**:
    /// - Magic prefix `0xdeadbeef` followed by `true` (Borsh-encoded)
    ///
    /// # Emits
    ///
    /// * [`RespondBidirectionalEvent`]
    pub fn respond_bidirectional(
        ctx: Context<ReadRespond>,
        request_id: [u8; 32],
        serialized_output: Vec<u8>,
        signature: Signature,
    ) -> Result<()> {
        emit!(RespondBidirectionalEvent {
            request_id,
            responder: *ctx.accounts.responder.key,
            serialized_output,
            signature,
        });

        Ok(())
    }
}

/// Program configuration state stored in a PDA.
///
/// Seeds: `[b"program-state"]`
#[account]
pub struct ProgramState {
    /// Admin account with permission to update settings and withdraw funds.
    pub admin: Pubkey,
    /// Required deposit in lamports for signature requests.
    pub signature_deposit: u64,
    /// CAIP-2 chain identifier (e.g., "solana:mainnet").
    pub chain_id: String,
}

/// A point on the secp256k1 elliptic curve in affine coordinates.
///
/// Used to represent the R point in ECDSA signatures.
///
/// # Size
///
/// 64 bytes total (32 bytes x + 32 bytes y)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AffinePoint {
    /// X coordinate (big-endian, 32 bytes)
    pub x: [u8; 32],
    /// Y coordinate (big-endian, 32 bytes)
    pub y: [u8; 32],
}

/// ECDSA signature in affine point representation.
///
/// Compatible with secp256k1 curve operations. Can be converted to
/// standard RSV format for use with Ethereum and other chains.
///
/// # Size
///
/// 97 bytes total (64 bytes big_r + 32 bytes s + 1 byte recovery_id)
///
/// # Conversion to RSV
///
/// ```typescript,ignore
/// const r = Buffer.from(signature.bigR.x).toString('hex');
/// const s = Buffer.from(signature.s).toString('hex');
/// const v = signature.recoveryId + 27;
/// ```
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Signature {
    /// R point of the ECDSA signature (affine coordinates)
    pub big_r: AffinePoint,
    /// s scalar of the signature (32 bytes, big-endian)
    pub s: [u8; 32],
    /// Recovery ID (0 or 1) for public key recovery
    pub recovery_id: u8,
}

/// Error information for failed signature requests.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ErrorResponse {
    /// Identifier of the failed request
    pub request_id: [u8; 32],
    /// Human-readable error description
    pub error_message: String,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 8 + 4 + 128, // discriminator + admin + deposit + string length + max chain_id length
        seeds = [b"program-state"],
        bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"program-state"],
        bump,
        has_one = admin @ ChainSignaturesError::Unauthorized
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawFunds<'info> {
    #[account(
        mut,
        seeds = [b"program-state"],
        bump,
        has_one = admin @ ChainSignaturesError::Unauthorized
    )]
    pub program_state: Account<'info, ProgramState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: The safety check is performed in the withdraw_funds
    /// function by checking it is not the zero address.
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Sign<'info> {
    #[account(mut, seeds = [b"program-state"], bump)]
    pub program_state: Account<'info, ProgramState>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SignBidirectional<'info> {
    #[account(mut, seeds = [b"program-state"], bump)]
    pub program_state: Account<'info, ProgramState>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Option<Signer<'info>>,
    pub system_program: Program<'info, System>,
    pub instructions: Option<AccountInfo<'info>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Respond<'info> {
    pub responder: Signer<'info>,
}

#[derive(Accounts)]
pub struct RespondError<'info> {
    pub responder: Signer<'info>,
}

#[derive(Accounts)]
pub struct GetSignatureDeposit<'info> {
    #[account(seeds = [b"program-state"], bump)]
    pub program_state: Account<'info, ProgramState>,
}

#[derive(Accounts)]
pub struct ReadRespond<'info> {
    pub responder: Signer<'info>,
}

/// Emitted when a signature is requested via the [`chain_signatures::sign`] instruction.
///
/// # Event Type
///
/// CPI event (emitted via `emit_cpi!`)
#[event]
pub struct SignatureRequestedEvent {
    /// Solana address of the requester.
    pub sender: Pubkey,
    /// 32-byte payload to be signed (typically a transaction hash).
    pub payload: [u8; 32],
    /// MPC key version used for signing.
    pub key_version: u32,
    /// Deposit amount paid in lamports.
    pub deposit: u64,
    /// CAIP-2 chain identifier of this program (e.g., "solana:mainnet").
    pub chain_id: String,
    /// Derivation path for the user's signing key.
    pub path: String,
    /// Signing algorithm (e.g., "secp256k1").
    pub algo: String,
    /// Response destination chain.
    pub dest: String,
    /// Additional JSON parameters.
    pub params: String,
    /// Optional separate fee payer account.
    pub fee_payer: Option<Pubkey>,
}

/// Emitted when a bidirectional cross-chain request is made via
/// [`chain_signatures::sign_bidirectional`].
///
/// # Event Type
///
/// CPI event (emitted via `emit_cpi!`)
///
/// # Usage
///
/// The MPC network listens for this event to:
/// 1. Sign the transaction and call [`chain_signatures::respond`]
/// 2. Store the pending tx in backlog for observation
/// 3. Monitor destination chain for confirmation
/// 4. Call [`chain_signatures::respond_bidirectional`] with results
#[event]
pub struct SignBidirectionalEvent {
    /// Solana address of the requester.
    pub sender: Pubkey,
    /// RLP-encoded unsigned transaction for the destination chain.
    pub serialized_transaction: Vec<u8>,
    /// CAIP-2 chain identifier of the destination (e.g., "eip155:1" for Ethereum).
    pub caip2_id: String,
    /// MPC key version used for signing.
    pub key_version: u32,
    /// Deposit amount paid in lamports.
    pub deposit: u64,
    /// Derivation path for the user's signing key.
    pub path: String,
    /// Signing algorithm (e.g., "secp256k1").
    pub algo: String,
    /// Response destination identifier.
    pub dest: String,
    /// Additional JSON parameters.
    pub params: String,
    /// Callback program ID (reserved for future use).
    pub program_id: Pubkey,
    /// ABI schema for parsing destination chain call output (JSON-encoded).
    pub output_deserialization_schema: Vec<u8>,
    /// Borsh schema for serializing response to Solana (JSON-encoded).
    pub respond_serialization_schema: Vec<u8>,
}

/// Emitted when the MPC network returns a signature via [`chain_signatures::respond`].
///
/// # Event Type
///
/// CPI event (emitted via `emit_cpi!`)
///
/// # Security Warning
///
/// **Any address can emit this event.** Clients **must** verify signature validity
/// by recovering the public key and comparing with the expected derived key.
#[event]
pub struct SignatureRespondedEvent {
    /// Request identifier linking this response to the original request.
    /// Computed as `keccak256(sender || payload || ...)` - see module docs.
    pub request_id: [u8; 32],
    /// Address of the MPC responder (not cryptographically verified).
    pub responder: Pubkey,
    /// ECDSA signature in affine point format.
    pub signature: Signature,
}

/// Emitted when signature generation fails via [`chain_signatures::respond_error`].
///
/// # Event Type
///
/// Regular event (emitted via `emit!`)
///
/// # Security Warning
///
/// **Any address can emit this event.** Do not rely on error events for
/// business logic decisions.
#[event]
pub struct SignatureErrorEvent {
    /// Request identifier of the failed request.
    pub request_id: [u8; 32],
    /// Address of the MPC responder (not cryptographically verified).
    pub responder: Pubkey,
    /// Human-readable error description.
    pub error: String,
}

/// Emitted when the MPC network returns execution results for a bidirectional
/// request via [`chain_signatures::respond_bidirectional`].
///
/// # Event Type
///
/// Regular event (emitted via `emit!`)
///
/// # Output Format
///
/// **Successful transactions:**
/// - Contract call: Return value serialized per `respond_serialization_schema`
/// - Simple transfer: Empty success indicator
///
/// **Failed transactions:**
/// - Magic prefix `0xdeadbeef` followed by `true` (Borsh-encoded as single byte `0x01`)
///
/// # Signature Verification
///
/// The signature is computed over `keccak256(request_id || serialized_output)` using
/// the special derivation path `"solana response key"`. See module-level docs for
/// verification procedure.
///
/// # Security Warning
///
/// **Any address can emit this event.** Clients **must** verify the signature
/// before trusting the output.
#[event]
pub struct RespondBidirectionalEvent {
    /// Original request identifier.
    pub request_id: [u8; 32],
    /// Address of the MPC responder (not cryptographically verified).
    pub responder: Pubkey,
    /// Borsh-serialized execution output per `respond_serialization_schema`.
    /// Check for `0xdeadbeef` prefix to detect failures.
    pub serialized_output: Vec<u8>,
    /// ECDSA signature over `keccak256(request_id || serialized_output)`.
    pub signature: Signature,
}

/// Emitted when the admin updates the signature deposit via
/// [`chain_signatures::update_deposit`].
#[event]
pub struct DepositUpdatedEvent {
    /// Previous deposit amount in lamports.
    pub old_deposit: u64,
    /// New deposit amount in lamports.
    pub new_deposit: u64,
}

/// Emitted when the admin withdraws funds via [`chain_signatures::withdraw_funds`].
#[event]
pub struct FundsWithdrawnEvent {
    /// Amount withdrawn in lamports.
    pub amount: u64,
    /// Recipient address.
    pub recipient: Pubkey,
}

#[error_code]
pub enum ChainSignaturesError {
    #[msg("Insufficient deposit amount")]
    InsufficientDeposit,
    #[msg("Arrays must have the same length")]
    InvalidInputLength,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Insufficient funds for withdrawal")]
    InsufficientFunds,
    #[msg("Invalid recipient address")]
    InvalidRecipient,
    #[msg("Invalid transaction data")]
    InvalidTransaction,
    #[msg("Missing instruction sysvar")]
    MissingInstructionSysvar,
}
