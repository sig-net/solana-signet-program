# Deploying the signet Solana program

Deploys run through the **Deploy Program** workflow (`.github/workflows/deploy.yml`),
triggered manually from GitHub Actions. The target environment is derived from the branch:

| Branch | Environment | Solana cluster | Program id |
|---|---|---|---|
| `main` | `testnet` | devnet | `SigTVbfRK9LsXWpSv9KgpabrQcFKr5hDdUwMhYsXyKg` |
| `develop` | `devnet` | devnet | `SigDHT99hPznk4d9SAxWLoBnKWT8jcob5pV8X7ti8SM` |

`testnet` and `devnet` are sig.net environment names. Both programs live on
Solana **devnet** (`https://api.devnet.solana.com`); nothing is deployed to the
Solana testnet cluster. Both share the same upgrade authority
(`2gTzQy83dPqx4wq4TfJCDuJxM8evbF49MYbGwh2K5G4c`), so one `SOL_DEPLOYER_KEY`
serves both targets.

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
   `program-state` if absent (admin = deployer, deposit 1 lamport, canonical
   chain id `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), **asserts the
   on-chain `chain_id` and deposit match on every deploy** (hard-fails with
   the exact `admin` remediation command otherwise), and sends a real
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

| Secret | Scope | Content |
|---|---|---|
| `SOL_DEPLOYER_KEY` | repository | funded devnet upgrade authority + fee payer (`2gTzQy83dPqx4wq4TfJCDuJxM8evbF49MYbGwh2K5G4c`), shared by both targets |
| `SOL_PROGRAM_KEY_TESTNET` | `sol-testnet` environment | keypair deriving `SigTVbfRK9LsXWpSv9KgpabrQcFKr5hDdUwMhYsXyKg` |
| `SOL_PROGRAM_KEY_DEVNET` | `sol-devnet` environment | keypair deriving `SigDHT99hPznk4d9SAxWLoBnKWT8jcob5pV8X7ti8SM` |

The workflow hard-fails if a program or deployer keypair secret doesn't derive
the expected pubkey, so cluster/secret mixups cannot ship.

## Admin maintenance

`chain_id` was historically immutable (set only by `initialize`, which cannot
rerun). The program now has an admin-only `update_chain_id` instruction; the
`admin` binary in `scripts/smoke_respond_bidirectional` drives it:

```sh
cargo run --release --manifest-path scripts/smoke_respond_bidirectional/Cargo.toml \
  --bin admin -- <rpc_url> <deployer_keypair> <program_id> \
  update-chain-id solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
```

Also supports `update-deposit <lamports>`.
