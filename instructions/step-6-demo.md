# Step 6: Demo & Client side

## Goal

See the complete privacy flow in action and understand the Solana client-side code that powers it.

## Run the Demo

```bash
cd frontend
bun run dev
```

Open http://localhost:3000 in your browser.

---

## Part 1: Connect Wallet

Click the **Connect Wallet** button in the top right.

### What's happening in the code

```typescript
// App.tsx
import { createClient, autoDiscover } from "@solana/client";
import { SolanaProvider, useWalletConnection } from "@solana/react-hooks";

const client = createClient({
  endpoint: DEVNET_ENDPOINT,
  walletConnectors: autoDiscover(),
});

function AppProviders({ children }: { children: ReactNode }) {
  return <SolanaProvider client={client}>{children}</SolanaProvider>;
}
```

**Key Solana concepts:**

| Concept               | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| `createClient`        | Creates an RPC client that talks to Solana nodes                   |
| `autoDiscover()`      | Finds wallet extensions (Phantom, Solflare, etc.) in your browser  |
| `SolanaProvider`      | React context that gives all child components access to the client |
| `useWalletConnection` | Hook to access the connected wallet                                |

The `endpoint` is the Solana RPC URL. We use devnet for testing:

```typescript
// constants.ts
export const DEVNET_ENDPOINT = "https://api.devnet.solana.com";
```

- **Localnet**: Local validator, data resets when you stop it
- **Devnet**: Persistent test network, free SOL from faucets
- **Mainnet**: Real money, don't deploy this project here as it is for demo purposes only

---

## Part 2: Deposit

Enter an amount (e.g., 0.1 SOL) and click **Deposit**.

### Step 2.1: Call the Backend API

```typescript
// DepositSection.tsx
const response = await fetch(`${API_URL}/api/deposit`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    amount: amountLamports,
    depositor: walletAddress,
  }),
});

const { depositNote, onChainData }: DepositApiResponse = await response.json();
```

The ZK operations (hashing, proving) run via Noir CLI commands. This will be able to happen directly in the brwowser soon - Sunspot is developing a client-side library.

The backend:

1. Generates random `nullifier` and `secret`
2. Runs `nargo execute` to compute Poseidon2 hashes
3. Returns a `depositNote` (for the user to save) and `onChainData` (for the transaction)

```typescript
// backend/src/server.ts - deposit endpoint
app.post("/api/deposit", async (req, res) => {
  const { amount } = req.body;
  const leafIndex = await getNextLeafIndex();

  // Generate random field elements for nullifier and secret
  const nullifier = generateRandomField();
  const secret = generateRandomField();

  // Compute commitment and nullifier_hash via Noir circuit
  const hashes = computeHashes(nullifier, secret, BigInt(amount));
  const merkleRoot = computeMerkleRoot(hashes.commitment, leafIndex);

  // Return deposit note (user saves this) + onchain data
  const depositNote = {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    amount: amount.toString(),
    commitment: hashes.commitment,
    nullifierHash: hashes.nullifierHash,
    merkleRoot: merkleRoot,
    leafIndex: leafIndex,
  };

  res.json({ depositNote, onChainData: { commitment, newRoot, amount } });
});
```

The `computeHashes` function writes inputs to `Prover.toml` and runs the Noir hasher circuit:

```typescript
// backend/src/server.ts
function computeHashes(nullifier: bigint, secret: bigint, amount: bigint) {
  const proverToml = `nullifier = "${nullifier}"
secret = "${secret}"
amount = "${amount}"`;
  fs.writeFileSync(path.join(HASHER_DIR, "Prover.toml"), proverToml);

  const result = execSync("nargo execute 2>&1", { cwd: HASHER_DIR });
  // Parse output: commitment and nullifier_hash
  // ...
}
```

### Step 2.2: Derive PDAs (Program Derived Addresses)

