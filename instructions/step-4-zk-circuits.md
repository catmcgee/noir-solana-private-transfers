# Step 4: ZK Circuits

## Goal

Understand the full withdrawal circuit and generate Sunspot proving/verification keys.

## The Final Piece

This is where everything comes together. We have:
- **Commitments** that hide deposit details
- **Nullifiers** that prevent double-spending
- **Merkle trees** that prove membership

But the Merkle proof reveals which commitment is ours. The solution: wrap everything in a **zero-knowledge proof**.

A ZK proof lets us prove a statement WITHOUT revealing the private data used to compute it.

In our case, we prove: "I know a nullifier, secret, and amount such that the commitment is in this Merkle tree, and this nullifier_hash is correct."

The verifier is convinced, but learns NOTHING about which commitment we're spending.

## The Withdrawal Circuit

Open `circuits/withdrawal/src/main.nr` to see the full circuit:

```noir
fn main(
    // PUBLIC - visible on-chain
    root: pub Field,
    nullifier_hash: pub Field,
    recipient: pub Field,
    amount: pub Field,

    // PRIVATE - never revealed
    nullifier: Field,
    secret: Field,
    merkle_proof: [Field; TREE_DEPTH],
    is_even: [bool; TREE_DEPTH]
) {
    // 1. Compute commitment
    let commitment = poseidon2::bn254::hash_3([nullifier, secret, amount]);

    // 2. Verify nullifier_hash
    let computed_hash = poseidon2::bn254::hash_1([nullifier]);
    assert(computed_hash == nullifier_hash);

    // 3. Verify Merkle membership
    let computed_root = compute_merkle_root(commitment, merkle_proof, is_even);
    assert(computed_root == root);
}
```

### Public vs Private Inputs

**PUBLIC inputs** - visible to everyone on-chain:
- `root`: the Merkle tree root we're proving against
- `nullifier_hash`: to prevent double-spending
- `recipient`: who gets the funds (prevents front-running)
- `amount`: how much to withdraw

**PRIVATE inputs** - NEVER revealed, not even to the verifier:
- `nullifier`: the secret value chosen during deposit
- `secret`: another random value from deposit
- `merkle_proof`: the 10 sibling hashes
- `is_even`: which side of the tree at each level

### What the Circuit Proves

| Assertion | What it proves |
|-----------|----------------|
| `commitment = Hash(nullifier, secret, amount)` | I know the deposit secrets |
| `computed_hash == nullifier_hash` | My nullifier matches the public hash |
| `computed_root == root` | My commitment is in the tree |
| `recipient` is a public input | Proof is bound to this recipient |

If ALL assertions pass, the proof is valid. If ANY private input is wrong, the proof fails.

**The magic**: the verifier is convinced of all this WITHOUT seeing the private inputs. That's zero-knowledge.

### Compile and Test

```bash
cd circuits/withdrawal
nargo compile
nargo test
```

## Generate Sunspot Keys

Now convert this Noir circuit into something we can verify on Solana.

Sunspot:
1. Converts Noir's ACIR format to Groth16-compatible format
2. Generates proving keys (used client-side to make proofs)
3. Generates verification keys (baked into the on-chain verifier)
4. Creates a Solana program that can verify these proofs

Groth16 proofs are tiny - just 256 bytes - and cheap to verify on-chain.

### Run Sunspot Commands

```bash
cd circuits/withdrawal

# Convert Noir ACIR to CCS format (Groth16 compatible)
sunspot compile --input target/withdrawal.json --output target/withdrawal.ccs

# Generate proving key (~2MB) and verification key (~1KB)
sunspot setup --input target/withdrawal.ccs --pk target/withdrawal.pk --vk target/withdrawal.vk
```

## Understanding the Keys

You now have two key files:

**Proving key** (`withdrawal.pk`, ~2MB)
- Used client-side
- When a user wants to withdraw, their browser/app loads this key and generates a proof
- Proof generation takes about 30 seconds

**Verification key** (`withdrawal.vk`, ~1KB)
- Gets baked into the on-chain verifier
- Tiny but can verify any proof generated with the proving key
- Verification is nearly instant

The verification key is derived from the circuit. If you change the circuit, you need new keys.

## The Proof Format

Groth16 proofs consist of three elliptic curve points:
- **A**: 64 bytes
- **B**: 128 bytes
- **C**: 64 bytes
- **Total**: 256 bytes

This 256-byte proof convinces anyone that you know valid private inputs, without revealing what they are.

## Key Concepts

| Concept | Description |
|---------|-------------|
| Public Inputs | Visible on-chain: root, nullifier_hash, recipient, amount |
| Private Inputs | Never revealed: nullifier, secret, merkle_proof, is_even |
| Proving Key | Client-side, ~2MB, ~30s to generate proof |
| Verification Key | On-chain, ~1KB, milliseconds to verify |
| Groth16 Proof | 256 bytes total |

## Next Step

Now we need to create the actual Solana verifier program and integrate it into our code.

Continue to [Step 5: Sunspot Verification](./step-5-sunspot-verification.md).
