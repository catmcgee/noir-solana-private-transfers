# Step 0: Introduction

## Goal

Open the starter code, understand what it does now, and see exactly what we'll be adding.

---

## Open the Starter Code

Open `anchor/programs/private_transfers/src/lib.rs`.

This is a basic escrow-style program. Let's walk through what it does:

### The Constants

```rust
declare_id!("YOUR_PROGRAM_ID");

// TODO (Step 5): Add Sunspot verifier program ID
// TODO (Step 3): Add Merkle tree constants (TREE_DEPTH, ROOT_HISTORY_SIZE)

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000; // 0.001 SOL
```

Right now we just have a minimum deposit. By Step 5, we'll have:
- `SUNSPOT_VERIFIER_ID` - The program that verifies ZK proofs
- `TREE_DEPTH` - How many deposits the Merkle tree holds (2^10 = 1024)
- `ROOT_HISTORY_SIZE` - How many recent roots we keep (10)
- `EMPTY_ROOT` - The root of an empty tree (precomputed)

### The Pool Account

```rust
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub total_deposits: u64,
    // TODO (Step 1): Add next_leaf_index: u64
    // TODO (Step 3): Add current_root_index: u64
    // TODO (Step 3): Add roots: [[u8; 32]; ROOT_HISTORY_SIZE]
}

// TODO (Step 3): Add is_known_root method to Pool
// TODO (Step 2): Add NullifierSet account struct
```

The Pool stores the state of our privacy pool. 

### The Deposit Function

```rust
pub fn deposit(
    ctx: Context<Deposit>,
    // TODO (Step 1): Add commitment: [u8; 32]
    // TODO (Step 3): Add new_root: [u8; 32]
    amount: u64,
) -> Result<()> {
```


### The Deposit Event

```rust
emit!(DepositEvent {
    depositor: ctx.accounts.depositor.key(),  // PROBLEM: Everyone sees who!
    amount,
    timestamp: Clock::get()?.unix_timestamp,
    // TODO (Step 1): Add leaf_index
    // TODO (Step 3): Add new_root
});
```

This is the privacy problem. The event stores `depositor` - anyone can see exactly who deposited. We'll change this to emit `commitment` instead.

### The Withdraw Function

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
    // TODO (Step 5): Verify ZK proof via CPI to Sunspot
    // TODO (Step 2): Mark nullifier as used
```

Withdraw currently just transfers funds.


---

## The Account Structure

Look at the `Initialize`, `Deposit`, and `Withdraw` structs. Notice the PDA patterns:

```rust
// Pool - single instance, seeded by "pool"
#[account(init, seeds = [b"pool"], bump)]
pub pool: Account<'info, Pool>,

// Vault - holds SOL, seeded by "vault" + pool
#[account(seeds = [b"vault", pool.key().as_ref()], bump)]
pub pool_vault: SystemAccount<'info>,
```

We'll add one more:
```rust
// NullifierSet - tracks used nullifiers, seeded by "nullifiers" + pool
#[account(seeds = [b"nullifiers", pool.key().as_ref()], bump)]
pub nullifier_set: Account<'info, NullifierSet>,
```

---

## Run the Frontend

Let's see what the UI looks like:

```bash
# Terminal 1 - Start the backend
cd backend
bun install
bun run dev

# Terminal 2 - Start the frontend
cd frontend
bun install
bun run dev
```

Open `http://localhost:3000`.

You'll see:
- **Connect Wallet** - Links to your Phantom/Solflare
- **Deposit Section** - Enter amount, get a deposit note
- **Withdraw Section** - Paste deposit note, get your funds

The frontend is already wired up to call the backend APIs and build transactions. We just need to add the privacy features to the program.

---

## The Project Structure

```
noir-solana-private-transfers/
├── anchor/                          # Solana program (YOU EDIT THIS)
│   └── programs/private_transfers/
│       └── src/lib.rs
├── circuits/                        # Noir ZK circuits (ALREADY COMPLETE)
│   ├── hasher/                      # Computes commitment hash
│   ├── merkle-hasher/               # Computes Merkle roots
│   └── withdrawal/                  # Main withdrawal proof circuit
├── backend/                         # Proof generation (ALREADY COMPLETE)
│   └── src/
│       ├── deposit.ts               # Generates secrets, commitment
│       └── withdraw.ts              # Generates ZK proof
└── frontend/                        # React UI (ALREADY COMPLETE)
```

**You'll modify:** `anchor/programs/private_transfers/src/lib.rs`

**You'll read (but not modify):** The circuits in `circuits/` and backend in `backend/`

---

## What We're Building

By the end, this program will:

1. **Accept private deposits** - Store commitments, not addresses
2. **Track nullifiers** - Prevent double-spending without revealing which deposit
3. **Store Merkle roots** - Efficiently prove deposits exist
4. **Verify ZK proofs** - Call Sunspot verifier via CPI

The flow:
```
DEPOSIT:
User → Backend (generates secrets, commitment) → Frontend (builds tx) → Program (stores commitment)

WITHDRAW:
User → Backend (generates ZK proof) → Frontend (builds tx) → Program (verifies proof, transfers funds)
```

---

## Build the Program

Make sure the starter code compiles:

```bash
cd anchor
anchor build
```

You should see it compile successfully.

---

## Next Step

Let's start by hiding deposit details with commitments.

Continue to [Step 1: Hiding Deposits](./step-1-hiding-deposits.md).
