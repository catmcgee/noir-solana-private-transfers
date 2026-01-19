# Step 4: The ZK Circuit

## Goal

Understand the full withdrawal circuit and generate the proving/verification keys with Sunspot.

---

## The Concept

So far we've built mechanisms to:
- Hide deposits with commitments (Step 1)
- Prove membership with Merkle trees (Step 2)
- Prevent double-spend with nullifiers (Step 3)

But how do we prove all these things are true **without revealing our secrets**? That's where Zero-Knowledge proofs come in.

A ZK proof lets you prove a statement like "I know secrets that satisfy these constraints" without revealing those secrets. Our circuit proves:

1. **"I know the secrets that created a valid commitment"** - Proves you made a real deposit
2. **"That commitment exists in the Merkle tree"** - Proves the deposit wasn't fabricated
3. **"This nullifier_hash came from my nullifier"** - Links proof to double-spend prevention
4. **"This proof is for this specific recipient"** - Prevents front-running attacks

The output is a 256-byte proof that anyone can verify quickly (~1.4M compute units on Solana).

---

## The Proof Generation Flow

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

**ZK concept - Witness vs Proof:**
- **Witness**: All the values (public + private) that satisfy the circuit constraints
- **Proof**: A cryptographic "compressed" version of the witness that can be verified without knowing private values

---

## The Withdrawal Circuit

**File:** `circuits/withdrawal/src/main.nr`

This is the full circuit that proves everything. Open it and let's walk through:

```noir
mod merkle_tree;                           // Import our local Merkle tree module

use dep::poseidon2;                        // Poseidon2 hash library (ZK-friendly hash function)
use merkle_tree::compute_merkle_root;      // Function to compute Merkle root from proof

// Merkle tree depth - supports 2^10 = 1024 deposits
// Must match TREE_DEPTH constant in the Solana program
global TREE_DEPTH: u32 = 10;

/// Private Transfer Circuit
///
/// Proves knowledge of (nullifier, secret, amount) such that:
/// 1. commitment = Poseidon(nullifier, secret, amount) exists in the Merkle tree
/// 2. nullifier_hash = Poseidon(nullifier) matches the public input
/// 3. The proof is bound to a specific recipient (public input)
fn main(
    // ========== PUBLIC INPUTS ==========
    // These are visible on-chain and verified by the smart contract
    // Public inputs are part of what the verifier checks
    root: pub Field,              // The Merkle root to verify against (checked in Step 2)
    nullifier_hash: pub Field,    // Hash of nullifier - prevents double-spend (checked in Step 3)
    recipient: pub Field,         // Who receives the funds - prevents front-running attacks
    amount: pub Field,            // Withdrawal amount - must match the deposited amount

    // ========== PRIVATE INPUTS ==========
    // These are NEVER revealed to anyone - only the prover knows them
    // The proof convinces the verifier these exist without revealing them
    nullifier: Field,             // Secret 1 from deposit note
    secret: Field,                // Secret 2 from deposit note
    merkle_proof: [Field; TREE_DEPTH],  // Sibling hashes along path to root (10 hashes)
    is_even: [bool; TREE_DEPTH]   // Path direction at each level (left=true, right=false)
) {
    // STEP 1: Compute commitment from private inputs
    // commitment = Poseidon2(nullifier, secret, amount)
    // This proves you know the secrets that created a specific commitment
    let commitment = poseidon2::bn254::hash_3([nullifier, secret, amount]);

    // STEP 2: Verify nullifier_hash matches the public input
    // computed_nullifier_hash = Poseidon2(nullifier)
    // This links the private nullifier to the public nullifier_hash
    let computed_nullifier_hash = poseidon2::bn254::hash_1([nullifier]);
    assert(computed_nullifier_hash == nullifier_hash, "Invalid nullifier hash");

    // STEP 3: Verify the commitment is in the Merkle tree
    // Walk up from leaf (commitment) to root using the proof
    let computed_root = compute_merkle_root(commitment, merkle_proof, is_even);
    assert(computed_root == root, "Invalid Merkle proof");

    // STEP 4: Bind proof to recipient (prevents front-running)
    // We include recipient as a public input, so the proof is only valid for this recipient
    // The _ = recipient; is Noir syntax to explicitly acknowledge we're using this value
    let _ = recipient;
}
```

**ZK concept - Public vs Private Inputs:**
- **Public inputs** (`pub` keyword): Visible on-chain, part of what's verified
- **Private inputs** (no `pub`): Never revealed, prover proves they know them
- The magic: Verifier is convinced the private inputs exist and satisfy the constraints, without learning what they are!

**ZK concept - Field Elements:**
- `Field` is not a regular integer - it's an element of a finite field
- BN254 field has a prime modulus: `21888242871839275222246405745257275088548364400416034343698204186575808495617`
- All arithmetic is modular (wraps around) - important for cryptographic security
- The backend uses `@zkpassport/poseidon2` which operates on the same field

**ZK concept - Why Poseidon2?**
- SHA256 would require ~28,000 constraints per hash in a circuit
- Poseidon2 requires only ~200 constraints - 140x more efficient!
- Both the backend (JavaScript) and circuit (Noir) use the same Poseidon2 implementation
- This is why hashes computed in JS match hashes computed in Noir

**What the assertions prove:**
1. `commitment` check - You know the nullifier, secret, and amount that hash to a real deposit
2. `nullifier_hash` check - Links the proof to the nullifier_hash stored on-chain for double-spend prevention
3. `root` check - The commitment is actually in our Merkle tree (was actually deposited)
4. `recipient` binding - The proof only works for this specific recipient (prevents theft via front-running)

