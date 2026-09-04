use sha2::Digest;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    transaction::Transaction,
};

const USAGE: &str = "usage: admin <rpc_url> <payer_keypair.json> <program_id> \
<update-chain-id <chain_id> | update-deposit <lamports>>";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let rpc_url = args.get(1).ok_or_else(|| anyhow::anyhow!(USAGE))?.clone();
    let payer_path = args.get(2).ok_or_else(|| anyhow::anyhow!(USAGE))?.clone();
    let program_id: Pubkey = args
        .get(3)
        .ok_or_else(|| anyhow::anyhow!(USAGE))?
        .parse()?;
    let arg = args.get(5).ok_or_else(|| anyhow::anyhow!(USAGE))?;
    let payer = load_keypair(&payer_path)?;
    let rpc = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());

    let (state_pda, _) = Pubkey::find_program_address(&[b"program-state"], &program_id);

    let data = match args.get(4).map(String::as_str) {
        Some("update-chain-id") => {
            let mut data = ix_disc("update_chain_id");
            data.extend_from_slice(&(arg.len() as u32).to_le_bytes());
            data.extend_from_slice(arg.as_bytes());
            data
        }
        Some("update-deposit") => {
            let deposit: u64 = arg.parse()?;
            let mut data = ix_disc("update_deposit");
            data.extend_from_slice(&deposit.to_le_bytes());
            data
        }
        _ => anyhow::bail!("{USAGE}"),
    };

    let ix = Instruction::new_with_bytes(
        program_id,
        &data,
        vec![
            AccountMeta::new(state_pda, false),
            AccountMeta::new(payer.pubkey(), true),
        ],
    );

    let blockhash = rpc.get_latest_blockhash().await?;
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
    let sig: Signature = rpc.send_and_confirm_transaction(&tx).await?;
    println!("tx committed: {sig}");
    Ok(())
}

fn ix_disc(name: &str) -> Vec<u8> {
    sha2::Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec()
}

fn load_keypair(path: &str) -> anyhow::Result<Keypair> {
    let raw = std::fs::read_to_string(path)?;
    let bytes: Vec<u8> = raw
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().parse::<u8>().map_err(|e| anyhow::anyhow!("{e}")))
        .collect::<Result<Vec<u8>, _>>()?;
    Ok(Keypair::try_from(bytes.as_slice())?)
}
