use signet::Initialize;
use solana_sdk::{
    instruction::Instruction, pubkey::Pubkey, signature::Keypair, system_program,
    transaction::TransactionError,
};

use crate::helpers::generate_and_fund_key;

pub struct SetupOptions {
    pub deposit: u64,
}

impl Default for SetupOptions {
    fn default() -> Self {
        SetupOptions { deposit: 1 }
    }
}

pub struct SetupResult {
    pub svm: litesvm::LiteSVM,
    pub payer: Keypair,
    pub admin: Keypair,
}

pub fn setup(options: Option<SetupOptions>) -> Result<SetupResult, TransactionError> {
    let options = options.unwrap_or_default();

    let mut svm = litesvm::LiteSVM::new();

    let payer = generate_and_fund_key(&mut svm);
    let admin = generate_and_fund_key(&mut svm);

    // TODO: move logic from the test here

    Ok(SetupResult { svm, payer, admin })
}
