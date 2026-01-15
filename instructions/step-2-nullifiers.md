# Step 2: Nullifiers

## Goal

Add nullifier tracking to prevent double-spending without revealing which deposit is being spent.

## The Double-Spend Problem

If someone deposits 1 SOL, how do we prevent them from withdrawing it twice?

In a normal system, you'd mark the deposit as "spent". But we can't do that here - if we mark "commitment X was spent", everyone knows that's the one being withdrawn. Privacy gone.

## The Solution: Nullifiers

Here's how it works:

1. When you deposit, you choose a random `nullifier`
2. When you withdraw, you reveal the HASH of that nullifier - the `nullifier_hash`
3. We track used `nullifier_hash` values

**Key insight**: The SAME nullifier ALWAYS produces the SAME hash. So if you try to withdraw twice with the same deposit, you'll submit the same `nullifier_hash` twice, and we reject the second one.

**Privacy preserved**: Observers can't link the `nullifier_hash` back to the original commitment. They're computed from different inputs:
- `commitment = Hash(nullifier, secret, amount)`
- `nullifier_hash = Hash(nullifier)`

Without knowing the `nullifier`, you can't link these.

## Update the Solana Program

### 1. Add NullifierSet struct

In `lib.rs`, find:

```rust
// TODO (Step 3): Add is_known_root method to Pool
// TODO (Step 2): Add NullifierSet account struct
```

Replace with:

```rust
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
```

### 2. Add NullifierSet to Initialize accounts

Find:

```rust
    pub pool: Account<'info, Pool>,

    // TODO (Step 2): Add NullifierSet account

    /// CHECK: PDA validated by seeds
```

Replace with:

```rust
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = authority,
        space = 8 + NullifierSet::INIT_SPACE,
        seeds = [b"nullifiers", pool.key().as_ref()],
        bump
    )]
    pub nullifier_set: Account<'info, NullifierSet>,

    /// CHECK: PDA validated by seeds
```

### 3. Initialize nullifier_set in initialize function

Find:

```rust
        pool.next_leaf_index = 0;

        msg!("Pool initialized");
```

Replace with:

```rust
        pool.next_leaf_index = 0;

        let nullifier_set = &mut ctx.accounts.nullifier_set;
        nullifier_set.pool = pool.key();

        msg!("Pool initialized");
```

### 4. Add NullifierSet to Withdraw accounts

Find:

```rust
    pub pool: Account<'info, Pool>,

    // TODO (Step 2): Add NullifierSet account

    /// CHECK: PDA validated by seeds
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
```

Replace with:

```rust
    #[account(mut, seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [b"nullifiers", pool.key().as_ref()], bump)]
    pub nullifier_set: Account<'info, NullifierSet>,

    /// CHECK: PDA validated by seeds
    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
```

Note: Also adding `mut` to the pool account for later modifications.

### 5. Update withdraw function signature

Find:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // TODO (Step 5): Add proof: Vec<u8>
        // TODO (Step 2): Add nullifier_hash: [u8; 32]
        // TODO (Step 3): Add root: [u8; 32]
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
        // TODO (Step 2): Check nullifier not used
        // TODO (Step 3): Validate root is known
```

Replace with:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        nullifier_hash: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
        let nullifier_set = &mut ctx.accounts.nullifier_set;

        // Check nullifier hasn't been used (prevents double-spend)
        require!(
            !nullifier_set.is_nullifier_used(&nullifier_hash),
            PrivateTransfersError::NullifierUsed
        );
```

### 6. Mark nullifier as used before transfer

Find:

```rust
        // TODO (Step 5): Verify ZK proof via CPI to Sunspot
        // TODO (Step 2): Mark nullifier as used

        // Transfer SOL from vault to recipient
```

Replace with:

```rust
        // Mark nullifier as used (prevents double-spend)
        nullifier_set.mark_nullifier_used(nullifier_hash)?;

        // Transfer SOL from vault to recipient
```

### 7. Update WithdrawEvent

Find:

```rust
pub struct WithdrawEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    // TODO (Step 2): Add nullifier_hash: [u8; 32]
}
```

Replace with:

```rust
pub struct WithdrawEvent {
    pub nullifier_hash: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
```

### 8. Update the emit! in withdraw

Find:

```rust
        // PROBLEM: Everyone can see who withdrew!
        emit!(WithdrawEvent {
            recipient: ctx.accounts.recipient.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
            // TODO (Step 2): Add nullifier_hash
        });
```

Replace with:

```rust
        emit!(WithdrawEvent {
            nullifier_hash,
            recipient: ctx.accounts.recipient.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
```

### 9. Add error codes

Find:

```rust
    #[msg("Insufficient vault balance for withdrawal")]
    InsufficientVaultBalance,
    // TODO (Step 1): Add TreeFull
    // TODO (Step 2): Add NullifierUsed, NullifierSetFull
```

Replace with:

```rust
    #[msg("Insufficient vault balance for withdrawal")]
    InsufficientVaultBalance,
    #[msg("Nullifier has already been used")]
    NullifierUsed,
    #[msg("Nullifier set is full")]
    NullifierSetFull,
```

### Build

```bash
anchor build
```

## How It Works

Let's trace through what happens:

1. **Alice deposits** - the commitment goes on-chain
2. **Later, Alice withdraws** - she submits a `nullifier_hash`
3. **We check**: has this `nullifier_hash` been used before? No? Continue.
4. **We mark** the `nullifier_hash` as used
5. **Alice gets her funds**

If Alice tries to withdraw again with the same deposit note, she'll submit the SAME `nullifier_hash`, and we reject it.

## Privacy Analysis

| What observers see | Can they link them? |
|-------------------|---------------------|
| Deposit: `commitment = 0x7a3b...` | No - different hash inputs |
| Withdraw: `nullifier_hash = 0x9c2f...` | |

Without knowing the original `nullifier`, there's no way to connect the commitment and nullifier_hash.

## The Next Problem

Right now, ANYONE could submit ANY random `nullifier_hash` and withdraw! We're not actually verifying that the person knows a valid deposit.

We need to prove: "I know a commitment in this pool, and this `nullifier_hash` corresponds to it."

That's where Merkle trees and ZK proofs come in.

## Key Concepts

| Concept | Description |
|---------|-------------|
| Nullifier | Random secret chosen at deposit time |
| Nullifier Hash | `Hash(nullifier)` - revealed at withdrawal |
| Double-spend Prevention | Same nullifier → same hash → rejected |

## Next Step

Continue to [Step 3: Merkle Trees](./step-3-merkle-trees.md).
