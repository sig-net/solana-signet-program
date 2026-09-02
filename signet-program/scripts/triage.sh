#!/usr/bin/env bash
# Post-failure triage: dump on-chain state relevant to a failed deploy.
# Usage: triage.sh <testnet|devnet>
set -euo pipefail

CLUSTER=${1:?usage: triage.sh <testnet|devnet>}
case "$CLUSTER" in
  testnet) RPC_URL=https://api.testnet.solana.com
           PROGRAM_ID=SigTVbfRK9LsXWpSv9KgpabrQcFKr5hDdUwMhYsXyKg ;;
  devnet)  RPC_URL=https://api.devnet.solana.com
           PROGRAM_ID=SigDHT99hPznk4d9SAxWLoBnKWT8jcob5pV8X7ti8SM ;;
  *) echo "unknown cluster: $CLUSTER" >&2; exit 1 ;;
esac

echo "== program =="
solana program show "$PROGRAM_ID" --url "$RPC_URL" || true
echo "== balance =="
solana balance --url "$RPC_URL" || true
echo "== buffers =="
solana program show --buffers --url "$RPC_URL" || true
