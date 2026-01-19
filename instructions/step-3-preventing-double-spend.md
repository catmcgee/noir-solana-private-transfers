# Step 3: Preventing Double-Spend

## Goal

Add nullifier tracking to prevent double-spending without revealing which deposit is being spent.

## Where We Are

```
✅ Step 0: Understand the architecture
✅ Step 1: Hide deposit details
✅ Step 2: Prove membership
🔲 Step 3: Prevent double-spending  ← You are here
🔲 Step 4: The ZK circuit
🔲 Step 5: On-chain verification
```

---

## The Flow

Here's how nullifiers fit into the withdrawal flow:

```
USER WITHDRAWS:
1. User pastes their deposit note (contains nullifier, secret, amount)
2. Backend computes nullifier_hash = Hash(nullifier)
3. Backend generates ZK proof (Step 4-5)
4. Frontend sends transaction with nullifier_hash
5. Program checks: is this nullifier_hash already used?        <-- We add this
6. If not used, mark it as used and transfer funds             <-- We add this
7. If used, reject (double-spend attempt)
```

The nullifier_hash is revealed on-chain, but it can't be linked back to the original commitment because they're computed from different inputs.

---

## Program Updates

### 1. Add NullifierSet struct

We need storage for used nullifier hashes. We'll use a Vec inside a PDA.

In `lib.rs`, find after the Pool impl block:

```rust
impl Pool {
    // Check if a root exists in our recent history
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

#[event]
```

Replace with:

```rust
impl Pool {
    // Check if a root exists in our recent history
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

#[account]
#[derive(InitSpace)]
pub struct NullifierSet {
    pub pool: Pubkey,
    #[max_len(256)]
    pub nullifiers: Vec<[u8; 32]>,
}

impl NullifierSet {
    pub fn is_nullifier_used(&self, nullifier_hash: &[u8; 32]) -> bool {
        self.nullifiers.contains(nullifier_hash)
    }

    pub fn mark_nullifier_used(&mut self, nullifier_hash: [u8; 32]) -> Result<()> {
        require!(
            self.nullifiers.len() < 256,
            PrivateTransfersError::NullifierSetFull
        );
        self.nullifiers.push(nullifier_hash);
        Ok(())
    }
}

#[event]
```

**What each part does:**

- `#[account]` - Marks this as a Solana account struct that Anchor can serialize/deserialize
- `#[derive(InitSpace)]` - Anchor calculates account size automatically
- `#[max_len(256)]` - Tells Anchor the Vec won't exceed 256 items (needed for space calculation)
- `pub pool: Pubkey` - Links this nullifier set to a specific pool
- `is_nullifier_used()` - O(n) scan through the list. Fine for 256 items.
- `mark_nullifier_used()` - Adds the hash to the list after checking capacity

### 2. Add NullifierSet to Initialize accounts

The NullifierSet is a PDA derived from the pool address. This ensures each pool has exactly one nullifier set.

Find:

```rust
    pub pool: Account<'info, Pool>,

    // Step 3: Add nullifier_set account here

    #[account(seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

Replace with:

```rust
    pub pool: Account<'info, Pool>,

    #[account(
        init,                                    // Create new account
        payer = authority,                       // Authority pays rent
        space = 8 + NullifierSet::INIT_SPACE,   // 8-byte discriminator + struct size
        seeds = [b"nullifiers", pool.key().as_ref()],  // PDA seeds
        bump
    )]
    pub nullifier_set: Account<'info, NullifierSet>,

    #[account(seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

**What each attribute does:**

- `init` - Creates a new account (only works once)
- `payer = authority` - Who pays the rent (SOL for storage)
- `space = 8 + ...` - Total account size. 8 bytes for Anchor's discriminator.
- `seeds = [...]` - PDA derivation. Anyone can compute this address from the seeds.
- `bump` - Anchor finds the valid PDA bump automatically

### 3. Initialize nullifier_set in initialize function

Find:

```rust
        pool.roots[0] = EMPTY_ROOT;    // Start with empty tree root

        msg!("Pool initialized");
```

