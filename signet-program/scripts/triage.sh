#!/usr/bin/env bash
# Post-failure triage: dump on-chain state relevant to a failed deploy.
# Usage: triage.sh <testnet|devnet>
set -euo pipefail

CLUSTER=${1:?usage: triage.sh <testnet|devnet>}
case "$CLUSTER" in
  testnet) RPC_URL=https://api.testnet.solana.com
           PROGRAM_ID=SigTVbfRK9LsXWpSv9KgpabrQcFKr5hDdUwMhYsXyKg ;;
  devnet)  RPC_URL=https://api.devnet.solana.com
           PROGRAM_ID=SigDuEPNeDjh3oJv7MUraPN7zaTFomS6ZWfpXwjUg4B ;;
  *) echo "unknown cluster: $CLUSTER" >&2; exit 1 ;;
esac

echo "== program =="
solana program show "$PROGRAM_ID" --url "$RPC_URL" || true
echo "== balance =="
solana balance --url "$RPC_URL" || true
echo "== buffers =="
solana program show --buffers --url "$RPC_URL" || true
