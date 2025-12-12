#![doc = include_str!("../README.md")]
#![allow(unexpected_cfgs)]

pub mod evm;
use anchor_lang::prelude::*;

declare_id!("SigMcRMjKfnC7RDG5q4yUMZM1s5KJ9oYTPP4NmJRDRw");

#[program]
pub mod chain_signatures {
    use super::*;

    /// Initialize the program state.
    ///
    /// # Admin Only
    ///
    /// This instruction is restricted to program deployment and is **not intended
    /// for application developers**. It can only be called once to set up the program.
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

    /// Update the required signature deposit amount.
    ///
    /// # Admin Only
    ///
    /// This instruction is restricted to the program administrator and is **not intended
    /// for application developers**. It is used for program maintenance.
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

    /// Withdraw accumulated funds from the program.
    ///
    /// # Admin Only
    ///
    /// This instruction is restricted to the program administrator and is **not intended
    /// for application developers**. It is used for program maintenance.
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
    /// * `path` - Derivation path for the user's key (e.g., `"my_wallet"`)
    /// * `algo` - Reserved for future use (pass empty string `""`)
    /// * `dest` - Reserved for future use (pass empty string `""`)
    /// * `params` - Reserved for future use (pass empty string `""`)
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
    ///     Array.from(txHash),  // [u8; 32] payload to sign
    ///     0,                    // key_version
    ///     "my_wallet",          // path (derivation path)
    ///     "",                   // algo (reserved, pass empty string)
    ///     "",                   // dest (reserved, pass empty string)
    ///     ""                    // params (reserved, pass empty string)
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
    /// * `serialized_transaction` - serialized unsigned transaction for destination chain
    /// * `caip2_id` - CAIP-2 chain identifier (e.g., `"eip155:1"` for Ethereum mainnet)
    /// * `key_version` - MPC key version to use
    /// * `path` - Derivation path for signing key
    /// * `algo` - Reserved for future use (pass empty string `""`)
    /// * `dest` - Reserved for future use (pass empty string `""`)
    /// * `params` - Reserved for future use (pass empty string `""`)
    /// * `program_id` - Callback program ID (reserved for future use)
    /// * `output_deserialization_schema` - serialization schema for parsing destination chain output
    /// * `respond_serialization_schema` - serialization schema for serializing response to source chain
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
    /// Called by MPC responders after signature generation. Supports batched
    /// requests where each signature is linked to its request via `request_id`.
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
    /// # Warning: Debugging Only
    ///
    /// This function is **solely for debugging purposes** and should not be used
    /// in production or relied upon for any business logic. Error events are
    /// informational only and are not cryptographically verified.
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
    /// * `serialized_output` - Serialized execution output per `respond_serialization_schema`
    /// * `signature` - ECDSA signature over `keccak256(request_id || serialized_output)`
    ///
    /// # Output Format
    ///
    /// For **successful transactions**:
    /// - Contract call: Serialized return value per schema
    /// - Simple transfer: Empty success indicator
    ///
    /// For **failed transactions**:
    /// - Magic prefix `0xdeadbeef` followed by failure indicator
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
    /// Schema for parsing destination chain call output (JSON-encoded).
    pub output_deserialization_schema: Vec<u8>,
    /// Schema for serializing response to source chain (JSON-encoded).
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
    /// Address of the responder. Clients must verify the signature was produced by the MPC.
    pub responder: Pubkey,
    /// ECDSA signature in affine point format.
    pub signature: Signature,
}

/// Emitted when signature generation fails via [`chain_signatures::respond_error`].
///
/// # Warning: Debugging Only
///
/// This event is **solely for debugging purposes**. Do not use in production
/// or rely upon for any business logic.
///
/// # Event Type
///
/// Regular event (emitted via `emit!`)
///
/// # Security Warning
///
/// **Any address can emit this event.** Error events are not cryptographically
/// verified and should never be trusted for business logic decisions.
#[event]
pub struct SignatureErrorEvent {
    /// Request identifier of the failed request.
    pub request_id: [u8; 32],
    /// Address of the MPC responder. Error events are not cryptographically verified.
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
/// - Magic prefix `0xdeadbeef` followed by failure indicator
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
    /// Address of the MPC responder. Clients must verify the signature was produced by the MPC.
    pub responder: Pubkey,
    /// Serialized execution output per `respond_serialization_schema`.
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
