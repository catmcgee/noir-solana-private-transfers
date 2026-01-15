# Appendix: Client Architecture

## Overview

This section explains how the frontend and backend work together to generate hashes and proofs. Understanding this is optional but helpful for seeing the complete picture.

**Key insight**: The frontend doesn't do cryptography directly - it calls a backend server that runs the Noir circuits via CLI.

## Why Run Circuits via CLI?

You might wonder: why not use a JavaScript Poseidon library?

Three reasons:

1. **Consistency**: The hash MUST match exactly between off-chain and on-chain. Using the same circuit guarantees this.

2. **Complexity**: Poseidon has many variants. Noir's `poseidon2` for bn254 is specific. Finding a matching JS implementation is error-prone.

3. **Simplicity**: Running `nargo execute` just works. No need to port cryptographic code.

In production, you might compile circuits to WASM and run them in the browser. But for learning, the CLI approach is clearer.

## Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │      │                 │
│    Frontend     │─────▶│    Backend      │─────▶│  Noir Circuits  │
│    (React)      │      │   (Express)     │      │   (nargo CLI)   │
│                 │◀─────│                 │◀─────│                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
        │                                                  │
        │                                                  │
        ▼                                                  ▼
┌─────────────────┐                              ┌─────────────────┐
│                 │                              │                 │
│  Solana RPC     │◀────────────────────────────│ Sunspot Verifier│
│                 │                              │   (on-chain)    │
└─────────────────┘                              └─────────────────┘
```

## Deposit Flow

When a user clicks Deposit, here's what happens:

### Step 1: Generate Random Secrets

```typescript
// backend/src/server.ts
const nullifier = generateRandomField()  // Random 254-bit value
const secret = generateRandomField()     // Another random value
const amountBigInt = BigInt(amount)
```

The backend generates two random field elements. These are the user's secrets - only they will know these values.

### Step 2: Compute Hashes by Running Noir Circuit

```typescript
function computeHashes(nullifier: bigint, secret: bigint, amount: bigint) {
  // Write inputs to Prover.toml
  const proverToml = `nullifier = "${nullifier}"
secret = "${secret}"
amount = "${amount}"
`
  fs.writeFileSync(path.join(HASHER_DIR, 'Prover.toml'), proverToml)

  // RUN THE NOIR CIRCUIT!
  const result = execSync('nargo execute 2>&1', { cwd: HASHER_DIR })

  // Parse the output
  const outputMatch = result.match(/Circuit output: \(([^,]+),\s*([^)]+)\)/)
  return {
    commitment: outputMatch[1].trim(),
    nullifierHash: outputMatch[2].trim()
  }
}
```

This is the key part. We don't use a TypeScript Poseidon library. We literally run the SAME Noir circuit via `nargo execute`.

We write the inputs to `Prover.toml`, run `nargo execute`, and parse the output.

### Step 3: Compute Merkle Root

```typescript
function computeMerkleRoot(commitment: string, leafIndex: number): string {
  const proverToml = `leaf = "${commitment}"\nleaf_index = "${leafIndex}"\n`
  fs.writeFileSync(path.join(MERKLE_HASHER_DIR, 'Prover.toml'), proverToml)

  const result = execSync('nargo execute 2>&1', { cwd: MERKLE_HASHER_DIR })
  // Parse output...
}
```

Same pattern for the Merkle root. We run the `merkle-hasher` circuit to compute what the tree root will be after this deposit.

### Step 4: Return Deposit Note

```typescript
const depositNote = {
  nullifier: nullifier.toString(),      // SECRET - user must save!
  secret: secret.toString(),            // SECRET - user must save!
  amount: amount.toString(),
  commitment: hashes.commitment,        // Can be public
  nullifierHash: hashes.nullifierHash,  // Used during withdrawal
  merkleRoot: merkleRoot,               // The root after this deposit
  leafIndex: leafIndex,                 // Position in tree
  timestamp: Date.now()
}
```

The backend returns a "deposit note" containing everything the user needs to withdraw later. The critical secrets are `nullifier` and `secret`. If they lose these, the funds are gone forever.

## Withdrawal Flow

When a user clicks Withdraw:

### Step 1: Get Merkle Proof

```typescript
function getMerkleProof(leafIndex: number): { proof: string[], isEven: boolean[] } {
  const proof: string[] = []
  const isEven: boolean[] = []

  let idx = leafIndex
  for (let i = 0; i < TREE_DEPTH; i++) {
    // Sibling at each level is an empty subtree
    proof.push(EMPTY_TREE_ZEROS[i])
    // is_even = true means we're on the left
    isEven.push((idx & 1) === 0)
    idx = idx >> 1
  }

  return { proof, isEven }
}
```

For the Merkle proof, we need the sibling hashes at each level. In our simplified case, most siblings are "empty subtrees" - pre-computed hashes of trees with no deposits.

### Step 2: Write All Inputs to Prover.toml

```typescript
const toml = `
# Public Inputs
root = "${merkleRoot}"
nullifier_hash = "${nullifierHash}"
recipient = "${recipient}"
amount = "${amount}"

# Private Inputs
nullifier = "${nullifier}"
secret = "${secret}"
merkle_proof = [${merkleProof.map(p => `"${p}"`).join(', ')}]
is_even = [${isEven.join(', ')}]
`
fs.writeFileSync(path.join(WITHDRAWAL_DIR, 'Prover.toml'), toml)
```

We write ALL the inputs - public and private - to the `Prover.toml` file. The circuit will use these to generate the proof.

### Step 3: Generate the ZK Proof

```typescript
function generateProof(): { proof: Buffer, publicWitness: Buffer } {
  // Step 1: Execute the circuit to generate witness
  execSync('nargo execute', { cwd: WITHDRAWAL_DIR })

  // Step 2: Generate Groth16 proof using Sunspot
  execSync(`sunspot prove target/withdrawal.json target/withdrawal.gz target/withdrawal.ccs target/withdrawal.pk`, {
    cwd: WITHDRAWAL_DIR
  })

  // Step 3: Read the proof file
  const proof = fs.readFileSync(path.join(WITHDRAWAL_DIR, 'target/withdrawal.proof'))
  return { proof, publicWitness }
}
```

This is where the magic happens:

1. `nargo execute` runs the circuit with our inputs and generates a "witness" - the intermediate values
2. `sunspot prove` takes that witness and generates a Groth16 proof - this is the ~30 second step
3. We read the proof file - it's only 256 bytes!

The proof file is what gets sent to the blockchain. It proves everything without revealing the private inputs.

### Step 4: Return Proof to Frontend

```typescript
const withdrawalProof = {
  proof: Array.from(proof),           // 256 bytes
  nullifierHash: depositNote.nullifierHash,
  merkleRoot: depositNote.merkleRoot,
  recipient: recipient,
  amount: depositNote.amount
}
```

The frontend receives the proof and the public inputs. It then constructs the Solana transaction and sends it to the blockchain.

## Frontend Transaction Construction

The frontend takes the proof from the backend and constructs a Solana transaction:

```typescript
// Build the withdraw instruction
const withdrawDataEncoder = getWithdrawInstructionDataEncoder()
const instructionData = withdrawDataEncoder.encode({
  proof,              // 256-byte Groth16 proof
  nullifierHash,      // 32 bytes
  root,               // 32 bytes
  recipient,          // Pubkey
  amount,             // u64
})

// IMPORTANT: Request extra compute units for ZK verification
const computeBudgetData = new Uint8Array(5)
computeBudgetData[0] = 2  // SetComputeUnitLimit instruction
new DataView(computeBudgetData.buffer).setUint32(1, 1_400_000, true)  // 1.4M units
```

Note the compute budget instruction - ZK verification needs 1.4 million compute units, way more than the default 200K.

## Summary

| Component | Technology | Purpose |
|-----------|------------|---------|
| Hasher circuit | `nargo execute` | Compute commitment & nullifier_hash |
| Merkle-hasher circuit | `nargo execute` | Compute new tree root |
| Withdrawal circuit | `nargo execute` + `sunspot prove` | Generate ZK proof |
| Backend server | Express.js | Orchestrate all of the above |
| Frontend | React | UI + transaction construction |
| On-chain verifier | Sunspot | Verify proofs trustlessly |
