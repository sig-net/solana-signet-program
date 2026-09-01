# Deploying the signet Solana program

Deploys run through the **Deploy Program** workflow (`.github/workflows/deploy.yml`),
triggered manually from GitHub Actions. The target cluster is derived from the branch:

| Branch | Cluster |
|---|---|
| `main` | `testnet` |
| `develop` | `devnet` |

Dispatching from any other branch fails. Builds happen inside the pinned
`signet-anchor-build-env` container.

## What a deploy does

One idempotent operation, no modes to choose:

1. Build with `declare_id!` patched to the target cluster's program id.
2. Guard: ELF must fit the capacity budget; if the program already exists
   on-chain, the deployer key must be its authority.
3. Close the existing program (rent refunded, ~seconds of downtime) and
   re-deploy at the **same id** with 512 KB capacity.
4. Verify: `solana program show` + a smoke test that initializes
   `program-state` if absent (admin = deployer, deposit 0) and sends a real
   `respond_bidirectional` transaction, asserting the event lands in the
   transaction's **inner instructions** (`emit_cpi!`).
5. Upload the exact `.so` + IDL as workflow artifacts.

Redeploying at the same program id means all PDAs (e.g. `program-state`) keep
their data; the close is only the BPF loader program-data account.

## Repo settings

**Environments** (Settings → Environments):

| Name | Protection | Purpose |
|---|---|---|
| `sol-testnet` | required reviewers | testnet deploys (from `main`) need a human click |
| `sol-devnet` | none | devnet deploys (from `develop`) run freely |

**Secrets** (Settings → Secrets and variables → Actions) — each is the JSON
keypair file contents:

| Secret | Content |
|---|---|
| `SOL_DEPLOYER_KEY` | upgrade authority + fee payer |
| `SOL_PROGRAM_KEY_TESTNET` | keypair deriving `SigTVbfRK9LsXWpSv9KgpabrQcFKr5hDdUwMhYsXyKg` |
| `SOL_PROGRAM_KEY_DEVNET` | keypair deriving `SigDuEPNeDjh3oJv7MUraPN7zaTFomS6ZWfpXwjUg4B` |

The workflow hard-fails if a program keypair secret doesn't derive the expected
id, so cluster/secret mixups cannot ship.
