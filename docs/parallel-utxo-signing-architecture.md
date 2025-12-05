# Parallel UTXO Signing Architecture

> **Status:** Proposal
> **Last Updated:** 2024

---

## Problem

Solana transactions are limited to ~1232 bytes. Bitcoin transaction data scales linearly with inputs (~66 bytes each). Current architecture sends full PSBT through Solana → limited to ~3-5 inputs.

**Goal:** Enable unlimited UTXO inputs for vault consolidation and large withdrawals.

---

## Solution

Leverage BIP143's sighash structure to sign each input independently in separate Solana transactions, all committing to the same Bitcoin transaction.

**Key Insight:** BIP143 uses precomputed hashes (`hashPrevouts`, `hashSequence`, `hashOutputs`) that are constant across all inputs. Pass these 32-byte commitments instead of full transaction data.

---

## BIP143 Sighash Preimage Structure

For each input, the sighash preimage is:

```
┌────┬────────────────┬──────────┬─────────────────────────────────┐
│ #  │ Field          │ Size     │ Scope                           │
├────┼────────────────┼──────────┼─────────────────────────────────┤
│ 1  │ nVersion       │ 4 bytes  │ Constant (tx-wide)              │
│ 2  │ hashPrevouts   │ 32 bytes │ Constant (all inputs)           │
│ 3  │ hashSequence   │ 32 bytes │ Constant (all inputs)           │
│ 4  │ outpoint       │ 36 bytes │ UNIQUE (this input's txid:vout) │
│ 5  │ scriptCode     │ ~25 bytes│ UNIQUE (this input's script)    │
│ 6  │ amount         │ 8 bytes  │ UNIQUE (this input's value)     │
│ 7  │ nSequence      │ 4 bytes  │ UNIQUE (this input's sequence)  │
│ 8  │ hashOutputs    │ 32 bytes │ Constant (all outputs)          │
│ 9  │ nLockTime      │ 4 bytes  │ Constant (tx-wide)              │
│ 10 │ nHashType      │ 4 bytes  │ Constant (SIGHASH_ALL)          │
└────┴────────────────┴──────────┴─────────────────────────────────┘

sighash = SHA256(SHA256(preimage))
```

### How Shared Hashes Are Computed

```
hashPrevouts = SHA256(SHA256(outpoint[0] || outpoint[1] || ... || outpoint[N]))
               where outpoint = txid (32 bytes) || vout (4 bytes)

hashSequence = SHA256(SHA256(sequence[0] || sequence[1] || ... || sequence[N]))

hashOutputs  = SHA256(SHA256(output[0] || output[1] || ...))
               where output = value (8 bytes LE) || scriptPubKey_len || scriptPubKey
```

### Why Parallel Signing Works

Once `hashPrevouts` and `hashOutputs` are fixed:

- Each signature **commits to the entire transaction** via these hashes
- Each signature **can be computed independently** (only needs its own outpoint + amount)
- Signatures **cannot be mixed** across different transactions (different hashes = different sighash)

---

## Security Model

### Trust Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  DEX CONTRACT (Solana) - TRUSTLESS                              │
│                                                                 │
│  All verification happens here:                                 │
│  • Verify sha256d(outputs) == hashOutputs                       │
│  • Verify outputs are valid (vault change address)              │
│  • Verify user balance and permissions                          │
│  • Only then CPI to MPC                                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │ CPI (only if verification passes)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  MPC SIGNER - Dumb Signer                                       │
│                                                                 │
│  • NO verification logic                                        │
│  • Signs whatever DEX contract approves                         │
└─────────────────────────────────────────────────────────────────┘
```

### The Critical Security Check

User provides both `hashOutputs` (32 bytes) AND actual `outputs` (~62 bytes).

```
DEX Contract verification:

1. computed = sha256d(serialize(outputs))
2. require!(computed == hashOutputs)     ← Cannot lie about hash
3. require!(outputs[1].script == VAULT)  ← Cannot steal funds
4. cpi_to_mpc(sighash_components)        ← Only signs if verified
```

**Result:** Signature commits to `hashOutputs` → `hashOutputs` verified to match real outputs → real outputs verified to be valid → signature can only be used for valid transaction.

### Attack Prevention

| Attack                | Prevention                                              | Layer        |
| --------------------- | ------------------------------------------------------- | ------------ |
| Malicious hashOutputs | Recomputed from actual outputs                          | DEX Contract |
| Malicious outputs     | Validated against vault script                          | DEX Contract |
| Signature mixing      | Each sig commits to specific hashPrevouts + hashOutputs | Bitcoin      |

---

## Data Per Signing Call

```
Shared commitment hashes:           96 bytes
├── hashPrevouts:                   32 bytes
├── hashSequence:                   32 bytes
└── hashOutputs:                    32 bytes

