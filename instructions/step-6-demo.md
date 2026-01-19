# Step 6: Demo

## Goal

Run the complete privacy flow and understand how Solana Kit connects everything together.

## Where We Are

```
✅ Step 0: Understand the architecture
✅ Step 1: Hide deposit details
✅ Step 2: Prove membership
✅ Step 3: Prevent double-spending
✅ Step 4: The ZK circuit
✅ Step 5: On-chain verification
🔲 Step 6: Demo                      ← You are here
```

---

## The Frontend Stack

This app uses the new **Solana Kit** - a modern TypeScript SDK that replaces the older `@solana/web3.js`.

| Package | Purpose |
|---------|---------|
| `@solana/kit` | Core utilities (addresses, PDAs, encoders) |
| `@solana/client` | RPC client and wallet discovery |
| `@solana/react-hooks` | React hooks for wallet state and transactions |
| `codama` | Generates TypeScript clients from Anchor IDL |

---

## Understanding the Code

### 1. Client Setup (`App.tsx`)

```typescript
import { createClient, autoDiscover } from '@solana/client'
import { SolanaProvider, useWalletConnection } from '@solana/react-hooks'

const client = createClient({
  endpoint: 'https://api.devnet.solana.com',
  walletConnectors: autoDiscover(),  // Finds installed wallets (Phantom, etc.)
})

function App() {
  return (
    <SolanaProvider client={client}>
      <MainApp />
    </SolanaProvider>
  )
}
```

**What's happening:**
- `createClient` creates a connection to Solana with wallet support
- `autoDiscover()` automatically detects installed browser wallets
- `SolanaProvider` makes the client available to all child components
- `useWalletConnection()` gives access to the connected wallet

---

### 2. Computing PDAs (`DepositSection.tsx`)

PDAs (Program Derived Addresses) are deterministic addresses derived from seeds:

```typescript
import { getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'

// Pool PDA: derived from just "pool"
const [poolPda] = await getProgramDerivedAddress({
  programAddress: PRIVATE_TRANSFERS_PROGRAM_ADDRESS,
  seeds: [getBytesEncoder().encode(new Uint8Array([112, 111, 111, 108]))],  // "pool"
})

// Vault PDA: derived from "vault" + pool address
const [poolVaultPda] = await getProgramDerivedAddress({
  programAddress,
  seeds: [
    getBytesEncoder().encode(new Uint8Array([118, 97, 117, 108, 116])),  // "vault"
    getAddressEncoder().encode(poolPda),  // Pool address as second seed
  ],
})
```

**Key points:**
- PDAs are computed the same way on-chain (Rust) and off-chain (TypeScript)
- `getBytesEncoder()` encodes raw bytes (for string seeds)
- `getAddressEncoder()` encodes Solana addresses (32 bytes)
- These must match the `seeds = [...]` in your Anchor program

---

### 3. Generated Code with Codama

Codama reads your Anchor IDL and generates type-safe TypeScript:

```typescript
import {
  getDepositInstructionDataEncoder,
  PRIVATE_TRANSFERS_PROGRAM_ADDRESS
} from '../generated'

// Encode instruction data with type safety
const dataEncoder = getDepositInstructionDataEncoder()
const instructionData = dataEncoder.encode({
  commitment: new Uint8Array(onChainData.commitment),
  newRoot: new Uint8Array(onChainData.newRoot),
  amount: BigInt(onChainData.amount),
})
```

**What Codama generates:**
- `getDepositInstructionDataEncoder()` - Serializes deposit args
- `getWithdrawInstructionDataEncoder()` - Serializes withdraw args
- `PRIVATE_TRANSFERS_PROGRAM_ADDRESS` - Your program's address
- Type definitions matching your Anchor structs

To regenerate after IDL changes:
```bash
cd frontend
bun run generate
```

---

### 4. Building Instructions

Solana instructions have three parts: program, accounts, and data:

