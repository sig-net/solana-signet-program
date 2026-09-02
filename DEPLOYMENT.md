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
   on-chain, the deployer key must be its upgrade authority.
3. Deploy as an in-place **upgrade** at the same program id (`solana program
   deploy` reuses the existing program data account; capacity 512 KB reserved
   on first deploy, extendable later with `solana program extend`).
4. Verify: `solana program show` + a smoke test that initializes
   `program-state` if absent (admin = deployer, deposit 0) and sends a real
   `respond_bidirectional` transaction, asserting the event lands in the
   transaction's **inner instructions** (`emit_cpi!`).
5. Upload the exact `.so` + IDL as workflow artifacts.

Redeploying at the same program id keeps all PDAs (e.g. `program-state`) and
their data.

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
| `SOL_PROGRAM_KEY_DEVNET` | keypair deriving `SigDHT99hPznk4d9SAxWLoBnKWT8jcob5pV8X7ti8SM` |

The workflow hard-fails if a program keypair secret doesn't derive the expected
id, so cluster/secret mixups cannot ship.
