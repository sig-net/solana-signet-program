use anchor_client::anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_program::{message::Message, pubkey::Pubkey};
use solana_sdk::{signature::Keypair, signer::Signer, system_program, transaction::Transaction};
use tests::helpers::{generate_and_fund_key, submit_transaction};

#[test]
fn test_init_sign_respond() {
    let mut svm = litesvm::LiteSVM::new();
    svm.add_program_from_file(signet::ID, "../target/deploy/signet.so")
        .unwrap();

    let payer = generate_and_fund_key(&mut svm);
    let requester = generate_and_fund_key(&mut svm);
    let responder = generate_and_fund_key(&mut svm);
    let system_program = system_program::ID;
    let admin = generate_and_fund_key(&mut svm);

    let program_id = signet::id();
    let (program_state, _bump) = Pubkey::find_program_address(&[b"program-state"], &program_id);

    let init_instruction = initialize_instruction(program_id, program_state, &admin);
    let init_result = submit_transaction(&mut svm, &[init_instruction], &payer, &[&payer, &admin]);

    assert!(
        init_result.is_ok(),
        "Initialization failed: {:?}",
        init_result
    );

    // TODO: sign / respond logic
}

pub fn initialize_instruction(
    program_id: Pubkey,
    program_state: Pubkey,
    admin: &Keypair,
) -> solana_sdk::instruction::Instruction {
    solana_sdk::instruction::Instruction {
        program_id,
        data: signet::instruction::Initialize {
            signature_deposit: 1,
            network_id: "solana:localnet".to_string(),
        }
        .data(),
        accounts: signet::accounts::Initialize {
            program_state,
            admin: admin.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    }
}
