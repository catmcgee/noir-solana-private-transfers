# Step 4: The ZK Circuit

## Goal

Understand the full withdrawal circuit and generate the proving/verification keys with Sunspot.

## Where We Are

```
✅ Step 0: Understand the architecture
✅ Step 1: Hide deposit details
✅ Step 2: Prove membership
✅ Step 3: Prevent double-spending
🔲 Step 4: The ZK circuit           ← You are here
🔲 Step 5: On-chain verification
```

---

## The Flow

Here's how the ZK circuit fits into withdrawal:

```
WITHDRAWAL FLOW:
1. User pastes deposit note
2. Backend writes inputs to Prover.toml
3. Backend runs `nargo execute` - generates witness      <-- Circuit runs here
4. Backend runs `sunspot prove` - generates 256-byte proof
5. Frontend sends transaction with proof
6. On-chain verifier checks the proof                    <-- Step 5
```

The circuit runs **off-chain during proof generation**. It takes ~30 seconds. The output is a 256-byte proof that anyone can verify quickly.

---

## The Withdrawal Circuit

Open `circuits/withdrawal/src/main.nr`. This is the full circuit that proves everything.

```noir
use dep::poseidon;
use crate::merkle_tree::compute_merkle_root;

global TREE_DEPTH: u32 = 10;

fn main(
    // PUBLIC - visible onchain, verified by smart contract
    root: pub Field,
    nullifier_hash: pub Field,
    recipient: pub Field,
    amount: pub Field,

    // PRIVATE - never revealed to anyone
    nullifier: Field,
    secret: Field,
    merkle_proof: [Field; TREE_DEPTH],
    is_even: [bool; TREE_DEPTH]
) {
    // 1. Compute commitment from private inputs
    let commitment = poseidon::poseidon2::Poseidon2::hash([nullifier, secret, amount], 3);

    // 2. Verify nullifier_hash matches
    let computed_hash = poseidon::poseidon2::Poseidon2::hash([nullifier], 1);
    assert(computed_hash == nullifier_hash);

    // 3. Verify commitment is in the Merkle tree
    let computed_root = compute_merkle_root(commitment, merkle_proof, is_even);
    assert(computed_root == root);
}
```

**What each section does:**

**Imports:**
- `use dep::poseidon` - The Poseidon hash library from `noir-lang/poseidon` (compatible with `@zkpassport/poseidon2` in JavaScript)
- `use crate::merkle_tree::compute_merkle_root` - Our Merkle tree verification function

**Public inputs** (`pub` keyword):
- `root` - The Merkle root we're proving against (verified by program in Step 3)
- `nullifier_hash` - Prevents double-spend (checked by program in Step 2)
- `recipient` - Who gets the funds (prevents front-running)
- `amount` - How much to withdraw

**Private inputs** (no `pub`):
- `nullifier` - Your secret from the deposit note
- `secret` - Another secret from the deposit note
- `merkle_proof` - Sibling hashes (backend computes from tree + your leaf_index)
- `is_even` - Path directions (backend computes from your leaf_index)

**The assertions:**
1. Compute commitment from secrets - proves you know the deposit secrets (same Poseidon2 hash the backend used)
2. Check nullifier_hash matches - links the nullifier to this proof
3. Check Merkle root matches - proves commitment is in the tree

If all assertions pass, the proof is valid. The verifier is convinced you have a valid deposit, but learns nothing about which one.

---

## The Merkle Tree Circuit

The main circuit calls `compute_merkle_root`. Open `circuits/withdrawal/src/merkle_tree.nr`:

```noir
use dep::poseidon;

pub fn compute_merkle_root<let DEPTH: u32>(
    leaf: Field,
    path: [Field; DEPTH],
    is_even: [bool; DEPTH]
) -> Field {
    let mut current = leaf;
    for i in 0..DEPTH {
        let sibling = path[i];
        let (left, right) = if is_even[i] {
            (current, sibling)
        } else {
            (sibling, current)
        };
        current = poseidon::poseidon2::Poseidon2::hash([left, right], 2);
    }
    current
}
```

**What each part does:**

- `leaf: Field` - The commitment we're proving exists
- `path: [Field; DEPTH]` - The sibling hashes at each level (backend computes from tree)
- `is_even: [bool; DEPTH]` - Whether we're on the left (true) or right (false) at each level
- The loop hashes pairs together, walking up the tree level by level
- Returns the computed root - if it matches the stored root, the commitment is in the tree

The backend computes `path` and `is_even` using the user's `leaf_index` from their deposit note.

---

## Install Nargo

Nargo is the Noir compiler and package manager.

```bash
# Install noirup (Noir version manager)
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash

# Install the specific version compatible with Sunspot
noirup -v 1.0.0-beta.13

# Verify installation
nargo --version
```

**Why this version?** Sunspot requires a specific Noir version. Using a different version may cause proof generation to fail.

---

## Install Sunspot

Sunspot converts Noir circuits to Groth16 proofs that can be verified on Solana.

Sunspot requires **Go 1.24+**:

```bash
go version  # Should show 1.24 or higher
```

If you need Go, visit [go.dev/dl](https://go.dev/dl/).

Now install Sunspot:

```bash
# Clone and build
git clone https://github.com/reilabs/sunspot.git
cd sunspot/go
go build -o sunspot .

# Add to PATH (choose one)
sudo mv sunspot /usr/local/bin/          # System-wide
# OR
mkdir -p ~/bin && mv sunspot ~/bin/      # User directory (add ~/bin to PATH)

# Verify
sunspot --help
```

---

## Compile the Circuit

```bash
cd circuits/withdrawal
nargo compile
```

This produces `target/withdrawal.json` - the compiled circuit in ACIR format.

---

## Generate Sunspot Keys

Now convert the circuit to Groth16 format and generate keys:

```bash
cd circuits/withdrawal

# Convert Noir ACIR to CCS format (Groth16 compatible)
sunspot compile target/withdrawal.json

# Generate proving key (~2MB) and verification key (~1KB)
sunspot setup target/withdrawal.ccs
```

**What you get:**

| File | Size | Purpose |
|------|------|---------|
| `withdrawal.ccs` | ~100KB | Circuit in CCS format |
| `withdrawal.pk` | ~2MB | Used by backend to generate proofs |
| `withdrawal.vk` | ~1KB | Baked into the on-chain verifier program |

---

## Test the Circuit

```bash
nargo test
```

---

## What We Built

- The withdrawal circuit that proves deposit ownership without revealing which deposit
- Proving key for generating proofs (backend uses this)
- Verification key for the on-chain verifier (next step)

---

## Next Step

Now we need to deploy the verifier program to Solana and add CPI to call it.

Continue to [Step 5: On-chain Verification](./step-5-onchain-verification.md).
