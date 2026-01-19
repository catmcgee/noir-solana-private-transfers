# Step 1: Hiding Deposit Details

## Goal

Replace the public depositor address with a cryptographic commitment that can't be traced back.

---

## The Concept

Right now, if Alice deposits 1 SOL, the blockchain shows:
```
DepositEvent { depositor: "Alice_pubkey", amount: 1000000 }
```

Everyone knows Alice deposited. We want:
```
DepositEvent { commitment: "0x7a3b...", amount: 1000000 }
```

A **commitment** is a hash: `Hash(nullifier, secret, amount)`. It hides Alice's identity while still being unique to her deposit. Only Alice knows the inputs, so only she can prove she made this deposit later.

---

## The Deposit Flow

Let's trace what happens when a user deposits, then we'll update the program.

---

### 1. User Clicks Deposit (READ)

**File:** `frontend/src/components/DepositSection.tsx` - find the `handleDeposit` function

The user enters an amount and clicks deposit. The frontend calls the backend:

```typescript
const handleDeposit = async () => {
  const amountLamports = Math.floor(parseFloat(amount) * Number(LAMPORTS_PER_SOL))

  const response = await fetch(`${API_URL}/api/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountLamports })
  })
```

The frontend sends the amount to the backend to generate the commitment...

---

### 2. Backend Generates the Commitment (READ)

**File:** `backend/src/server.ts` - find the `/api/deposit` endpoint

The backend generates two random secrets and computes the commitment hash:

```typescript
app.post("/api/deposit", async (req, res) => {
  const { amount } = req.body

  const nullifier = generateRandomField()  // Random 256-bit number
  const secret = generateRandomField()     // Another random 256-bit number

  // commitment = Hash(nullifier, secret, amount)
  const commitment = poseidon2Hash([nullifier, secret, amount])

  // nullifier_hash = Hash(nullifier) - used later to prevent double-spending
  const nullifierHash = poseidon2Hash([nullifier])
```

**Why Poseidon2?** It's a ZK-friendly hash function. We use the same hash in our Noir circuits later, so the JavaScript commitment will match what the circuit expects.

**Why hash off-chain?** If we computed the hash on-chain, the inputs (nullifier, secret) would be visible in the transaction data. That defeats the whole purpose!

The backend returns the commitment and a deposit note with the secrets:

```typescript
  const depositNote = {
    nullifier: nullifier.toString(),      // Secret! User saves this
    secret: secret.toString(),            // Secret! User saves this
    amount: amount.toString(),
    commitment: hashes.commitment,
    nullifierHash: hashes.nullifierHash,
    merkleRoot: merkleRoot,
    leafIndex: leafIndex,
  }

  res.json({
    depositNote,  // User saves this secretly
    onChainData: {
      commitment: commitmentBytes,  // The 32-byte hash for the blockchain
      newRoot: merkleRootBytes,
      amount: amount.toString(),
    },
  })
```

Now let's see how the frontend sends this to the program...

---

### 3. Frontend Builds the Transaction (TYPE)

**File:** `frontend/src/components/DepositSection.tsx` - back to `handleDeposit`

Now we write the Solana-specific code. This teaches core Solana concepts you'll use in every project.

#### First, uncomment the imports at the top of the file

Find these commented imports and uncomment them:

```typescript
// Step 1: You'll use these imports for PDA computation
// import { getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'
```

```typescript
// Step 1: You'll use this import for encoding instruction data
// import { getDepositInstructionDataEncoder } from '../generated'
```

```typescript
// Step 1: You'll use these imports for building the instruction
// import { SEEDS, SYSTEM_PROGRAM_ID } from '../constants'
```

#### Computing PDAs (Program Derived Addresses)

PDAs are deterministic addresses owned by your program. Given the same seeds, anyone can compute the same address.

Find the TODO block in `handleDeposit` and **replace the entire TODO section** (from `// ============` to `throw new Error(...)`) with this code:

```typescript
      const programAddress = PRIVATE_TRANSFERS_PROGRAM_ADDRESS

      // Find PDAs - deterministic addresses derived from seeds
      const [poolPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [getBytesEncoder().encode(SEEDS.POOL)],
      })

      const [poolVaultPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          getBytesEncoder().encode(SEEDS.VAULT),
          getAddressEncoder().encode(poolPda),
        ],
      })
```

**Why PDAs?**
- `poolPda`: The pool's state account - stores configuration and Merkle roots
- `poolVaultPda`: Holds the actual SOL - derived from pool address so it's unique per pool
- Seeds must match exactly what the program expects (we'll see this in the Rust code)

#### Encoding Instruction Data

The encoder is generated by Codama from the program's IDL. It ensures type safety.

**Continue adding this code:**

```typescript
      const dataEncoder = getDepositInstructionDataEncoder()
      const instructionData = dataEncoder.encode({
        commitment: new Uint8Array(onChainData.commitment),
        newRoot: new Uint8Array(onChainData.newRoot),
        amount: BigInt(onChainData.amount),
      })
```

#### Building the Instruction

Every Solana instruction has three parts: program address, accounts, and data.

**Continue adding this code:**

```typescript
      const depositInstruction = {
        programAddress,
        accounts: [
          { address: poolPda, role: 1 },           // writable
          { address: poolVaultPda, role: 1 },      // writable
          { address: walletAddress, role: 3 },     // writable + signer
          { address: SYSTEM_PROGRAM_ID, role: 0 }, // readonly
        ],
        data: instructionData,
      }
```

**Account roles - memorize these:**
| Role | Meaning | When to use |
|------|---------|-------------|
| 0 | readonly | Reading data, system program |
| 1 | writable | Modifying account data |
| 2 | signer | Must sign but not modified |
| 3 | writable + signer | User paying/signing |

**Why does order matter?** The accounts array must match the order in the Rust `#[derive(Accounts)]` struct exactly.

The transaction is sent to our Solana program. Now let's update the program to handle it...

---

### 4. Program Processes the Deposit (TYPE)

**File:** `anchor/programs/private_transfers/src/lib.rs`

Now we update the Solana program. The program needs to accept the commitment instead of logging the depositor's address.

#### Update the deposit function signature

Find:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        // Step 1: Add commitment: [u8; 32]
        // Step 2: Add new_root: [u8; 32]
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],  // The hash computed off-chain
        amount: u64,
    ) -> Result<()> {
```

**Why `[u8; 32]`?** Poseidon2 outputs a 256-bit (32-byte) hash.

#### Update the DepositEvent struct

This is the key change - instead of storing who deposited, we store the commitment.

Find:

```rust
pub struct DepositEvent {
    pub depositor: Pubkey, // Step 1: Change to commitment: [u8; 32]
    pub amount: u64,
    pub timestamp: i64,
    // Step 2: Add leaf_index: u64, new_root: [u8; 32]
}
```

Replace with:

```rust
pub struct DepositEvent {
    pub commitment: [u8; 32],  // The hash - no identity revealed!
    pub amount: u64,
    pub timestamp: i64,
}
```

#### Update the emit! call

Find:

```rust
        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(), // Step 1: Change to commitment
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // Step 2: Add leaf_index, new_root
        });
```

Replace with:

```rust
        emit!(DepositEvent {
            commitment,  // Store the hash, not the identity
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
```

#### Update the log message

Find:

```rust
        msg!("Public deposit: {} lamports from {}", amount, ctx.accounts.depositor.key());
```

Replace with:

```rust
        msg!("Deposit: {} lamports", amount);
```

---

### Build

```bash
cd anchor
anchor build
```

---

## What Changed

**Before:** The deposit event showed `{ depositor: "Alice_pubkey", amount: 1000000 }`

**After:** The deposit event shows `{ commitment: "0x7a3b...", amount: 1000000 }`

The depositor's wallet still signs the transaction (that's visible on the explorer), but the **on-chain record** no longer links their identity to this specific deposit. Anyone looking at the events just sees a hash.

---

## What's Still Missing

We've hidden the deposit side. But how do we withdraw? We can't just show our commitment - that would reveal which deposit is ours.

We need to prove we know a valid commitment **without revealing which one**.

Next step: Prove a commitment exists in the pool using Merkle trees.

Continue to [Step 2: Proving Membership](./step-2-proving-membership.md).
