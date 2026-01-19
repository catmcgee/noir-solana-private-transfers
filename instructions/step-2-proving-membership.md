# Step 2: Proving Membership

## Goal

Add Merkle tree root tracking so we can efficiently prove a commitment exists in the pool.

## Where We Are

```
✅ Step 0: Understand the architecture
✅ Step 1: Hide deposit details
🔲 Step 2: Prove membership         ← You are here
🔲 Step 3: Prevent double-spending
🔲 Step 4: The ZK circuit
🔲 Step 5: On-chain verification
```

---

## The Flow

Here's how Merkle trees fit into both flows:

```
DEPOSIT FLOW:
1. User deposits with commitment
2. Backend computes new Merkle root (adding commitment to tree)
3. Frontend sends transaction with commitment + new_root
4. Program stores the new root in history                    <-- We add this
5. Program tracks the deposit's position (leaf_index)        <-- We add this

WITHDRAWAL FLOW:
1. User wants to withdraw
2. Backend computes Merkle proof (path from leaf to root using leaf_index)
3. ZK circuit verifies the proof matches a known root        <-- Step 4
4. Program checks the root exists in history                 <-- We add this
```

We only store the root on-chain (32 bytes), not the whole tree. The backend maintains the full tree and computes proofs.

---

## Program Updates

### 1. Add constants at the top

In `lib.rs`, find:

```rust
// Step 2: Add Merkle tree constants here
// Step 5: Add SUNSPOT_VERIFIER_ID here

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

Replace with:

```rust
pub const TREE_DEPTH: usize = 10;              // 2^10 = 1024 max deposits
pub const MAX_LEAVES: u64 = 1 << TREE_DEPTH;   // 1024
pub const ROOT_HISTORY_SIZE: usize = 10;       // Keep last 10 roots

// Precomputed root of an empty tree (all leaves are zero)
// Computed with Poseidon2 from @zkpassport/poseidon2 / noir-lang/poseidon
pub const EMPTY_ROOT: [u8; 32] = [
    0x2a, 0x77, 0x5e, 0xa7, 0x61, 0xd2, 0x04, 0x35,
    0xb3, 0x1f, 0xa2, 0xc3, 0x3f, 0xf0, 0x76, 0x63,
    0xe2, 0x45, 0x42, 0xff, 0xb9, 0xe7, 0xb2, 0x93,
    0xdf, 0xce, 0x30, 0x42, 0xeb, 0x10, 0x46, 0x86,
];

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

**Why these values?**

- `TREE_DEPTH: 10` - A depth-10 tree holds 2^10 = 1024 deposits
- `ROOT_HISTORY_SIZE: 10` - We keep 10 roots so proofs against recent roots still work
- `EMPTY_ROOT` - The root of a tree where all leaves are zero (precomputed)

### 2. Update Pool struct

We need to track deposit order (leaf_index) and store recent roots (ring buffer pattern).

Find:

```rust
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    // Step 2: Add next_leaf_index, current_root_index, roots
}

// Step 2: Add is_known_root method to Pool
// Step 3: Add NullifierSet struct with is_nullifier_used and mark_nullifier_used methods
```

Replace with:

```rust
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub next_leaf_index: u64,
    pub current_root_index: u64,
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
}

impl Pool {
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}
```

**Why track leaf_index?** Each deposit gets a unique position in the Merkle tree. The user saves this index in their deposit note - they'll need it for the backend to compute the Merkle proof path during withdrawal.

**Why a ring buffer for roots?**

- Fixed-size array (not Vec) because Solana account sizes are fixed at creation
- New roots overwrite the oldest ones
- Users can generate a proof, wait, and submit later - as long as the root is still in history

### 3. Initialize Pool in initialize function

Find:

```rust
        pool.total_deposits = 0;
        // Step 2: Initialize next_leaf_index, current_root_index, roots[0]
        // Step 3: Initialize nullifier_set.pool

        msg!("Pool initialized");
```

Replace with:

```rust
        pool.total_deposits = 0;
        pool.next_leaf_index = 0;      // First deposit gets index 0
        pool.current_root_index = 0;
        pool.roots[0] = EMPTY_ROOT;    // Start with empty tree root

        msg!("Pool initialized");
```

### 4. Update deposit function signature

The frontend now sends the new Merkle root (computed off-chain).