Actual outputs (for verification):  62 bytes (2 outputs)
├── Output 0: value + script        31 bytes
└── Output 1: value + script        31 bytes

This input's unique data:           73 bytes
├── outpoint_txid:                  32 bytes
├── outpoint_vout:                  4 bytes
├── amount:                         8 bytes
├── scriptCode:                     25 bytes
└── sequence:                       4 bytes

Transaction params:                 16 bytes
├── version, locktime, sighash_type

─────────────────────────────────────────────
TOTAL: ~247 bytes per signing call (CONSTANT)
```

---

## Constraints

### Inputs: UNLIMITED

Each input signed in separate Solana TX. No limit.

### Outputs: ~8-12 maximum

Outputs must be passed for hash verification. Limited by remaining Solana TX space.

| Output Type   | Size     | Max Count |
| ------------- | -------- | --------- |
| P2WPKH (bc1q) | 31 bytes | ~12       |
| P2TR (bc1p)   | 43 bytes | ~9        |

**Recommended: 2 outputs** (recipient + vault change) = 62 bytes. Covers 99% of use cases.

---

## MPC Observation & Confirmation

After signing, MPC observes Bitcoin and confirms each UTXO spend individually.

### What MPC Tracks (Per UTXO)

MPC is stateless per signing request. For each UTXO it signs, it stores:

```
SignedUtxo {
    outpoint:       OutPoint    // txid:vout that was signed
    hash_outputs:   [u8; 32]    // Expected outputs commitment
    request_id:     [u8; 32]    // Links back to DEX request
}
```

### Bitcoin Observation Flow

```
MPC observes Bitcoin mempool/blocks
         │
         ▼
┌─────────────────────────────────────┐
│ For each signed UTXO:               │
│                                     │
│ 1. Query: "Was this outpoint spent?"│
│                                     │
│ 2. If spent, get spending txid      │
│                                     │
│ 3. Fetch spending tx, extract:      │
│    • Actual outputs                 │
│                                     │
│ 4. Sign confirmation:               │
│    sign(outpoint, spending_txid,    │
│         outputs)                    │
│                                     │
│ 5. Callback to DEX contract         │
└─────────────────────────────────────┘
```

### Bitcoin RPC Methods

**1. Check if UTXO is spent: `gettxout`**

```
Request:
  bitcoin-cli gettxout <txid> <vout> [include_mempool=true]

Response if UNSPENT:
  {
    "bestblock": "00000000...",
    "confirmations": 6,
    "value": 0.5,
    "scriptPubKey": { ... }
  }

Response if SPENT:
  null    ← UTXO no longer exists in UTXO set
```

**2. Find spending transaction: `gettxspendingprevout`** (Bitcoin Core 24+)

```
Request:
  bitcoin-cli gettxspendingprevout '[{"txid":"<txid>","vout":<n>}]'

Response:
  [
    {
      "txid": "<prev_txid>",
      "vout": <prev_vout>,
      "spendingtxid": "<spending_txid>"    ← The tx that spent it
    }
  ]
```

**Alternative: Index-based lookup or mempool scan if RPC not available**

**3. Get spending transaction details: `getrawtransaction`**

```
Request:
  bitcoin-cli getrawtransaction <spending_txid> true

Response:
  {
    "txid": "<spending_txid>",
    "vin": [ ... ],          // Inputs (includes our outpoint)
    "vout": [                // Outputs - what we need to verify
      {
        "value": 0.8,
        "scriptPubKey": {
          "hex": "0014..."
        }
      },
      ...
    ]
  }
```

### MPC Observation Implementation

MPC is a **dumb observer** - it just reports what happened. DEX does all verification.

```
For each SignedUtxo in pending_utxos:

    // Step 1: Check if spent
    result = bitcoin_rpc.gettxout(utxo.txid, utxo.vout)

    if result != null:
        continue  // Still unspent, check again later

    // Step 2: Find what spent it
    spending_info = bitcoin_rpc.gettxspendingprevout(utxo.txid, utxo.vout)
    spending_txid = spending_info.spendingtxid

    // Step 3: Get the spending transaction
    spending_tx = bitcoin_rpc.getrawtransaction(spending_txid, true)

    // Step 4: Extract outputs (NO verification - just report)
    actual_outputs = spending_tx.vout

    confirmation = {
        outpoint: utxo.outpoint,
        spending_txid: spending_txid,
        outputs: actual_outputs    // DEX will verify these
    }

    // Step 5: Sign and callback to DEX
    signature = sign(confirmation)
    call_dex_callback(confirmation, signature)
