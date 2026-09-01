#!/usr/bin/env bash
# Deploy the signet Solana program to a public cluster.
# Usage: deploy.sh <testnet|devnet>
# Env overrides: DEPLOYER_KEYPAIR, PROGRAM_KEYPAIR, MAX_LEN
set -euo pipefail

CLUSTER=${1:?usage: deploy.sh <testnet|devnet>}
case "$CLUSTER" in
  testnet) RPC_URL=https://api.testnet.solana.com
           PROGRAM_ID=SigTVbfRK9LsXWpSv9KgpabrQcFKr5hDdUwMhYsXyKg ;;
  devnet)  RPC_URL=https://api.devnet.solana.com
           PROGRAM_ID=SigDuEPNeDjh3oJv7MUraPN7zaTFomS6ZWfpXwjUg4B ;;
  *) echo "unknown cluster: $CLUSTER" >&2; exit 1 ;;
esac

DEPLOYER_KEYPAIR=${DEPLOYER_KEYPAIR:-$HOME/deployer.json}
PROGRAM_KEYPAIR=${PROGRAM_KEYPAIR:-$HOME/program-key.json}
MAX_LEN=${MAX_LEN:-524288}
CHAIN_ID="solana:$CLUSTER"
SO=target/deploy/chain_signatures.so

cd "$(dirname "$0")/../.."
step() { printf '\n==> %s\n' "$*"; }

step "verify program keypair"
KEY_PUBKEY=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
if [ "$KEY_PUBKEY" != "$PROGRAM_ID" ]; then
  echo "program keypair derives $KEY_PUBKEY, expected $PROGRAM_ID" >&2
  exit 1
fi
solana config set --url "$RPC_URL" --keypair "$DEPLOYER_KEYPAIR" >/dev/null

step "point declare_id at $CLUSTER"
sed -i "s|declare_id!(\"[^\"]*\")|declare_id!(\"$PROGRAM_ID\")|" programs/signet/src/lib.rs
grep -q "declare_id!(\"$PROGRAM_ID\")" programs/signet/src/lib.rs
mkdir -p target/deploy
cp "$PROGRAM_KEYPAIR" target/deploy/chain_signatures-keypair.json

step "build"
anchor build
SO_SIZE=$(stat -c%s "$SO")
echo "so size: $SO_SIZE bytes"
if [ "$SO_SIZE" -gt $((MAX_LEN - 45)) ]; then
  echo "program too big for max-len $MAX_LEN ($SO_SIZE > $((MAX_LEN - 45)))" >&2
  exit 1
fi

step "guards"
if solana program show "$PROGRAM_ID" >/dev/null 2>&1; then
  ONCHAIN_AUTH=$(solana program show "$PROGRAM_ID" | grep '^Authority:' | awk '{print $NF}')
  DEPLOYER_PUBKEY=$(solana address -k "$DEPLOYER_KEYPAIR")
  echo "existing program authority: $ONCHAIN_AUTH"
  if [ "$ONCHAIN_AUTH" != "$DEPLOYER_PUBKEY" ]; then
    echo "deployer ($DEPLOYER_PUBKEY) cannot replace a program owned by $ONCHAIN_AUTH" >&2
    exit 1
  fi
fi

step "close existing program"
if solana program show "$PROGRAM_ID" >/dev/null 2>&1; then
  solana program close "$PROGRAM_ID" --bypass-warning
else
  echo "fresh deploy — nothing to close"
fi

step "fund deployer"
NEED=$(( $(solana rent "$MAX_LEN" | grep -oE '[0-9]+\.[0-9]+' | tr -d '.') * 2 + 10000000 ))
echo "target balance: $NEED lamports"
for _ in $(seq 1 8); do
  BALANCE=$(solana balance | grep -oE '[0-9]+(\.[0-9]+)?' | tr -d '.')
  if [ "${BALANCE:-0}" -ge "$NEED" ]; then
    echo "funded: $BALANCE lamports"; break
  fi
  solana airdrop 2 || true
  sleep 20
done
if [ "${BALANCE:-0}" -lt "$NEED" ]; then
  echo "could not fund deployer to $NEED lamports" >&2
  exit 1
fi

step "deploy (capacity $MAX_LEN)"
ok=0
for attempt in 1 2 3; do
  if solana program deploy "$SO" \
       --program-id "$PROGRAM_KEYPAIR" \
       --upgrade-authority "$DEPLOYER_KEYPAIR" \
       --max-len "$MAX_LEN"; then
    ok=1; break
  fi
  echo "deploy attempt $attempt failed — reclaiming stray buffers, retrying in 20s"
  solana program close --buffers --bypass-warning >/dev/null 2>&1 || true
  sleep 20
done
solana program close --buffers --bypass-warning >/dev/null 2>&1 || true
[ "$ok" = 1 ] || { echo "deploy failed after 3 attempts" >&2; exit 1; }

step "verify"
sleep 5
solana program show "$PROGRAM_ID"
cargo run --release --manifest-path scripts/smoke_respond_bidirectional/Cargo.toml -- \
  "$RPC_URL" "$DEPLOYER_KEYPAIR" "$PROGRAM_ID" "$CHAIN_ID"

step "done"
