# Step 1: Hiding Deposit Details

## Goal

Replace the public depositor address with a cryptographic commitment that can't be traced back.

## Where We Are

```
✅ Step 0: Understand the architecture
🔲 Step 1: Hide deposit details     ← You are here
🔲 Step 2: Prove membership
🔲 Step 3: Prevent double-spending
🔲 Step 4: The ZK circuit
🔲 Step 5: On-chain verification
```

---

## The Flow

Here's how commitments fit into the deposit flow:

```
USER DEPOSITS:
1. User enters amount in frontend
2. Frontend calls backend API
3. Backend generates random nullifier + secret
4. Backend computes commitment = Hash(nullifier, secret, amount)
5. Backend returns deposit note (save this!) + commitment
6. Frontend sends transaction with commitment
7. Program stores commitment in event (not depositor address)
```

The hashing happens **off-chain in the backend** using JavaScript. This keeps the nullifier and secret private.

![offchain_vs_onchain](./assets/offchain_vs_onchain.png)

---

## How the Backend Computes Commitments

The backend uses the `@zkpassport/poseidon2` library to compute hashes. This library is compatible with the same Poseidon2 implementation used in our ZK circuits later.

```typescript
import { poseidon2Hash } from "@zkpassport/poseidon2";

// commitment = Hash(nullifier, secret, amount)
const commitment = poseidon2Hash([nullifier, secret, amount]);

// nullifier_hash = Hash(nullifier) - used later to prevent double-spending
const nullifierHash = poseidon2Hash([nullifier]);
```

**Why hash offchain?**

If we hashed on-chain, the inputs would be in the transaction data - which is public. That defeats the whole purpose.

So the backend hashes off-chain using JavaScript. Only the 32-byte commitment touches Solana.

**Why Poseidon2?** We use the same hash function that our ZK circuits will use. This ensures the commitment computed in JavaScript matches what the circuit expects during withdrawal.

---

## Program Updates

Now update the Solana program to accept commitments instead of recording depositor addresses.

### 1. Update deposit function signature

The frontend will now send a commitment instead of us recording who the depositor is.

In `anchor/programs/private_transfers/src/lib.rs`, find:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        // TODO (Step 1): Add commitment: [u8; 32]
        // TODO (Step 2): Add new_root: [u8; 32]
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],  // The hash computed off-chain by the backend
        amount: u64,
    ) -> Result<()> {
```

**Why `[u8; 32]`?** Poseidon2 outputs a 256-bit (32-byte) hash. This is standard for cryptographic hashes and fits perfectly in a Solana account field.

### 2. Update DepositEvent

This is the key change - instead of storing who deposited, we store the commitment.

Find:

```rust
pub struct DepositEvent {
    pub depositor: Pubkey, // TODO (Step 1): Replace with commitment: [u8; 32]
    pub amount: u64,
    pub timestamp: i64,
    // TODO (Step 2): Add leaf_index: u64
    // TODO (Step 2): Add new_root: [u8; 32]
```

Replace with:

```rust
#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],  // The hash - no identity revealed
    pub amount: u64,
    pub timestamp: i64,
```

### 3. Update the emit! in deposit function

Find:

```rust
        // PROBLEM: Everyone can see exactly who deposited!
        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(), // TODO (Step 1): Replace with commitment
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // TODO (Step 2): Add leaf_index
            // TODO (Step 2): Add new_root
        });

        pool.total_deposits += 1;
```

Replace with:

```rust
        // Emit event with commitment instead of depositor address
        emit!(DepositEvent {
            commitment,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        pool.total_deposits += 1;
```

### 4. Update the log message

Find:

```rust
        msg!("Public deposit: {} lamports from {}", amount, ctx.accounts.depositor.key());
```

Replace with:

```rust
        msg!("Deposit: {} lamports", amount);
```

### Build

```bash
cd anchor
anchor build
```

---

## What Changed

**Before:** The deposit event showed `{ depositor: "Alice_pubkey", amount: 1000000 }`

**After:** The deposit event shows `{ commitment: "0x7a3b...", amount: 1000000 }`

The depositor's wallet still signs the transaction (that's visible), but the on-chain record no longer links their identity to this specific deposit. Anyone looking at the events just sees a hash.

![before_after_privacy_explorer](./assets/before_after_privacy_explorer.png)

---

## What's Still Missing

We've hidden the deposit side. But how do we withdraw? We can't just show our commitment - that would reveal which deposit is ours.

We need to prove we have a valid commitment without revealing which one.

Next step: Prove a commitment exists in the pool using Merkle trees.

Continue to [Step 2: Proving Membership](./step-2-proving-membership.md).