Find:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],  // The hash computed off-chain by the backend
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],
        new_root: [u8; 32],
        amount: u64,
    ) -> Result<()> {
```

**Why trust the client?** If they submit a wrong root, any proof against that root will fail. Invalid roots are useless - they can't help attackers.

### 5. Add tree full check

After the `MIN_DEPOSIT_AMOUNT` check, find:

```rust
        require!(
            amount >= MIN_DEPOSIT_AMOUNT,
            PrivateTransfersError::DepositTooSmall
        );
        // Step 2: Add tree full check

        let cpi_context = CpiContext::new(
```

Replace with:

```rust
        require!(
            amount >= MIN_DEPOSIT_AMOUNT,
            PrivateTransfersError::DepositTooSmall
        );

        // Check tree isn't full
        require!(
            pool.next_leaf_index < MAX_LEAVES,
            PrivateTransfersError::TreeFull
        );

        let cpi_context = CpiContext::new(
```

### 6. Update root history and leaf_index after transfer

Find:

```rust
        system_program::transfer(cpi_context, amount)?;

        // Step 2: Save leaf_index, update root history

        // Emit event with commitment instead of depositor address
        emit!(DepositEvent {
            commitment,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        pool.total_deposits += 1;
        // Step 2: Increment next_leaf_index
```

Replace with:

```rust
        system_program::transfer(cpi_context, amount)?;

        // Save the current leaf index before incrementing
        let leaf_index = pool.next_leaf_index;

        // Update Merkle root history (ring buffer)
        let new_root_index = ((pool.current_root_index + 1) % ROOT_HISTORY_SIZE as u64) as usize;
        pool.roots[new_root_index] = new_root;
        pool.current_root_index = new_root_index as u64;

        // Emit event with commitment and position
        emit!(DepositEvent {
            commitment,
            leaf_index,
            timestamp: Clock::get()?.unix_timestamp,
            new_root,
        });

        pool.next_leaf_index += 1;  // Next deposit gets the next index
        pool.total_deposits += 1;
```

**What this does:**

- Saves leaf_index before incrementing (current deposit uses index N, then increment to N+1)
- `(current + 1) % SIZE` - Wraps around when we reach the end (ring buffer)
- Stores the new root in the next slot
- Updates the pointer to the newest root

### 7. Update DepositEvent

Find:

```rust
#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],  // The hash - no identity revealed
    pub amount: u64,
    pub timestamp: i64,
```

Replace with:

```rust
#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub timestamp: i64,
    pub new_root: [u8; 32],
}
```

**Why include leaf_index?** The user needs to know which "slot" their deposit is in. This gets saved in their deposit note and used by the backend to compute the Merkle proof path.

**Why emit new_root?** Indexers can use this to verify the tree state. Users save it in their deposit note for withdrawal.

### 8. Add root parameter to withdraw

Find:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // Step 5: Add proof: Vec<u8>
        // Step 3: Add nullifier_hash: [u8; 32]
        // Step 2: Add root: [u8; 32]
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // Step 5: Add proof: Vec<u8>
        // Step 3: Add nullifier_hash: [u8; 32]
        root: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

### 9. Add root validation in withdraw

Find (after the function signature):

```rust
    ) -> Result<()> {
        // Step 3: Check nullifier not used
        // Step 2: Validate root is known

        require!(
```

Replace with:

```rust
    ) -> Result<()> {
        // Step 3: Check nullifier not used

        // Verify the root exists in our history
        require!(
            ctx.accounts.pool.is_known_root(&root),
            PrivateTransfersError::InvalidRoot
        );

        require!(
```

**Why validate the root?** The ZK proof proves the commitment is in a tree with this root. We need to verify that root is one we actually stored.

### 10. Update the log message in deposit

Find:

```rust
        msg!("Deposit: {} lamports", amount);
```

Replace with:

```rust
        msg!("Deposit: {} lamports at leaf index {}", amount, leaf_index);
```

### 11. Add error codes

Find:

```rust
    #[msg("Deposit amount too small")]
    DepositTooSmall,
```

Add after it:

```rust
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Unknown Merkle root")]
    InvalidRoot,
```

### Build

```bash
anchor build
```

---

## What Changed

**Deposit:**
- Frontend sends commitment + new_root
- Program tracks leaf_index (position in tree)
- Program stores root in history
- Event includes leaf_index and new_root

**Withdraw:**
- Transaction includes the root the proof was made against
- Program verifies that root is in our history

---

## What's Still Missing

We can now prove a commitment exists. But what stops someone from proving the same deposit multiple times? Nothing yet!

Next step: Prevent double-spending with nullifiers.

Continue to [Step 3: Preventing Double-Spend](./step-3-preventing-double-spend.md).
