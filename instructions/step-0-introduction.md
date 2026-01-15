# Step 0: Introduction

## The Problem

Look at any Solana transaction on the explorer. You can see:
- Who sent it
- Who received it
- How much was transferred
- When it happened

This is great for transparency, but terrible for privacy. Every financial transaction you make is permanently visible to the entire world.

## What You're Building

A privacy pool that breaks the link between deposits and withdrawals:

```
BEFORE (Public):
Alice deposits 1 SOL  ──────────────────►  Alice withdraws 1 SOL
     │                                            │
     └──── LINKED (everyone can see) ─────────────┘

AFTER (Private):
Alice deposits  ────►  [Pool]  ────►  ??? withdraws
Bob deposits    ────►  [Pool]  ────►  ??? withdraws
Carol deposits  ────►  [Pool]  ────►  ??? withdraws

No one can link deposits to withdrawals!
```

## The Starter Code

The starter code implements a basic SOL pool with **zero privacy**. Let's verify it works.

### Build and Test

```bash
cd anchor
anchor build
anchor test
```

You should see the program compile and tests pass.

### Examine the Code

Open `anchor/programs/private_transfers/src/lib.rs`. Notice the current deposit function:

```rust
pub fn deposit(
    ctx: Context<Deposit>,
    amount: u64,
) -> Result<()> {
    // ...
    emit!(DepositEvent {
        depositor: ctx.accounts.depositor.key(),  // Everyone sees WHO deposited
        amount,                                    // Everyone sees HOW MUCH
    });
    Ok(())
}
```

And the withdraw function:

```rust
pub fn withdraw(
    ctx: Context<Withdraw>,
    recipient: Pubkey,
    amount: u64,
) -> Result<()> {
    // ...
    emit!(WithdrawEvent {
        recipient: ctx.accounts.recipient.key(),  // Everyone sees WHO withdrew
        amount,
    });
    Ok(())
}
```

**The problem is obvious**: deposits and withdrawals are fully transparent. Anyone watching the blockchain can see exactly who deposited and who withdrew.

## The Privacy Journey

Over the next steps, you'll transform this public pool into a private one:

| Step | What You'll Add | Problem It Solves |
|------|----------------|-------------------|
| 1 | Commitments | Hide deposit details |
| 2 | Nullifiers | Prevent double-spend without revealing which deposit |
| 3 | Merkle Trees | Efficiently prove deposit exists |
| 4 | ZK Circuits | Prove everything without revealing anything |
| 5 | On-chain Verification | Trustlessly verify proofs on Solana |

## Key Insight

The magic of zero-knowledge proofs is that you can prove a statement is true WITHOUT revealing the data that makes it true.

For example, you'll be able to prove:
- "I made a valid deposit" without revealing which deposit
- "This nullifier hasn't been used" without revealing which commitment it's for
- "My commitment is in the Merkle tree" without revealing where

## Next Step

Continue to [Step 1: Commitments](./step-1-commitments.md).