```typescript
const depositInstruction = {
  programAddress: PRIVATE_TRANSFERS_PROGRAM_ADDRESS,
  accounts: [
    { address: poolPda, role: 1 },        // role 1 = writable
    { address: poolVaultPda, role: 1 },   // role 1 = writable
    { address: walletAddress, role: 3 },  // role 3 = writable + signer
    { address: SYSTEM_PROGRAM_ID, role: 0 }, // role 0 = readonly
  ],
  data: instructionData,
}
```

**Account roles:**

| Role | Meaning | Example |
|------|---------|---------|
| 0 | Read-only | System program, verifier |
| 1 | Writable | Pool, vault (state changes) |
| 2 | Signer | - |
| 3 | Writable + Signer | Depositor (pays + signs) |

---

### 5. Compute Budget for ZK Verification

ZK proof verification is expensive. We need to request more compute:

```typescript
import { address } from '@solana/kit'

const COMPUTE_BUDGET_PROGRAM_ID = address('ComputeBudget111111111111111111111111111111')
const ZK_VERIFY_COMPUTE_UNITS = 1_400_000  // 1.4M units

// Build ComputeBudget instruction manually
const computeBudgetData = new Uint8Array(5)
computeBudgetData[0] = 2  // SetComputeUnitLimit instruction
new DataView(computeBudgetData.buffer).setUint32(1, ZK_VERIFY_COMPUTE_UNITS, true)

const computeBudgetInstruction = {
  programAddress: COMPUTE_BUDGET_PROGRAM_ID,
  accounts: [],
  data: computeBudgetData,
}

// Send BOTH instructions in one transaction
await sendTransaction({
  instructions: [computeBudgetInstruction, withdrawInstruction],
})
```

**Why 1.4M units?**
- Default Solana compute limit is 200,000 units
- Groth16 verification requires ~1M+ units
- We request 1.4M to have headroom
- This costs a few extra lamports in fees

---

### 6. Sending Transactions

The `useSendTransaction` hook handles signing and confirmation:

```typescript
import { useSendTransaction } from '@solana/react-hooks'

function DepositSection() {
  const { send: sendTransaction, isSending } = useSendTransaction()

  const handleDeposit = async () => {
    const result = await sendTransaction({
      instructions: [depositInstruction],
    })
    // result contains the transaction signature
  }
}
```

**What happens internally:**
1. Hook builds a transaction message from instructions
2. Gets recent blockhash from RPC
3. Prompts wallet to sign
4. Sends to network
5. Waits for confirmation

---

## Start the Application

### 1. Start the Backend

The backend handles ZK operations (hashing, proof generation).

```bash
cd backend
bun install
bun run dev
```

The backend runs on `http://localhost:4001`.

### 2. Start the Frontend

```bash
cd frontend
bun install
bun run dev
```

Open `http://localhost:3000` in your browser.

---

## Part 1: Connect Wallet

Click **Connect Wallet** in the top right.

Make sure you're on **devnet** and have some SOL (use a faucet if needed).

---

## Part 2: Deposit

1. Enter an amount (e.g., 0.1 SOL)
2. Click **Deposit**
3. Approve the transaction in your wallet

**What happens behind the scenes:**

```
1. Frontend calls POST /api/deposit with amount
2. Backend generates random nullifier + secret (32 bytes each)
3. Backend computes commitment = Poseidon2(nullifier, secret, amount)
4. Backend computes new Merkle root with this commitment
5. Backend returns deposit note + on-chain data
6. Frontend computes PDAs (pool, vault)
7. Frontend encodes instruction data via Codama
8. Frontend builds transaction with deposit instruction
9. Wallet signs, transaction sent to Solana
10. Program stores root, emits event with commitment
```

**Save your deposit note!** You need it to withdraw. If you lose it, your funds are gone forever.

---

## Part 3: Switch Wallets

Switch to a **different wallet** in Phantom (or your wallet extension).

This simulates Alice depositing and Bob withdrawing - two different people.

---

## Part 4: Withdraw

1. Paste the deposit note from earlier
2. Click **Withdraw**
3. Wait ~30 seconds for proof generation
4. Approve the transaction in your wallet

**What happens behind the scenes:**

