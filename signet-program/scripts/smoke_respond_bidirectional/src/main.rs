use anchor_lang::{AnchorDeserialize, Discriminator};
use sha2::Digest;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::RpcTransactionConfig;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    transaction::Transaction,
};
use solana_transaction_status::{
    option_serializer::OptionSerializer, UiInstruction, UiParsedInstruction,
    UiTransactionEncoding,
};
use signet::{AffinePoint, RespondBidirectionalEvent, Signature as ProgSignature};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: smoke_respond_bidirectional <rpc_url> <payer_keypair.json> <program_id> <chain_id>";
    let rpc_url = args.get(1).ok_or_else(|| anyhow::anyhow!(usage))?.clone();
    let payer_path = args.get(2).ok_or_else(|| anyhow::anyhow!(usage))?.clone();
    let program_id: Pubkey = args
        .get(3)
        .ok_or_else(|| anyhow::anyhow!(usage))?
        .parse()?;
    let chain_id = args.get(4).ok_or_else(|| anyhow::anyhow!(usage))?.clone();

    let payer = load_keypair(&payer_path)?;
    let rpc = RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::confirmed());

    ensure_initialized(&rpc, &payer, &program_id, &chain_id).await?;

    let ix_disc: [u8; 8] = sha2::Sha256::digest(b"global:respond_bidirectional")[..8]
        .try_into()
        .unwrap();

    let request_id = [0xabu8; 32];
    let signature = ProgSignature {
        big_r: AffinePoint { x: [0x11; 32], y: [0x22; 32] },
        s: [0x33; 32],
        recovery_id: 0,
    };
    let output: Vec<u8> = vec![0xde, 0xad, 0xbe, 0xef];

    let mut data = ix_disc.to_vec();
    data.extend_from_slice(&request_id);
    data.extend_from_slice(&(output.len() as u32).to_le_bytes());
    data.extend_from_slice(&output);
    data.extend_from_slice(&signature.big_r.x);
    data.extend_from_slice(&signature.big_r.y);
    data.extend_from_slice(&signature.s);
    data.push(signature.recovery_id);

    let (event_authority, _) = Pubkey::find_program_address(&[b"__event_authority"], &program_id);

    let ix = Instruction::new_with_bytes(
        program_id,
        &data,
        vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(program_id, false),
        ],
    );

    let blockhash = rpc.get_latest_blockhash().await?;
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);
    let sig: Signature = rpc.send_and_commit_transaction(&tx).await?;
    println!("tx committed: {sig}");

    let confirmed = rpc
        .get_transaction_with_config(
            &sig,
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::JsonParsed),
                commitment: Some(CommitmentConfig::confirmed()),
                max_supported_transaction_version: Some(0),
            },
        )
        .await?;

    let meta = confirmed
        .transaction
        .meta
        .ok_or_else(|| anyhow::anyhow!("no transaction meta"))?;
    let inner_sets = match meta.inner_instructions {
        OptionSerializer::Some(v) => v,
        _ => anyhow::bail!("no inner instructions — program did not emit via emit_cpi!"),
    };

    let mut found = false;
    for set in &inner_sets {
        for inner in &set.instructions {
            let UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(p)) = inner else {
                continue;
            };
            if p.program_id != program_id.to_string() {
                continue;
            }
            let Ok(ix_data) = solana_sdk::bs58::decode(&p.data).into_vec() else {
                continue;
            };
            if !ix_data.starts_with(anchor_lang::event::EVENT_IX_TAG_LE) {
                continue;
            }
            let disc = &ix_data[8..16];
            if disc != RespondBidirectionalEvent::DISCRIMINATOR {
                continue;
            }
            let ev = RespondBidirectionalEvent::deserialize(&mut &ix_data[16..])?;
            println!(
                "RespondBidirectionalEvent via emit_cpi: request_id={} output_len={} responder={}",
                hex(&ev.request_id),
                ev.serialized_output.len(),
                ev.responder
            );
            anyhow::ensure!(ev.request_id == request_id, "request_id mismatch");
            anyhow::ensure!(ev.serialized_output == output, "output mismatch");
            anyhow::ensure!(ev.responder == payer.pubkey(), "responder mismatch");
            found = true;
        }
    }

    anyhow::ensure!(found, "RespondBidirectionalEvent NOT found in inner instructions");
    println!("SMOKE TEST PASSED");
    Ok(())
}

async fn ensure_initialized(
    rpc: &RpcClient,
    payer: &Keypair,
    program_id: &Pubkey,
    chain_id: &str,
) -> anyhow::Result<()> {
    let (state_pda, _) = Pubkey::find_program_address(&[b"program-state"], program_id);
    if rpc.get_account(&state_pda).await.is_ok() {
        println!("program_state already initialized: {state_pda}");
        return Ok(());
    }

    let ix_disc: [u8; 8] = sha2::Sha256::digest(b"global:initialize")[..8]
        .try_into()
        .unwrap();
    let mut data = ix_disc.to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&(chain_id.len() as u32).to_le_bytes());
    data.extend_from_slice(chain_id.as_bytes());

    let ix = Instruction::new_with_bytes(
        *program_id,
        &data,
        vec![
            AccountMeta::new(state_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
    );
    let blockhash = rpc.get_latest_blockhash().await?;
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], blockhash);
    let sig: Signature = rpc.send_and_commit_transaction(&tx).await?;
    println!("initialized program_state {state_pda} (admin=payer, deposit=0, chain_id={chain_id}) tx={sig}");
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn load_keypair(path: &str) -> anyhow::Result<Keypair> {
    let raw = std::fs::read_to_string(path)?;
    let bytes: Vec<u8> = raw
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().parse::<u8>().map_err(|e| anyhow::anyhow!("{e}")))
        .collect()?;
    Ok(Keypair::from_bytes(&bytes)?)
}