```

**DEX contract verifies outputs match expected `hash_outputs` - not MPC.**

### Linking Sign → Confirm: The Outpoint

The `outpoint` (txid:vout) **is unique per UTXO** - it's the natural key for linking:

```
OutPoint {
    txid: [u8; 32],   // Previous transaction hash
    vout: u32,        // Output index in that transaction
}

// This pair uniquely identifies any UTXO on Bitcoin
```

### What MPC Signs (Confirmation)

MPC signs three pieces of data that DEX needs:

```
MPC signs: (outpoint, spending_txid, outputs)

┌─────────────────────────────────────────────────────────────────┐
│  outpoint:       OutPoint       // Links to pending request     │
│  spending_txid:  [u8; 32]       // Bitcoin tx that spent it     │
│  outputs:        Vec<Output>    // Actual outputs on Bitcoin    │
└─────────────────────────────────────────────────────────────────┘

signature = ECDSA_sign(MPC_key, keccak256(outpoint || spending_txid || outputs))
```

**DEX uses this to:**

1. **outpoint** → Look up `PendingUtxos[outpoint]` to find stored `hash_outputs`
2. **outputs** → Verify `sha256d(outputs) == stored_hash_outputs`
3. **spending_txid** → Deduplicate (all UTXOs in same tx have same spending_txid)

### DEX Contract: Pending UTXOs Map

DEX maintains a map of pending UTXOs, keyed by outpoint:

```
PendingUtxos: Map<(txid, vout), PendingRequest>

┌─────────────────────────────────────────────────────────────┐
│  (txid_a, 0) → { user: Alice, hash_outputs: 0xabc..., ... } │
│  (txid_a, 1) → { user: Alice, hash_outputs: 0xabc..., ... } │
│  (txid_b, 2) → { user: Alice, hash_outputs: 0xabc..., ... } │
└─────────────────────────────────────────────────────────────┘
          ↑                            ↑
     unique key                  same hash_outputs
   (identifies UTXO)           (same BTC transaction)
```

### Data Flow: Sign → Store → Observe → Callback

```
SIGNING PHASE (per input):
User calls sign_input with:
├── outpoint (txid:vout)      ← UNIQUE KEY
├── hash_outputs
└── (other sighash components)

DEX stores pending request keyed by outpoint:
  PendingUtxos[(txid, vout)] = { user, amount, hash_outputs, ... }

MPC stores signed UTXO:
  SignedUtxo[(txid, vout)] = { hash_outputs }

MPC signs sighash, returns signature to user


CONFIRMATION PHASE (MPC calls back into DEX):
MPC observes: outpoint (txid, vout) was spent in Bitcoin tx
MPC looks up: SignedUtxo[(txid, vout)] → hash_outputs
MPC calls DEX with confirmation for this outpoint

DEX receives callback:
DEX looks up: PendingUtxos[(txid, vout)]
DEX verifies MPC signature
DEX checks: spending_txid already processed? (dedup)
DEX finalizes state, removes PendingUtxos[(txid, vout)]
```

### Resolution Flow (3 inputs example)

```
1. User signs 3 inputs:
   sign_input(outpoint_0, ...) → DEX stores PendingUtxos[(txid_a, 0)]
   sign_input(outpoint_1, ...) → DEX stores PendingUtxos[(txid_a, 1)]
   sign_input(outpoint_2, ...) → DEX stores PendingUtxos[(txid_b, 2)]

2. User assembles signatures, broadcasts Bitcoin TX

3. MPC observes Bitcoin, sees UTXOs spent one by one:

   UTXO (txid_a, 0) spent → MPC calls DEX with confirmation
                          → DEX resolves PendingUtxos[(txid_a, 0)]
                          → First for this spending_txid: process it

   UTXO (txid_a, 1) spent → MPC calls DEX with confirmation
                          → DEX resolves PendingUtxos[(txid_a, 1)]
                          → Same spending_txid: dedup, ignore

   UTXO (txid_b, 2) spent → MPC calls DEX with confirmation
                          → DEX resolves PendingUtxos[(txid_b, 2)]
                          → Same spending_txid: dedup, ignore

