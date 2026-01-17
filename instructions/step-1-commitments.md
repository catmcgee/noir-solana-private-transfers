# Step 1: Commitments

## Goal

Replace the public depositor address with a cryptographic commitment that hides all deposit details.

## Escrow vs Private Pool

In your escrow, the `Escrow` account stored the maker's pubkey:

```rust
pub struct Escrow {
    pub maker: Pubkey,  // public
    pub amount: u64,
}
```

In our private pool, we'll store a **commitment** instead - a hash that hides the depositor's identity:

```rust
// Private pool stores a hash - no identity revealed
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub amount: u64,
}
```

## What are commitments?

Commitment is the word ZK people use to describe an entry into storage, and is simply a hash:

```
commitment = Hash(nullifier, secret, amount)
```

The `nullifier` and `secret` are random values the user generates locally. Only they know these values - they're never sent to Solana.

Given the commitment hash, you can't reverse-engineer the inputs.

## The hasher circuit

In this example, our circuit hashes our commitment.

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
- Returns the `commitment` (hides all three values) and `nullifier_hash` (used later for double-spend prevention - we learn about this in the next step)

![image](./assets/posiedon_hash.png)

### Why not hash onchain?

All Solana transaction data is public. If we called `hash(nullifier, secret, amount)` onchain, everyone would see the inputs.

The whole point of commitments is to hide these values. Hashing onchain defeats the point.

Hash offchain, submit only the result

![image](./assets/offchain_vs_onchain.png)

```
Client (private):           Solana (public):
nullifier = 12345...   →    commitment = 0x7a3b...  ← Only this is visible
secret = 67890...
amount = 1000000
         ↓
commitment = Poseidon2(nullifier, secret, amount)
```

The client computes the hash locally using Noir, then submits just the 32-byte commitment. The private inputs never touch the blockchain.

This is safe because:

1. If the client computes a wrong commitment, their withdrawal proof won't work
2. The ZK proof verifies the hash was computed correctly (without revealing inputs)

### When would you hash onchain?

Solana Poseidon exists and is useful - just not for private data.

**ZK for scalability, not just privacy**

ZK proofs aren't only about hiding information - they're also used to make data smaller. For example, [Light Protocol](https://github.com/Lightprotocol/light-protocol) uses ZK and onchain Poseidon hashing for compressed accounts. They call this ZKCompression..

```
Regular Solana account:     Compressed account:
┌─────────────────────┐     ┌─────────────────────┐
│ owner: 32 bytes     │     │                     │
│ balance: 8 bytes    │ →   │ root: 32 bytes      │  (Merkle root of many accounts)
│ data: 100+ bytes    │     │                     │
│ rent: paid per byte │     └─────────────────────┘
└─────────────────────┘
        140+ bytes                  32 bytes
```

Instead of storing full account data onchain, Light Protocol stores a Merkle root. The actual data lives offchain, and ZK proofs verify state transitions. This cuts storage costs by 1000x+ for things like airdrops and NFT mints.

In this case, hashing onchain is fine because the data (addresses, balances) is public anyway.

### The Poseidon Syscall

> 💡 **What's a syscall?** A syscall (system call) is a pre-compiled function built into the Solana runtime - like `sol_sha256` for SHA256 hashing. Syscalls are much faster and cheaper than implementing the same logic in your program because they run as native code, not BPF bytecode.

There's a `sol_poseidon` syscall that makes onchain Poseidon cheap, but it's only active on **testnet** - not yet on devnet or mainnet. And it uses original Poseidon, not Poseidon2.

### Compile and test the circuit

```bash
cd circuits/hasher
nargo compile
nargo test
```

## Update program to use commitments

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

We need to track which "slot" in our Merkle tree the next deposit goes into.

> 💡 **Solana Reminder**: Adding fields to an account increases its size. With `#[derive(InitSpace)]`, Anchor calculates this automatically.

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
    pub commitment: [u8; 32],  // The hash hiding nullifier, secret, and amount
    pub leaf_index: u64,       // Position in the Merkle tree (0, 1, 2, ...)
    pub timestamp: i64,        // When the deposit occurred (Unix timestamp)
    // new_root will be added in Step 3
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
        // Store the current leaf index before incrementing
        let leaf_index = pool.next_leaf_index;

        // Emit event with commitment instead of depositor address
        emit!(DepositEvent {
            commitment,                              // The hash - no identity revealed!
            leaf_index,                              // Which slot in the tree
            timestamp: Clock::get()?.unix_timestamp, // Current time
            // new_root will be added in Step 3
        });

        pool.next_leaf_index += 1;  // Move to next slot for future deposits
        pool.total_deposits += 1;   // Track total number of deposits
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

![image](./assets/before_after_privacy_explorer.png)

## Deposit Notes

When a user deposits, they save their `nullifier`, `secret`, and `amount` locally - this is called a **deposit note**. It's like a receipt they need to withdraw later. If they lose this note, the funds are lost forever.

![image](./assets/deposit_note.png)

## Withdrawals

How do we withdraw? We can't just say "I want to withdraw commitment X" - that would reveal which deposit is ours.

We need a way to prove we know a valid commitment without revealing which one. That's where nullifiers come in.

## What we learned in this step

| Concept      | Description                                          |
| ------------ | ---------------------------------------------------- |
| Commitment   | `Hash(nullifier, secret, amount)` - one-way function |
| Poseidon     | ZK-friendly hash function                            |
| Deposit Note | User's receipt containing nullifier, secret, amount  |

## Next Step

Continue to [Step 2: Nullifiers](./step-2-nullifiers.md).