```typescript
// DepositSection.tsx
import {
  getProgramDerivedAddress,
  getBytesEncoder,
  getAddressEncoder,
} from "@solana/kit";

const [poolPda] = await getProgramDerivedAddress({
  programAddress,
  seeds: [getBytesEncoder().encode(SEEDS.POOL)],
});

const [poolVaultPda] = await getProgramDerivedAddress({
  programAddress,
  seeds: [
    getBytesEncoder().encode(SEEDS.VAULT),
    getAddressEncoder().encode(poolPda),
  ],
});
```

**PDAs explained:**

PDAs are special addresses that programs can "own" and sign for. They're derived deterministically from:

- The program's address
- A list of "seeds" (arbitrary bytes)

```
PDA = hash(seeds + program_id + "PDA")
```

| PDA            | Seeds                | Purpose                                         |
| -------------- | -------------------- | ----------------------------------------------- |
| `poolPda`      | `["pool"]`           | Stores Merkle root, leaf count, deposit history |
| `poolVaultPda` | `["vault", poolPda]` | Holds the deposited SOL                         |

**Why PDAs?**

- Normal accounts need a private key to sign
- Programs don't have private keys
- PDAs let programs control accounts without keys

The seeds in our code:

```typescript
// constants.ts
export const SEEDS = {
  POOL: new Uint8Array([112, 111, 111, 108]),           // "pool"
  VAULT: new Uint8Array([118, 97, 117, 108, 116]),     // "vault"
  NULLIFIERS: new Uint8Array([110, 117, 108, 108, ...]), // "nullifiers"
}
```

### Step 2.3: Encode the instruction data

```typescript
// DepositSection.tsx
import { getDepositInstructionDataEncoder } from "../generated";

const dataEncoder = getDepositInstructionDataEncoder();
const instructionData = dataEncoder.encode({
  commitment: new Uint8Array(onChainData.commitment),
  newRoot: new Uint8Array(onChainData.newRoot),
  amount: BigInt(onChainData.amount),
});
```

Solana instructions have a specific binary format. The encoder converts our JavaScript objects into bytes that the on-chain program can parse.

This encoder is **auto-generated from the IDL** using Codama. The IDL (Interface Definition Language) describes your program's instructions and accounts.

The instruction data layout:

```
| discriminator (8 bytes) | commitment (32 bytes) | newRoot (32 bytes) | amount (8 bytes) |
```

The **discriminator** is a hash of the instruction name - it tells the program which instruction you're calling.

### Step 2.4: Build the Instruction

```typescript
// DepositSection.tsx
const depositInstruction = {
  programAddress,
  accounts: [
    { address: poolPda, role: 1 }, // WritableAccount
    { address: poolVaultPda, role: 1 }, // WritableAccount
    { address: walletAddress, role: 3 }, // WritableSigner
    { address: SYSTEM_PROGRAM_ID, role: 0 }, // ReadonlyAccount
  ],
  data: instructionData,
};
```

**Solana's account model:**

Every instruction specifies which accounts it touches. Each account has a role:

| Role            | Value | Meaning                 |
| --------------- | ----- | ----------------------- |
| ReadonlyAccount | 0     | Can read, cannot write  |
| WritableAccount | 1     | Can read and write      |
| ReadonlySigner  | 2     | Must sign, cannot write |
| WritableSigner  | 3     | Must sign, can write    |

**Why do we need to list accounts?**

- Solana's runtime parallelizes transactions
- It needs to know which accounts each transaction touches
- Transactions touching different accounts run in parallel
- Transactions touching the same writable account run sequentially

### Step 2.5: Send the Transaction

```typescript
// DepositSection.tsx
import { useSendTransaction } from "@solana/react-hooks";

const { send: sendTransaction, isSending } = useSendTransaction();

const result = await sendTransaction({
  instructions: [depositInstruction],
});
```

**What `sendTransaction` does:**

1. Builds a transaction from your instructions
2. Fetches a recent blockhash (transactions expire after ~60 seconds)
3. Prompts the wallet to sign
4. Submits to the network
5. Waits for confirmation

When complete, a **deposit note** appears. This contains your secrets that you need to withdraw

---