4. Result: All 3 pending entries resolved, state finalized once
```

### Why Outpoint Is Sufficient

| Property              | Outpoint                |
| --------------------- | ----------------------- |
| Unique per UTXO       | ✓ By definition         |
| Known at signing      | ✓ User provides it      |
| Known at confirmation | ✓ MPC observes it spent |
| Immutable             | ✓ Set when UTXO created |
| Small                 | ✓ 36 bytes              |

The `hash_outputs` is stored alongside to verify the spending transaction matches what was signed - but the **link** is purely the outpoint.

### DEX Contract: Deduplication

Since multiple UTXOs may belong to the same Bitcoin transaction, DEX receives multiple confirmations with the same `spending_txid`. DEX must deduplicate:

```
On receiving confirmation:

1. Verify MPC signature
2. Check: Have we already processed this spending_txid?
   • If YES: Ignore (already settled)
   • If NO: Process and mark txid as seen
3. Update state based on FIRST confirmation only
```

**Dedup storage (per user/session):**

```
ProcessedBtcTx {
    spending_txid:  [u8; 32]    // Bitcoin txid
    processed_at:   Timestamp
    // All UTXOs from same BTC tx share this txid
}
```

### Why Per-UTXO (Not Per-Session)

| Aspect              | Per-Session        | Per-UTXO (Chosen)      |
| ------------------- | ------------------ | ---------------------- |
| MPC complexity      | Tracks sessions    | Stateless, simpler     |
| Confirmation timing | Wait for all UTXOs | First UTXO confirms tx |
| Failure handling    | All or nothing     | Graceful per-UTXO      |
| DEX complexity      | Simple             | Must deduplicate       |

---

## Implementation Flow

### Full Withdrawal Flow (Vault → User)

```
User                    DEX Contract                MPC              Bitcoin
  │                          │                       │                  │
  │ Build TX, compute hashes │                       │                  │
  │                          │                       │                  │
  ├──sign_input(0, outputs)─►│                       │                  │
  │                          │ Verify hashOutputs    │                  │
  │                          │ Verify vault change   │                  │
  │                          ├───CPI────────────────►│                  │
  │                          │                       │ Store UTXO_0     │
  │                          │◄──────sig_0───────────┤                  │
  │◄────────sig_0────────────┤                       │                  │
  │                          │                       │                  │
  ├──sign_input(1, outputs)─►│ (same verification)   │                  │
  │                          ├───CPI────────────────►│ Store UTXO_1     │
  │◄────────sig_1────────────┤◄──────sig_1───────────┤                  │
  │                          │                       │                  │
  │ (parallel for N inputs - each UTXO stored independently)           │
  │                          │                       │                  │
  │ Assemble TX, broadcast───┼───────────────────────┼─────────────────►│
  │                          │                       │                  │
  │                          │                       │◄─UTXO_0 spent────┤
  │                          │◄──confirm(UTXO_0)─────┤                  │
  │                          │                       │◄─UTXO_1 spent────┤
  │                          │◄──confirm(UTXO_1)─────┤ (same txid)      │
  │                          │                       │                  │
  ├──complete(confirm_0)────►│                       │                  │
  │                          │ Verify signature      │                  │
  │                          │ Check: txid seen? NO  │                  │
  │                          │ Mark txid as seen     │                  │
  │                          │ Finalize withdrawal   │                  │
  │◄────────done─────────────┤                       │                  │
  │                          │                       │                  │
  │  (confirm_1 arrives but same txid = ignored/deduped)               │
```

### Full Deposit Flow (User → Vault)

```
User                    DEX Contract                MPC              Bitcoin
  │                          │                       │                  │
  │ Build TX (→ vault)       │                       │                  │
  │                          │                       │                  │
  ├──sign_input(0, outputs)─►│                       │                  │
  │                          │ Verify hashOutputs    │                  │
  │                          │ Verify vault in outputs                  │
  │                          ├───CPI────────────────►│ Store UTXO_0     │
  │◄────────sig_0────────────┤◄──────sig_0───────────┤                  │
  │                          │                       │                  │
  │ (parallel for N user UTXOs)                      │                  │
  │                          │                       │                  │
  │ Assemble TX, broadcast───┼───────────────────────┼─────────────────►│
  │                          │                       │                  │
  │                          │                       │◄─UTXO_0 spent────┤
  │                          │◄──confirm(UTXO_0)─────┤                  │
  │                          │   (includes outputs:  │                  │
  │                          │    vault received X)  │                  │
  │                          │                       │                  │
  ├──claim(confirm_0)───────►│                       │                  │
  │                          │ Verify signature      │                  │
  │                          │ Check: txid seen? NO  │                  │
  │                          │ Extract vault amount  │                  │
  │                          │ Credit user balance   │                  │
  │◄────────credited─────────┤                       │                  │
```
