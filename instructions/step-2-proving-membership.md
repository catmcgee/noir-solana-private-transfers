# Step 2: Proving Membership

## Goal

Add Merkle tree root tracking so we can efficiently prove a commitment exists in the pool.

---

## The Concept

We have commitments, but how do we prove one exists without revealing which one? **Merkle trees**.

A Merkle tree is a binary tree of hashes. The root (32 bytes) represents ALL leaves. To prove a leaf exists, you only need ~10 hashes (the "proof path"), not all 1024 leaves.

```
         Root
        /    \
      H12    H34
      / \    / \
     H1 H2  H3 H4
     |   |   |   |
    C1  C2  C3  C4  ← commitments (leaves)
```

To prove C2 exists, you provide: H1, H34. The verifier computes: `Hash(H1, C2) → H12`, then `Hash(H12, H34) → Root`. If it matches the stored root, C2 exists.

We store only the root on-chain (32 bytes). The backend maintains the full tree.

---

## The Deposit Flow (Enhanced)

Let's trace how Merkle trees fit into the deposit flow.

---

### 1. Backend Computes the Merkle Root (READ)

**File:** `backend/src/server.ts` - find the `/api/deposit` endpoint

After generating the commitment (Step 1), the backend also updates the Merkle tree:

```typescript
app.post("/api/deposit", async (req, res) => {
  const { amount } = req.body

  // Step 1: Generate secrets and commitment
  const nullifier = generateRandomField()
  const secret = generateRandomField()
  const commitment = poseidon2Hash([nullifier, secret, amount])

  // Step 2: Add commitment to Merkle tree and get new root
  const leafIndex = merkleTree.nextIndex
  merkleTree.insert(commitment)  // Add commitment as a new leaf
  const merkleRoot = merkleTree.root  // Get the updated root
```

The backend returns both the deposit note and the new root:

```typescript
  const depositNote = {
    // ... secrets ...
    merkleRoot: merkleRoot,      // The root at time of deposit
    leafIndex: leafIndex,        // Position in tree - needed for withdrawal proof
  }

  res.json({
    depositNote,
    onChainData: {
      commitment: commitmentBytes,
      newRoot: merkleRootBytes,  // Send new root to store on-chain
      amount: amount.toString(),
    },
  })
```

---

### 2. Frontend Sends the New Root (READ)

**File:** `frontend/src/components/DepositSection.tsx` - in `handleDeposit`

The frontend now sends the new root along with the commitment (you already typed this in Step 1):

```typescript
  const dataEncoder = getDepositInstructionDataEncoder()
  const instructionData = dataEncoder.encode({
    commitment: new Uint8Array(onChainData.commitment),
    newRoot: new Uint8Array(onChainData.newRoot),  // The updated Merkle root
    amount: BigInt(onChainData.amount),
  })
```

Now let's update the program to store this root...

---

### 3. Program Stores the Root (TYPE)

**File:** `anchor/programs/private_transfers/src/lib.rs`

The program needs to:
1. Accept the new root as a parameter
2. Store it in a history (ring buffer)
3. Track the leaf index for events

#### Add constants at the top

Find:

```rust
// Step 2: Add Merkle tree constants here
// Step 5: Add SUNSPOT_VERIFIER_ID here

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

Replace with:

```rust
// Maximum depth of our Merkle tree
// A depth of 10 means 2^10 = 1024 possible deposits
pub const TREE_DEPTH: usize = 10;

// Maximum number of leaves (deposits) our tree can hold
pub const MAX_LEAVES: u64 = 1 << TREE_DEPTH;

// How many recent Merkle roots we keep in history
pub const ROOT_HISTORY_SIZE: usize = 10;

// The Merkle root of a completely empty tree (all leaves are zero)
// Pre-computed using Poseidon2 hash
pub const EMPTY_ROOT: [u8; 32] = [
    0x2a, 0x77, 0x5e, 0xa7, 0x61, 0xd2, 0x04, 0x35,
    0xb3, 0x1f, 0xa2, 0xc3, 0x3f, 0xf0, 0x76, 0x63,
    0xe2, 0x45, 0x42, 0xff, 0xb9, 0xe7, 0xb2, 0x93,
    0xdf, 0xce, 0x30, 0x42, 0xeb, 0x10, 0x46, 0x86,
];

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

**Why these values?**
- `TREE_DEPTH: 10` - Balances capacity (1024 deposits) with proof size (10 hashes)
- `ROOT_HISTORY_SIZE: 10` - Keeps recent roots so proofs don't expire too quickly
- `EMPTY_ROOT` - Pre-computed because computing it on-chain would waste compute units

#### Update Pool struct

Find:

