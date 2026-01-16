# Step 4: ZK Circuits

## Goal

Understand the full withdrawal circuit and generate Sunspot proving/verification keys.

## Zero knowledge LFG!

This is where everything comes together. We have:

- **Commitments** that hide deposit details
- **Nullifiers** that prevent double-spending
- **Merkle trees** that prove membership

But the Merkle proof reveals which commitment is ours. So let's wrap everything in a **zero-knowledge proof**.

## Groth16 on Solana

Solana doesn't have native ZK verification, so we need to pick a proof system:

| Proof System | Proof Size | Verification Cost | Trusted Setup?    |
| ------------ | ---------- | ----------------- | ----------------- |
| **Groth16**  | 256 bytes  | ~1.4M CU          | Yes (per-circuit) |
| PLONK        | ~500 bytes | ~2M CU            | Universal         |
| STARKs       | ~50KB      | Too expensive     | No                |

**Groth16** fits Solana best:

- **Smallest proofs** (256 bytes) - need this for Solana's 1232-byte tx limit
- **Fastest verification** - fits inside Solana's compute budget
- **Sunspot support** - has good tooling, is widely used across blockchain

### What is Groth16?

Groth16 is a **zk-SNARK** (Zero-Knowledge Succinct Non-Interactive Argument of Knowledge):

- **Zero-Knowledge**: Verifier learns nothing about private inputs
- **Succinct**: Proof is tiny (256 bytes)
- **Non-Interactive**: No back-and-forth between prover and verifier, single proof submitted
- **Argument of Knowledge**: Prover must actually know the private inputs

The 256-byte proof consists of three elliptic curve points on BN254:

- **A** (G1 point): 64 bytes
- **B** (G2 point): 128 bytes
- **C** (G1 point): 64 bytes

And that is all we will learn about ZK in this tutorial - it's complex math from here that thankfully, because of Noir, we don't need to know!

### The Trusted Setup Trade-off

Groth16 requires a **trusted setup** - a one-time ceremony that generates the proving/verification keys. If the setup is compromised, fake proofs could be created.

For this tutorial, we generate keys locally (fine for learning). Production systems use multi-party computation (MPC) ceremonies where security holds if even one participant is honest.

A ZK proof lets us prove a statement WITHOUT revealing the private data used to compute it.

In our case, we prove: "I know a nullifier, secret, and amount such that the commitment is in this Merkle tree, and this nullifier_hash is correct."

The verifier is convinced, but learns NOTHING about which commitment we're spending.

## The Withdrawal Circuit

Open `circuits/withdrawal/src/main.nr` to see the full circuit:

```noir
fn main(
    // PUBLIC - visible onchain
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

**PUBLIC inputs** - visible to everyone onchain:

- `root`: the Merkle tree root we're proving against
- `nullifier_hash`: to prevent double-spending
- `recipient`: who gets the funds (prevents front-running)
- `amount`: how much to withdraw

**PRIVATE inputs** - NEVER revealed, not even to the verifier:

- `nullifier`: the secret value chosen during deposit (you saved this!)
- `secret`: another random value from deposit (you saved this!)
- `merkle_proof`: the 10 sibling hashes (computed by backend from tree data)
- `is_even`: which side of the tree at each level (computed from your leaf index)

You only need to save your `nullifier` and `secret`. The `merkle_proof` and `is_even` arrays are computed by the backend when you want to withdraw— - it uses your `leafIndex` and the tree state to figure these out.

![image](./assets/zk_circuit.png)

### What the Circuit Proves

| Assertion                                      | What it proves                       |
| ---------------------------------------------- | ------------------------------------ |
| `commitment = Hash(nullifier, secret, amount)` | I know the deposit secrets           |
| `computed_hash == nullifier_hash`              | My nullifier matches the public hash |
| `computed_root == root`                        | My commitment is in the tree         |
| `recipient` is a public input                  | Proof is bound to this recipient     |

If all assertions pass, the proof is valid. If any private input is wrong, the proof fails.

### Compile and test

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
3. Generates verification keys (inside onchain verifier)
4. Generates a Solana program that can verify these proofs

### Run Sunspot commands

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
- When a user wants to withdraw, the client loads this key and generates a proof

**Verification key** (`withdrawal.vk`, ~1KB)

- Gets **compiled into a Solana program** by `sunspot deploy`
- This creates the verifier program you deploy to Solana
- Verification happens onchain via CPI

> The verification key doesn't go in your program's account data. Instead, Sunspot generates an entirely separate Solana program with the verification logic baked in. Your program calls this verifier via CPI.

The verification key is derived from the circuit. If you change the circuit, you need new keys and a new verifier program.

## Key Concepts

| Concept          | Description                                              |
| ---------------- | -------------------------------------------------------- |
| Public Inputs    | Visible onchain: root, nullifier_hash, recipient, amount |
| Private Inputs   | Never revealed: nullifier, secret, merkle_proof, is_even |
| Proving Key      | Client-side, ~2MB, ~30s to generate proof                |
| Verification Key | onchain, ~1KB, milliseconds to verify                    |
| Groth16 Proof    | 256 bytes total                                          |

## Next step

Now we need to create the actual Solana verifier program and integrate it into our code.

Continue to [Step 5: Sunspot Verification](./step-5-sunspot-verification.md).
