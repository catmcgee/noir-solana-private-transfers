# Step 1: Commitments

## Goal

Replace the public depositor address with a cryptographic commitment that hides all deposit details.

## Understanding Commitments

The first step to privacy is hiding WHO deposited. Instead of storing "Alice deposited 1 SOL", we store a commitment.

A commitment is a hash:

```
commitment = Hash(nullifier, secret, amount)
```

The `nullifier` and `secret` are random values the user generates. Only they know these values.

**Key property**: given the commitment hash, you CANNOT reverse-engineer the inputs. It's a one-way function.

## The Hasher Circuit

Open `circuits/hasher/src/main.nr` to see the Noir circuit that computes commitments:

```noir
fn main(nullifier: Field, secret: Field, amount: Field) -> pub (Field, Field) {
    let commitment = poseidon2::bn254::hash_3([nullifier, secret, amount]);
    let nullifier_hash = poseidon2::bn254::hash_1([nullifier]);
    (commitment, nullifier_hash)
}
```

This circuit:
- Takes three inputs: `nullifier`, `secret`, and `amount`
- Computes two hashes using Poseidon (a ZK-friendly hash function)
- Returns the `commitment` (hides all three values) and `nullifier_hash` (used later for double-spend prevention)

**Why Poseidon?** It's efficient to prove in ZK circuits - thousands of times faster than SHA256.

### Compile and Test the Circuit

```bash
cd circuits/hasher
nargo compile
nargo test
```

## Update the Solana Program

Now update the Solana program to use commitments instead of public addresses.

### 1. Update the deposit function signature

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
        commitment: [u8; 32],
        amount: u64,
    ) -> Result<()> {
```

### 2. Add next_leaf_index to Pool struct

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
    pub next_leaf_index: u64,
```

### 3. Update the DepositEvent

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
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub amount: u64,
    pub timestamp: i64,
```

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
        emit!(DepositEvent {
            commitment,
            leaf_index: pool.next_leaf_index,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        pool.next_leaf_index += 1;
        pool.total_deposits += 1;
```

### 5. Initialize next_leaf_index in initialize

Find:

```rust
        pool.total_deposits = 0;

        // TODO (Step 3): Initialize root history
```

Replace with:

```rust
        pool.total_deposits = 0;
        pool.next_leaf_index = 0;
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

## What Changed

Before, the deposit event showed:
```
{ depositor: "Alice's_public_key", amount: 1000000 }
```

Now it shows:
```
{ commitment: "0x7a3b...", leaf_index: 0, amount: 1000000 }
```

The depositor's identity is completely hidden. The only way to know who made a deposit is to know the `nullifier` and `secret` that produce that commitment.

## Deposit Notes

When a user deposits, they save their `nullifier`, `secret`, and `amount` locally - this is called a **deposit note**. It's like a receipt they need to withdraw later.

**Critical**: If they lose this note, the funds are lost forever.

## The Next Problem

How do we withdraw? We can't just say "I want to withdraw commitment X" - that would reveal which deposit is ours.

We need a way to prove we know a valid commitment WITHOUT revealing which one. That's where nullifiers come in.

## Key Concepts

| Concept | Description |
|---------|-------------|
| Commitment | `Hash(nullifier, secret, amount)` - one-way function |
| Poseidon | ZK-friendly hash function |
| Deposit Note | User's receipt containing nullifier, secret, amount |

## Next Step

Continue to [Step 2: Nullifiers](./step-2-nullifiers.md).