Replace with:

```rust
        pool.roots[0] = EMPTY_ROOT;    // Start with empty tree root

        // Initialize the nullifier set
        let nullifier_set = &mut ctx.accounts.nullifier_set;
        nullifier_set.pool = pool.key();

        msg!("Pool initialized");
```

### 4. Add NullifierSet to Withdraw accounts

Find:

```rust
    #[account(seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,

    // Step 3: Add nullifier_set account here

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

Replace with:

```rust
    #[account(mut, seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [b"nullifiers", pool.key().as_ref()], bump)]
    pub nullifier_set: Account<'info, NullifierSet>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

### 5. Update withdraw function signature

The withdrawal now needs to include the nullifier hash.

Find:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // Step 5: Add proof: Vec<u8>
        // Step 3: Add nullifier_hash: [u8; 32]
        root: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
        // Step 3: Check nullifier not used

        // Verify the root exists in our history
        require!(
```

Replace with:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // Step 5: Add proof: Vec<u8>
        nullifier_hash: [u8; 32],
        root: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
        let nullifier_set = &mut ctx.accounts.nullifier_set;

        // Check this nullifier hasn't been used before
        require!(
            !nullifier_set.is_nullifier_used(&nullifier_hash),
            PrivateTransfersError::NullifierUsed
        );

        // Verify the root exists in our history
        require!(
```

**Why check first?** If we marked it used before transferring and the transfer failed, the nullifier would be "spent" but the user wouldn't have their funds. Checking first is safer.

### 6. Mark nullifier as used before transfer

Find:

```rust
        // Step 5: Verify ZK proof via CPI
        // Step 3: Mark nullifier as used

        let pool_key = ctx.accounts.pool.key();
```

Replace with:

```rust
        // Step 5: Verify ZK proof via CPI

        // Mark nullifier as used BEFORE transfer (prevents reentrancy)
        nullifier_set.mark_nullifier_used(nullifier_hash)?;

        let pool_key = ctx.accounts.pool.key();
```

**Why before transfer?** This is a security pattern. If we marked it after the transfer and the transfer somehow re-entered our program, the nullifier wouldn't be marked yet.

### 7. Update WithdrawEvent

Find:

```rust
#[event]
pub struct WithdrawEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    // Step 3: Replace amount with nullifier_hash: [u8; 32]
}
```

Replace with:

```rust
#[event]
pub struct WithdrawEvent {
    pub nullifier_hash: [u8; 32],
    pub recipient: Pubkey,
    pub timestamp: i64,
}
```

**Why include nullifier_hash?** Indexers can use this to track which withdrawals have happened, and users can verify their withdrawal succeeded by matching the hash.

### 8. Update the emit! in withdraw

Find:

```rust
        emit!(WithdrawEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // Step 3: Replace amount with nullifier_hash
        });
```

Replace with:

```rust
        emit!(WithdrawEvent {
            nullifier_hash,
            recipient: ctx.accounts.recipient.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
```

### 9. Add error codes

Find:

```rust
    #[msg("Unknown Merkle root")]
    InvalidRoot,
```

Add after it:

```rust
    #[msg("Nullifier has already been used")]
    NullifierUsed,
    #[msg("Nullifier set is full")]
    NullifierSetFull,
```

### Build

```bash
anchor build
```

---

## What Changed

Now when someone withdraws:

1. They submit a nullifier_hash
2. We check if it's in our list of used hashes
3. If used: reject (double-spend attempt)
4. If not used: add to list and proceed

The nullifier_hash can't be linked to the original commitment - they're computed from different inputs.

---

## What's Still Missing

We can prove membership (Step 2) and prevent double-spending (Step 3). But the Merkle proof reveals which commitment is ours - everyone can see which deposit we're withdrawing.

We need to hide everything inside a zero-knowledge proof.

Next step: The ZK circuit that proves everything without revealing anything.

Continue to [Step 4: The ZK Circuit](./step-4-zk-circuit.md).