## Part 3: Switch Wallets

Switch to a completely different wallet in Phantom. This simulates Alice depositing and Bob withdrawing.

---

## Part 4: Withdraw

Paste the deposit note and click **Withdraw**.

### Step 4.1: Generate the ZK Proof (Backend)

```typescript
// WithdrawSection.tsx
const response = await fetch(`${API_URL}/api/withdraw`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ depositNote, recipient, payer: walletAddress }),
});

const { withdrawalProof }: WithdrawApiResponse = await response.json();
```

This takes ~30 seconds. The backend:

1. Reconstructs the Merkle proof
2. Writes all inputs to `Prover.toml`
3. Runs `nargo execute` to generate a witness
4. Runs `sunspot prove` to generate a Groth16 proof (256 bytes)

```typescript
// backend/src/server.ts - withdraw endpoint
app.post("/api/withdraw", (req, res) => {
  const { depositNote, recipient } = req.body;

  // Get Merkle proof (siblings at each level)
  const { proof: merkleProof, isEven } = getMerkleProof(depositNote.leafIndex);

  // Write all circuit inputs to Prover.toml
  writeProverToml(
    depositNote.nullifier,
    depositNote.secret,
    depositNote.amount,
    depositNote.nullifierHash,
    pubkeyToField(recipient),
    depositNote.merkleRoot,
    merkleProof,
    isEven
  );

  // Generate ZK proof (~30 seconds)
  const { proof, publicWitness } = generateProof();

  res.json({ withdrawalProof: { proof, nullifierHash, merkleRoot, amount } });
});
```

The `generateProof` function runs the Noir and Sunspot CLI:

```typescript
// backend/src/server.ts
function generateProof(): { proof: Buffer; publicWitness: Buffer } {
  // Generate witness from circuit inputs
  execSync("nargo execute", { cwd: WITHDRAWAL_DIR });

  // Generate Groth16 proof using Sunspot
  execSync(
    `sunspot prove target/withdrawal.json target/withdrawal.gz target/withdrawal.ccs target/withdrawal.pk`,
    { cwd: WITHDRAWAL_DIR }
  );

  // Read the 256-byte proof
  const proof = fs.readFileSync(
    path.join(WITHDRAWAL_DIR, "target/withdrawal.proof")
  );
  const publicWitness = fs.readFileSync(
    path.join(WITHDRAWAL_DIR, "target/withdrawal.pw")
  );

  return { proof, publicWitness };
}
```

### Step 4.2: Derive More PDAs

```typescript
// WithdrawSection.tsx
const [poolPda] = await getProgramDerivedAddress({
  programAddress,
  seeds: [getBytesEncoder().encode(SEEDS.POOL)],
});

const [nullifierSetPda] = await getProgramDerivedAddress({
  programAddress,
  seeds: [
    getBytesEncoder().encode(SEEDS.NULLIFIERS),
    getAddressEncoder().encode(poolPda),
  ],
});

const [poolVaultPda] = await getProgramDerivedAddress({
  programAddress,
  seeds: [
    getBytesEncoder().encode(SEEDS.VAULT),
    getAddressEncoder().encode(poolPda),
  ],
});
```

Withdrawal needs three PDAs:

| PDA               | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `poolPda`         | Verify the Merkle root matches                           |
| `nullifierSetPda` | Check nullifier hasn't been used (prevents double-spend) |
| `poolVaultPda`    | Transfer SOL from the vault to recipient                 |

### Step 4.3: Request Extra Compute Units

```typescript
// WithdrawSection.tsx
const computeBudgetData = new Uint8Array(5);
computeBudgetData[0] = 2; // SetComputeUnitLimit instruction
new DataView(computeBudgetData.buffer).setUint32(
  1,
  ZK_VERIFY_COMPUTE_UNITS,
  true
); // 1.4M units

const computeBudgetInstruction = {
  programAddress: COMPUTE_BUDGET_PROGRAM_ID,
  accounts: [] as const,
  data: computeBudgetData,
};
```

**Compute units explained:**