```rust
#[account]
#[derive(InitSpace)]
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
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub next_leaf_index: u64,     // Which slot the next deposit goes into (0, 1, 2...)
    pub current_root_index: u64,  // Pointer to newest root in the ring buffer
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],  // Ring buffer of recent roots
}

impl Pool {
    /// Check if a Merkle root exists in our recent history
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

// Step 3: Add NullifierSet struct with is_nullifier_used and mark_nullifier_used methods
```

**Solana concept - Ring Buffer Pattern:**
- We can't use `Vec` that grows dynamically (account size is fixed)
- Instead, we use a fixed-size array and overwrite old entries
- When we add a new root, we increment the index (wrapping around at 10)

#### Initialize Pool in initialize function

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
        pool.next_leaf_index = 0;
        pool.current_root_index = 0;
        pool.roots[0] = EMPTY_ROOT;
        // Step 3: Initialize nullifier_set.pool

        msg!("Pool initialized");
```

#### Update deposit function signature

Find:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],  // The hash computed off-chain
        // Step 2: Add new_root: [u8; 32]
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],
        new_root: [u8; 32],     // The new Merkle root after adding this commitment
        amount: u64,
    ) -> Result<()> {
```

#### Add tree full check

Find:

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

        require!(
            pool.next_leaf_index < MAX_LEAVES,
            PrivateTransfersError::TreeFull
        );

        let cpi_context = CpiContext::new(
```

#### Update root history and leaf_index after transfer

Find:

```rust
        system_program::transfer(cpi_context, amount)?;

        // Step 2: Save leaf_index, update root history

        // Emit event with commitment instead of depositor address
        emit!(DepositEvent {
            commitment,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // Step 2: Add leaf_index, new_root
        });

        pool.total_deposits += 1;
        // Step 2: Increment next_leaf_index

        msg!("Deposit: {} lamports", amount);
```

Replace with:

```rust
        system_program::transfer(cpi_context, amount)?;

        // Save current leaf index BEFORE incrementing
        let leaf_index = pool.next_leaf_index;

        // Update Merkle root history using ring buffer pattern
        let new_root_index = ((pool.current_root_index + 1) % ROOT_HISTORY_SIZE as u64) as usize;
        pool.roots[new_root_index] = new_root;
        pool.current_root_index = new_root_index as u64;

        emit!(DepositEvent {
            commitment,
            leaf_index,
            timestamp: Clock::get()?.unix_timestamp,
            new_root,
        });

        pool.next_leaf_index += 1;
        pool.total_deposits += 1;

        msg!("Deposit: {} lamports at leaf index {}", amount, leaf_index);
```

#### Update DepositEvent

Find:

```rust
#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],  // The hash - no identity revealed
    pub amount: u64,
    pub timestamp: i64,
    // Step 2: Add leaf_index: u64, new_root: [u8; 32]
}
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

---

## The Withdrawal Flow (Root Validation)

For withdrawals, we need to verify the proof was generated against a root we actually stored.

---

### 1. Backend Provides the Merkle Proof (READ)

**File:** `backend/src/server.ts` - find `/api/withdraw` endpoint

The backend computes the Merkle proof using the stored tree:

```typescript
// Get the sibling hashes along the path from leaf to root
const proof = merkleTree.getProof(leafIndex)
// proof.siblings = [H1, H34, ...] - 10 hashes
// proof.pathIndices = [0, 1, ...] - which side at each level
```

---

### 2. Program Validates the Root (TYPE)

**File:** `anchor/programs/private_transfers/src/lib.rs`

#### Add root parameter to withdraw

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
        root: [u8; 32],        // The Merkle root the ZK proof was generated against
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

#### Add root validation in withdraw

Find:

```rust
    ) -> Result<()> {
        // Step 3: Check nullifier not used
        // Step 2: Validate root is known

        require!(
            ctx.accounts.recipient.key() == recipient,
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
            ctx.accounts.recipient.key() == recipient,
```

**Why validate the root?**
- The ZK proof says "I know a commitment in a tree with root X"
- We need to verify X is a root WE stored from a real deposit
- Otherwise attackers could generate proofs against fake trees

#### Add error codes

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

---

### Build

```bash
cd anchor
anchor build
```

---

## What Changed

**Deposit flow:**
1. Backend computes new Merkle root after adding commitment
2. Frontend sends commitment + new_root to program
3. Program stores root in ring buffer history
4. Event includes leaf_index so user knows their position

**Withdrawal flow:**
1. User provides the root their proof was generated against
2. Program checks that root exists in history

---

## What's Still Missing

We can now prove a commitment exists. But what stops someone from proving the same deposit multiple times? Nothing yet!

Next step: Prevent double-spending with nullifiers.

Continue to [Step 3: Preventing Double-Spend](./step-3-preventing-double-spend.md).
