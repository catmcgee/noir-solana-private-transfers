# Step 3: Merkle Trees

## Goal

Add Merkle tree root tracking so we can later prove a commitment exists in the pool.

## The Membership Problem

We need to prove that a commitment exists in our pool. With 1000 deposits, how do we do that efficiently?

**Naive approach**: Send all 1000 commitments onchain. That's expensive and Solana transactions have a ~1232 byte limit

**Better approach**: Merkle trees. With a Merkle tree, we can prove membership with just log2(1000) = 10 hashes (320 bytes)

![image](./assets/naive_vs_merkle.png)

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

![image](./assets/merkle_tree.png)

Each leaf is a commitment. Each internal node is the hash of its children. The root summarizes the entire tree.

To prove C1 is in the tree, you provide:

- The sibling H0
- The sibling H23

The verifier computes: `H01 = Hash(H0, H1)`, then `Root = Hash(H01, H23)`

If the computed root matches the known root, the proof is valid. If any value is wrong, the result won't match.

## The Merkle circuit

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

### Compile and test

```bash
cd circuits/withdrawal
nargo compile
nargo test
```

## Program updates

Now add root tracking to the Solana program. You'll store a history of recent roots - this gives users time between generating a proof and submitting the transaction.

### Storing roots onchain

In your escrow, you stored the full state onchain. Here we could store 1000 commitments, but that's a lot, so we store just the **root** - a single 32-byte hash that represents the entire tree.

> 💡 **Solana Design Pattern**: When data is too large for onchain storage, store a hash/root and verify against it. The full data lives offchain (in our case, computed by the backend). This is how something like Light Protocol works.

### Where does the Tree live?

Since we only store the root onchain, how do we get the Merkle information when we withdraw?

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ONCHAIN (Solana)                              │
│  ┌──────────────────┐                                                   │
│  │   Pool Account   │  Only stores:                                     │
│  │   root: 0x1a2b.. │  - Current Merkle root (32 bytes)                 │
│  │   (32 bytes)     │  - Root history (last 10 roots)                   │
│  └──────────────────┘  - Next leaf index                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Events contain commitment + leaf_index
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         OFFCHAIN (A backend or indexer)                 │
│  ┌────────────────────────────────────────────────┐                     │
│  │ Watches DepositEvents and rebuilds full tree:  │                     │
│  │   leaf 0: commitment_0                         │                     │
│  │   leaf 1: commitment_1                         │                     │
│  │   leaf 2: commitment_2                         │                     │
│  │   ...                                          │                     │
│  └────────────────────────────────────────────────┘                     │
│                                                                         │
│  Can compute Merkle proof for any leaf on demand                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            User                                         │
│  Save your "deposit note" containing:                                   │
│  - nullifier (private)                                                  │
│  - secret (private)                                                     │
│  - amount                                                               │
│  - leafIndex                                                            │
│  - merkleRoot                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**The flow:**

1. **At deposit**: You get a `depositNote` containing your secrets + leaf index
2. **Between deposit and withdrawal**: An indexer watches `DepositEvent` logs and maintains the full tree
3. **At withdrawal**: You provide your deposit note, the backend computes your Merkle proof and generates the ZK proof

### Demo Simplification

In the bootcamp, we assume that all other tree leaves are empty (zeros), ie there is only oine deposit. This means the Merkle proof is just pre-computed zero hashes at each level

```typescript
const EMPTY_TREE_ZEROS = [
  "0x00",
  "0x228981b886e5effb2c05a6be7ab4a05fde6bf702a2d039e46c87057dd729ef97",
  // ... more zeros for each level
];
```

In a **production system** you'd need:

- A database storing all commitments
- An indexer watching all deposit events

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

We store the last 10 roots in a **fixed-size array** (ring buffer pattern).

> 💡 **Solana Reminder**: Why fixed `[_; 10]` instead of `Vec`? Account size is fixed at creation. A ring buffer with fixed size is a common pattern when you need "recent history" without resizing. We overwrite the oldest entry.

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
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,              // Who initialized the pool
    pub next_leaf_index: u64,           // Next available slot in Merkle tree
    pub total_deposits: u64,            // Count of all deposits
    pub current_root_index: u64,        // Points to newest root in ring buffer
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],  // Fixed-size array (not Vec!)
    // Ring buffer pattern: new roots overwrite oldest ones
    // Account size is fixed at creation - can't grow!
}

impl Pool {
    // Check if a root is in our recent history
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
    pub timestamp: i64,
    // new_root will be added in Step 3
```

Replace with:

```rust
#[event]  // Anchor event - gets emitted to program logs
pub struct DepositEvent {
    pub commitment: [u8; 32],  // The deposit commitment hash
    pub leaf_index: u64,       // Position in the Merkle tree
    pub timestamp: i64,        // From Clock::get()?.unix_timestamp
    pub new_root: [u8; 32],    // New Merkle root after this deposit
    // Indexers watch these events to reconstruct the tree offchain
}
```

### 8. Emit new_root in deposit event

Find the emit! block and update to include new_root:

```rust
        emit!(DepositEvent {
            commitment,
            leaf_index,                              // Set earlier in function
            timestamp: Clock::get()?.unix_timestamp, // Solana Clock sysvar
            new_root,                                // The updated Merkle root
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

When someone deposits, they compute the new root offchain and submit it. We store the last 10 roots in a ring buffer.

We keep multiple roots because a user might start generating a proof when the root is X, but by the time they submit, someone else deposited and the root is Y. With a history, their proof against root X still works. Solana moves fast :)

## Client Computes Roots

You might wonder: why trust the client to compute the correct `new_root`?

The answer: if the client submits an invalid root, any withdrawal proof against that root will fail. Invalid roots are pointless.

## The Next Problem

The Merkle proof itself reveals which commitment is ours. If I prove commitment at index 5, everyone knows I made deposit #5.

We need to hide the Merkle proof inside a zero-knowledge proof. That's what we do next!

## Key Concepts

| Concept      | Description                                               |
| ------------ | --------------------------------------------------------- |
| Merkle Tree  | Data structure for efficient membership proofs            |
| Root         | Single hash summarizing entire tree                       |
| Proof        | O(log n) sibling hashes to verify membership              |
| Root History | Buffer for timing between proof generation and submission |

## Next Step

Continue to [Step 4: ZK Circuits](./step-4-zk-circuits.md).