```
1. Frontend parses deposit note, calls POST /api/withdraw
2. Backend retrieves Merkle tree from stored state
3. Backend computes Merkle proof path using leaf_index
4. Backend writes all inputs to Prover.toml
5. Backend runs `nargo execute` → generates witness (~5 sec)
6. Backend runs `sunspot prove` → generates 256-byte proof (~25 sec)
7. Frontend computes PDAs (pool, nullifier_set, vault)
8. Frontend encodes instruction data via Codama
9. Frontend builds ComputeBudget instruction (1.4M units)
10. Frontend builds withdraw instruction with proof
11. Wallet signs, transaction sent to Solana
12. Program checks nullifier not used
13. Program checks root exists in history
14. Program calls Sunspot verifier via CPI
15. Verifier validates Groth16 proof
16. Program marks nullifier used, transfers SOL
```

---

## Part 5: Verify on Explorer

Open [Solana Explorer](https://explorer.solana.com/?cluster=devnet) and look at both transactions:

**Deposit transaction:**
- Shows `commitment: 0x7a3b...`
- Shows `leaf_index: 0`
- No depositor address in the event

**Withdrawal transaction:**
- Shows `nullifier_hash: 0x9c2f...`
- Shows `recipient: Bob's_address`
- No commitment reference

**These cannot be linked.** The commitment and nullifier_hash are cryptographically unrelated without knowing the original nullifier.

---

## Solana Kit vs Legacy web3.js

| Feature | Legacy web3.js | Solana Kit |
|---------|---------------|------------|
| Bundle size | ~400KB | ~50KB (tree-shakeable) |
| TypeScript | Partial | Full type safety |
| PDAs | `PublicKey.findProgramAddress` | `getProgramDerivedAddress` |
| Encoding | Manual `Buffer` manipulation | Typed encoders |
| React | Separate `@solana/wallet-adapter-react` | Built-in `@solana/react-hooks` |
| Client | `Connection` class | `createClient` factory |

---

## What You Built

| Component | Solana Concept | ZK Concept |
|-----------|---------------|------------|
| Pool account | PDA with state | - |
| Vault account | PDA holding SOL | - |
| Commitment | Event data | Hash hiding deposit |
| Nullifier set | PDA with Vec storage | Double-spend prevention |
| Merkle root | Fixed-size array (ring buffer) | Membership proof |
| Verifier CPI | Cross-program invocation | Groth16 verification |
| Compute budget | Transaction resource limits | Proof verification cost |

---

## Limitations

This is educational code:

- **Variable amounts reduce privacy** - Deposits/withdrawals can be correlated by amount
- **Not audited** - Don't use with real funds
- **Limited capacity** - Nullifier set capped at 256 entries
- **Single deposit assumption** - Full tree indexing not implemented

---

## FAQs

**Q: Why does proof generation take 30 seconds?**
Groth16 proving is computationally intensive. It involves many elliptic curve operations. Future optimizations and client-side WASM support will improve this.

**Q: What if I lose my deposit note?**
Funds are lost forever. The note contains the nullifier and secret - the only proof you made a deposit. There's no recovery mechanism.

**Q: Can the pool operator steal funds?**
No. Funds can only move with a valid ZK proof. Only the depositor has the nullifier/secret needed to create that proof.

**Q: How much does a withdrawal cost?**
About 1.4M compute units, which costs a few extra cents in transaction fees. Still very cheap compared to Ethereum.

**Q: Why use Solana Kit instead of web3.js?**
Solana Kit is the modern replacement - smaller bundle, better types, and designed for tree-shaking. It's the recommended approach for new projects.

---

## Resources

- [Solana Kit Documentation](https://github.com/solana-foundation/solana-lib)
- [Codama Documentation](https://github.com/codama-idl/codama)
- [Noir Documentation](https://noir-lang.org/docs)
- [Sunspot Repository](https://github.com/reilabs/sunspot)

---

## Congratulations!

You've built a privacy-preserving transfer system on Solana using modern tooling.

These concepts - commitments, nullifiers, Merkle trees, ZK proofs - combined with Solana Kit, Codama, and Anchor - give you a complete toolkit for building privacy applications on Solana.