Solana limits how much work a transaction can do. Default: 200,000 compute units.

ZK proof verification is expensive - Groth16 needs ~1.4 million compute units. We request more via the **Compute Budget Program**.

```typescript
// constants.ts
export const COMPUTE_BUDGET_PROGRAM_ID = address(
  "ComputeBudget111111111111111111111111111111"
);
export const ZK_VERIFY_COMPUTE_UNITS = 1_400_000;
```

### Step 4.4: Build the Withdraw Instruction

```typescript
// WithdrawSection.tsx
const withdrawDataEncoder = getWithdrawInstructionDataEncoder();
const instructionData = withdrawDataEncoder.encode({
  proof, // 256-byte Groth16 proof
  nullifierHash, // 32 bytes
  root, // 32 bytes
  recipient: recipientAddress,
  amount: amountBN,
});

const withdrawInstruction = {
  programAddress,
  accounts: [
    { address: poolPda, role: 1 },
    { address: nullifierSetPda, role: 1 },
    { address: poolVaultPda, role: 1 },
    { address: recipientAddress, role: 1 },
    { address: SUNSPOT_VERIFIER_ID, role: 0 },
    { address: SYSTEM_PROGRAM_ID, role: 0 },
  ],
  data: instructionData,
};
```

Note the `SUNSPOT_VERIFIER_ID` - this is the on-chain program that verifies ZK proofs:

```typescript
// constants.ts
export const SUNSPOT_VERIFIER_ID = address(
  "CU2Vgym4wiTNcJCuW6r7DV6bCGULJxKdwFjfGfmksSVZ"
);
```

### Step 4.5: Send Both Instructions

```typescript
// WithdrawSection.tsx
const result = await sendTransaction({
  instructions: [computeBudgetInstruction, withdrawInstruction],
});
```

**Multiple instructions in one transaction:**

Solana transactions can contain multiple instructions. They execute atomically - all succeed or all fail.

Here we send two instructions:

1. `computeBudgetInstruction` - Request 1.4M compute units
2. `withdrawInstruction` - The actual withdrawal

---

## Part 5: Verify on Explorer

Open Solana Explorer and look at both transactions:

- **Deposit**: Shows `commitment: 0x7a3b...`
- **Withdrawal**: Shows `nullifier_hash: 0x9c2f...`

---

## What You Built

| Component        | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| Commitment       | Hides deposit details in a hash                       |
| Nullifier        | Prevents double-spend without revealing which deposit |
| Merkle Tree      | Efficient membership proofs with O(log n) data        |
| ZK Circuit       | Proves everything without revealing private inputs    |
| Sunspot Verifier | Trustlessly verifies proofs on Solana                 |

---

## Limitations

This is an educational implementation:

- **Variable amounts reduce privacy**: Deposits/withdrawals can be correlated by amount
- **Not audited**: Don't use in production
- **Limited capacity**: Nullifier set capped at 256 entries in this demo

---

## FAQs

**Q: Why Poseidon hash and not SHA256?**

Poseidon is designed for ZK circuits. SHA256 would require tens of thousands more constraints, making proofs much slower and more expensive.

**Q: How long does proof generation take?**

About 30 seconds on a laptop. This happens in the backend via `sunspot prove`.

**Q: What's the cost of verification?**

About 1.4 million compute units, which costs a few cents extra in transaction fees.

**Q: Can the pool operator steal funds?**

No. Funds can only move with a valid ZK proof, and only the depositor has the nullifier/secret needed to create that proof.

**Q: What happens if I lose my deposit note?**

The funds are lost forever. The note contains the secrets needed to withdraw. There's no recovery mechanism.

---

## Resources

- [Solana Kit Documentation](https://github.com/solana-foundation/kit)
- [Framework-kit](https://github.com/solana-foundation/framework-kit)
- [Noir Documentation](https://noir-lang.org/docs)
- [Sunspot Repository](https://github.com/reilabs/sunspot)

---

Congratulations! You've built a complete privacy-preserving transfer system on Solana.