If all assertions pass, the proof is valid. The verifier is convinced you have a valid deposit, but learns **nothing** about which one!

---

## The Merkle Tree Circuit

**File:** `circuits/withdrawal/src/merkle_tree.nr`

The main circuit calls `compute_merkle_root`. Open this file:

```noir
use dep::poseidon2;                              // Same Poseidon2 library as main circuit

/// Computes the Merkle root from a leaf and its proof
///
/// # Arguments
/// * `leaf` - The leaf value to verify (our commitment)
/// * `path` - Array of sibling hashes along the path to root
/// * `is_even` - Boolean array indicating if leaf is on left (even) or right (odd) at each level
///
/// # Returns
/// The computed Merkle root
pub fn compute_merkle_root<let DEPTH: u32>(      // Generic over DEPTH - works for any tree size
    leaf: Field,                                  // The commitment we're proving exists
    path: [Field; DEPTH],                         // Sibling hashes at each level (10 hashes for depth 10)
    is_even: [bool; DEPTH]                        // Path direction: true=left, false=right
) -> Field {
    let mut current = leaf;                       // Start at the leaf (our commitment)

    for i in 0..DEPTH {                           // Walk up tree level by level
        let sibling = path[i];                    // Get sibling hash at this level

        // Determine order based on position in tree
        // If is_even[i] is true, we're on the LEFT (even index)
        // If is_even[i] is false, we're on the RIGHT (odd index)
        let (left, right) = if is_even[i] {
            (current, sibling)                    // We're left child, sibling is right
        } else {
            (sibling, current)                    // Sibling is left, we're right child
        };

        // Hash the pair to get parent node
        // parent = Poseidon2(left, right)
        current = poseidon2::bn254::hash_2([left, right]);
    }

    current                                       // Return the computed root
}
```

**ZK concept - Merkle Proof Verification:**
```
        Root (computed)
         /\
        /  \
       ??   h3 ← sibling from path[2]
      /\
     /  \
    ??  h2 ← sibling from path[1]
   /\
  /  \
 C   h1 ← sibling from path[0]
 ↑
 commitment (leaf)

Walking up: hash(C, h1) → hash(result, h2) → hash(result, h3) → Root
```

**What `is_even` tells us:**
- `is_even[i] = true`: Our node is on the LEFT at level i (even index: 0, 2, 4...)
- `is_even[i] = false`: Our node is on the RIGHT at level i (odd index: 1, 3, 5...)
- This determines the order of operands when hashing: `hash(left, right)` or `hash(sibling, current)`

**ZK concept - Why this is efficient:**
- Tree has 1024 leaves but proof is only 10 hashes (log₂(1024) = 10)
- Each hash proves you're on a valid path
- If any hash is wrong, the final root won't match
- This is O(log n) verification instead of O(n)

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

**Why this specific version?** Sunspot requires a specific Noir version. The compiled circuit format must match what Sunspot expects. Using a different version may cause proof generation to fail.

---

## Install Sunspot

Sunspot converts Noir circuits to Groth16 proofs that can be verified on Solana.

**ZK concept - Why Groth16?**
- Groth16 produces the smallest proofs (~256 bytes)
- Verification is extremely fast (~3 elliptic curve pairings)
- Perfect for on-chain verification where bytes and compute cost money
- The tradeoff: requires a "trusted setup" (the proving/verification key generation)

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

**File:** `circuits/withdrawal/`

```bash
cd circuits/withdrawal
nargo compile
```

This produces `target/withdrawal.json` - the compiled circuit in ACIR format.

**ZK concept - ACIR (Abstract Circuit Intermediate Representation):**
- ACIR is Noir's intermediate format - circuit logic without backend-specific details
- It's like LLVM IR but for circuits
- Sunspot then converts ACIR to Groth16-compatible R1CS/CCS format

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
| `withdrawal.ccs` | ~100KB | Circuit in CCS format (Customizable Constraint System) |
| `withdrawal.pk` | ~2MB | Proving key - backend uses this to generate proofs |
| `withdrawal.vk` | ~1KB | Verification key - baked into the on-chain verifier program |

**ZK concept - Proving vs Verification Keys:**
- **Proving key (pk)**: Large, contains "secrets" of the trusted setup, used to generate proofs
- **Verification key (vk)**: Small, derived from pk, anyone can use to verify proofs
- The pk can generate fake proofs if misused - that's why we need "trusted setup"
- For this workshop, we trust Sunspot's setup process

**ZK concept - Trusted Setup:**
- Groth16 requires generating keys from random "toxic waste"
- If anyone knows the toxic waste, they can generate fake proofs
- In production, multi-party computation (MPC) ceremonies are used
- For this workshop, the setup is deterministic (same circuit = same keys)

---

## Test the Circuit

Run the Noir tests to verify the circuit logic:

```bash
nargo test
```

This runs the test functions in `main.nr` to verify:
- Commitment computation is deterministic
- Different inputs produce different commitments
- Nullifier hashing works correctly

---

## What We Built

- **The withdrawal circuit** - Proves deposit ownership without revealing which deposit
- **Proving key (pk)** - Backend uses this to generate proofs (~30 seconds)
- **Verification key (vk)** - Will be baked into the on-chain verifier program

**The proof size**: Just 256 bytes! This tiny proof convinces anyone that you know secrets that satisfy all the circuit constraints, without revealing those secrets.

---

## What's Still Missing

We have the circuit and keys, but no way to verify proofs on Solana yet. The on-chain program needs to call a verifier to check the proof.

Next step: Deploy the verifier and add CPI (Cross-Program Invocation) to our program.

Continue to [Step 5: On-chain Verification](./step-5-onchain-verification.md).
