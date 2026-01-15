# Step 3: Merkle Trees

## Goal

Add Merkle tree root tracking so we can later prove a commitment exists in the pool.

## The Membership Problem

We need to prove that a commitment exists in our pool. With 1000 deposits, how do we do that efficiently?

**Naive approach**: Send all 1000 commitments. That's expensive and slow.

**Better approach**: Merkle trees. With a Merkle tree, we can prove membership with just log2(1000) = 10 hashes.

## How Merkle Trees Work

```
                    Root
                   /    \
                 H01     H23
                /  \    /   \
              H0   H1  H2   H3
              |    |   |    |
              C0   C1  C2   C3  (commitments)
```

Each leaf is a commitment. Each internal node is the hash of its children. The root summarizes the entire tree.

To prove C1 is in the tree, you provide:
- The sibling H0
- The sibling H23

The verifier computes: `H01 = Hash(H0, H1)`, then `Root = Hash(H01, H23)`

If the computed root matches the known root, the proof is valid. If ANY value is wrong, the result won't match.

## The Merkle Circuit

Open `circuits/withdrawal/src/merkle_tree.nr` to see the implementation:

```noir
pub fn compute_merkle_root<let DEPTH: u32>(
    leaf: Field,
    path: [Field; DEPTH],
    is_even: [bool; DEPTH]
) -> Field {
    let mut current = leaf;
    for i in 0..DEPTH {
        let sibling = path[i];
        let (left, right) = if is_even[i] {
            (current, sibling)
        } else {
            (sibling, current)
        };
        current = poseidon2::bn254::hash_2([left, right]);
    }
    current
}
```

This function:
- Takes a leaf (the commitment) and a path of sibling hashes
- Walks up the tree, hashing at each level
- The `is_even` array indicates whether we're on the left or right at each level
- Returns the computed root

### Compile and Test

```bash
cd circuits/withdrawal
nargo compile
nargo test
```

## Update the Solana Program

Now add root tracking to the Solana program. You'll store a history of recent roots - this gives users time between generating a proof and submitting the transaction.

### 1. Add constants at the top

In `lib.rs`, find:

```rust
// TODO (Step 5): Add Sunspot verifier program ID
// TODO (Step 3): Add Merkle tree constants (TREE_DEPTH, ROOT_HISTORY_SIZE)

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

Replace with:

```rust
pub const TREE_DEPTH: usize = 10;
pub const MAX_LEAVES: u64 = 1 << TREE_DEPTH; // 1024
pub const ROOT_HISTORY_SIZE: usize = 10;

// Empty tree root (precomputed)
pub const EMPTY_ROOT: [u8; 32] = [
    0x2c, 0xb2, 0x57, 0x0a, 0x37, 0x3a, 0x05, 0x5f,
    0x49, 0x3d, 0xc4, 0xf1, 0x14, 0x5b, 0x27, 0x61,
    0x62, 0x3e, 0x59, 0x12, 0x42, 0x08, 0x3b, 0x38,
    0x21, 0xaa, 0x3b, 0x48, 0x9d, 0x15, 0x3c, 0x06,
];

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

### 2. Update Pool struct

Find:

```rust
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    pub next_leaf_index: u64,
    // TODO (Step 3): Add current_root_index: u64
    // TODO (Step 3): Add roots: [[u8; 32]; ROOT_HISTORY_SIZE]
}

// TODO (Step 3): Add is_known_root method to Pool
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

### 3. Initialize root history

Find:

```rust
        pool.next_leaf_index = 0;

        let nullifier_set = &mut ctx.accounts.nullifier_set;
```

Replace with:

```rust
        pool.next_leaf_index = 0;
        pool.current_root_index = 0;
        pool.roots[0] = EMPTY_ROOT;

        let nullifier_set = &mut ctx.accounts.nullifier_set;
```

### 4. Update deposit function signature

Find:

```rust
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],
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

### 5. Add tree full check

After the `MIN_DEPOSIT_AMOUNT` check, find:

```rust
        require!(
            amount >= MIN_DEPOSIT_AMOUNT,
            PrivateTransfersError::DepositTooSmall
        );

        // Transfer SOL from depositor to vault
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

        // Transfer SOL from depositor to vault
```

### 6. Update root history after transfer

Find:

```rust
        )?;

        emit!(DepositEvent {
```

Replace with:

```rust
        )?;

        // Update Merkle root history (ring buffer)
        let new_root_index = ((pool.current_root_index + 1) % ROOT_HISTORY_SIZE as u64) as usize;
        pool.roots[new_root_index] = new_root;
        pool.current_root_index = new_root_index as u64;

        emit!(DepositEvent {
```

### 7. Add new_root to DepositEvent

Find:

```rust
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub amount: u64,
    pub timestamp: i64,
```

Replace with:

```rust
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub amount: u64,
    pub timestamp: i64,
    pub new_root: [u8; 32],
```

### 8. Emit new_root in deposit event

Find:

```rust
        emit!(DepositEvent {
            commitment,
            leaf_index: pool.next_leaf_index,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
```

Replace with:

```rust
        emit!(DepositEvent {
            commitment,
            leaf_index: pool.next_leaf_index,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            new_root,
        });
```

### 9. Add root parameter to withdraw

Find:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        nullifier_hash: [u8; 32],
        root: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

### 10. Add root validation in withdraw

After the nullifier check, find:

```rust
            PrivateTransfersError::NullifierUsed
        );

        // Prevents front-running by binding to recipient
```

Replace with:

```rust
            PrivateTransfersError::NullifierUsed
        );

        // Validate the root exists in our history
        require!(
            ctx.accounts.pool.is_known_root(&root),
            PrivateTransfersError::InvalidRoot
        );

        // Prevents front-running by binding to recipient
```

### 11. Add error codes

Find:

```rust
    #[msg("Nullifier set is full")]
    NullifierSetFull,
    // TODO (Step 3): Add InvalidRoot
```

Replace with:

```rust
    #[msg("Nullifier set is full")]
    NullifierSetFull,
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Unknown Merkle root")]
    InvalidRoot,
```

### Build

```bash
anchor build
```

## Why Root History?

When someone deposits, they compute the new root off-chain and submit it. We store the last 10 roots in a ring buffer.

Why keep multiple roots? **Timing**. A user might start generating a proof when the root is X, but by the time they submit, someone else deposited and the root is Y. With a history, their proof against root X still works.

## Client Computes Roots

You might wonder: why trust the client to compute the correct `new_root`?

The answer: if the client submits an invalid root, any withdrawal proof against that root will fail. Invalid roots don't help an attacker - they only hurt themselves.

## The Next Problem

The Merkle proof ITSELF reveals which commitment is ours. If I prove commitment at index 5, everyone knows I made deposit #5.

We need to HIDE the Merkle proof inside a zero-knowledge proof. That's the final piece.

## Key Concepts

| Concept | Description |
|---------|-------------|
| Merkle Tree | Data structure for efficient membership proofs |
| Root | Single hash summarizing entire tree |
| Proof | O(log n) sibling hashes to verify membership |
| Root History | Buffer for timing between proof generation and submission |

## Next Step

Continue to [Step 4: ZK Circuits](./step-4-zk-circuits.md).
