# Step 1: Commitments

## Goal

Replace the public depositor address with a cryptographic commitment.

## The Flow

Here's how commitments fit into the deposit flow:

```
USER DEPOSITS:
1. User enters amount in frontend
2. Frontend calls backend API
3. Backend generates random nullifier + secret
4. Backend runs hasher circuit to compute commitment    <-- We look at this circuit below
5. Backend returns deposit note (user saves this) + commitment
6. Frontend sends transaction with commitment           <-- We update the program to accept this
7. Program stores commitment in event (not depositor address)
```

The hasher circuit runs **off-chain in the backend** - not on Solana. This keeps the nullifier and secret private.

---

## The Hasher Circuit

Open `circuits/hasher/src/main.nr`. This is a Noir circuit that the **backend runs when a user deposits**.

```noir
fn main(nullifier: Field, secret: Field, amount: Field) -> pub (Field, Field) {
    let commitment = poseidon2::bn254::hash_3([nullifier, secret, amount]);
    let nullifier_hash = poseidon2::bn254::hash_1([nullifier]);
    (commitment, nullifier_hash)
}
```

**What each line does:**

- `nullifier: Field, secret: Field, amount: Field` - Takes three inputs. `Field` is a number type used in ZK circuits.
- `poseidon2::bn254::hash_is 3([...])` - Hashes three values together using Poseidon2. Returns the commitment.
- `poseidon2::bn254::hash_1([nullifier])` - Hashes just the nullifier. We use this later for double-spend prevention.
- `-> pub (Field, Field)` - Returns two public outputs: commitment and nullifier_hash.

**When does this run?** The backend calls `nargo execute` on this circuit when a user clicks deposit. The circuit computes the commitment, then the backend returns it to the frontend to include in the transaction.

### Compile and test

```bash
cd circuits/hasher
nargo compile
nargo test
```

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
        // TODO (Step 3): Add new_root: [u8; 32]
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

**Why `[u8; 32]`?** Poseidon2 outputs a 256-bit (32-byte) hash. This is the commitment that hides the depositor's identity.

### 2. Add next_leaf_index to Pool struct

We need to track which "slot" in our Merkle tree each deposit goes into. This becomes important in Step 3.

Find:

```rust
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    // TODO (Step 1): Add next_leaf_index: u64
```

Replace with:

```rust
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub next_leaf_index: u64,  // Tracks position in Merkle tree (0, 1, 2, ...)
```

### 3. Update DepositEvent

This is the key change - instead of storing who deposited, we store the commitment.

Find:

```rust
pub struct DepositEvent {
    pub depositor: Pubkey, // TODO (Step 1): Replace with commitment: [u8; 32]
    pub amount: u64,
    pub timestamp: i64,
    // TODO (Step 1): Add leaf_index: u64
```

Replace with:

```rust
#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],  // The hash - hides who deposited
    pub leaf_index: u64,       // Position in Merkle tree (needed for withdrawal proof)
    pub timestamp: i64,
```

**Why leaf_index?** When the user withdraws later, they need to know which position in the Merkle tree their deposit is at. The backend uses this to compute the Merkle proof.

### 4. Update the emit! in deposit function

Find:

```rust
        // PROBLEM: Everyone can see exactly who deposited!
        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(), // TODO (Step 1): Replace with commitment
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // TODO (Step 1): Add leaf_index
            // TODO (Step 3): Add new_root
        });

        pool.total_deposits += 1;
        // TODO (Step 1): Increment next_leaf_index
```

Replace with:

```rust
        // Save the current leaf index before incrementing
        let leaf_index = pool.next_leaf_index;

        // Emit event with commitment instead of depositor address
        emit!(DepositEvent {
            commitment,
            leaf_index,
            timestamp: Clock::get()?.unix_timestamp,
        });

        pool.next_leaf_index += 1;  // Next deposit goes in next slot
        pool.total_deposits += 1;
```

### 5. Initialize next_leaf_index

Find:

```rust
        pool.total_deposits = 0;

        // TODO (Step 3): Initialize root history
```

Replace with:

```rust
        pool.total_deposits = 0;
        pool.next_leaf_index = 0;  // First deposit goes in slot 0
```

### 6. Update the log message

Find:

```rust
        msg!("Public deposit: {} lamports from {}", amount, ctx.accounts.depositor.key());
```

Replace with:

```rust
        msg!("Deposit: {} lamports, leaf index {}", amount, pool.next_leaf_index - 1);
```

### Build

```bash
cd anchor
anchor build
```

---

## What Changed

**Before:** The deposit event showed `{ depositor: "Alice_pubkey", amount: 1000000 }`

**After:** The deposit event shows `{ commitment: "0x7a3b...", leaf_index: 0 }`

The depositor's identity is hidden. The only way to link a commitment to a person is to know the nullifier and secret that produced it.

---

## Next Step

We can deposit privately now, but anyone could withdraw multiple times. We need nullifiers to prevent double-spending.

Continue to [Step 2: Nullifiers](./step-2-nullifiers.md).
