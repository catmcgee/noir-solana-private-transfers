# Step 3: Preventing Double-Spend

## Goal

Add nullifier tracking to prevent double-spending without revealing which deposit is being spent.

---

## The Concept

We can prove a deposit exists (Step 2), but what stops someone from withdrawing the same deposit twice? **Nullifiers**.

Here's the problem: If we stored "this commitment was spent", anyone could link the deposit to the withdrawal. Instead, we use a different hash:

```
At deposit:     commitment = Hash(nullifier, secret, amount)  ← stored on-chain
At withdrawal:  nullifier_hash = Hash(nullifier)              ← revealed on-chain
```

These two hashes can't be linked:
- Knowing `nullifier_hash` doesn't reveal `commitment` (missing `secret` and `amount`)
- Knowing `commitment` doesn't reveal `nullifier_hash` (hash is one-way)
- The ZK proof verifies they share the same `nullifier` without revealing it

The program stores all used `nullifier_hash` values. If someone tries to spend the same deposit twice, the same `nullifier_hash` appears → rejected.

---

## The Withdrawal Flow (With Nullifiers)

Let's trace how nullifiers fit into the withdrawal:

---

### 1. User Pastes Their Deposit Note (READ)

**File:** `frontend/src/components/WithdrawSection.tsx` - find `handleWithdraw`

When withdrawing, the user pastes their deposit note (saved from Step 1):

```typescript
const handleWithdraw = async () => {
  // Parse the deposit note the user saved during deposit
  const note = JSON.parse(depositNote)
  // note contains: { nullifier, secret, amount, commitment, nullifierHash, merkleRoot, leafIndex }
```

The `nullifier` is a secret random number generated at deposit time. The user never reveals it directly - instead, they reveal its hash.

---

### 2. Frontend Sends Nullifier Hash to Backend (READ)

**File:** `frontend/src/components/WithdrawSection.tsx`

The frontend calls the backend to generate a ZK proof:

```typescript
  // Request proof generation from backend
  const proofResponse = await fetch(`${API_URL}/api/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nullifier: note.nullifier,      // Secret - only backend sees this
      secret: note.secret,            // Secret - only backend sees this
      amount: note.amount,
      leafIndex: note.leafIndex,
      recipient: recipientAddress     // Who will receive the funds
    })
  })
```

---

### 3. Backend Computes Nullifier Hash (READ)

**File:** `backend/src/server.ts` - find `/api/withdraw` endpoint

The backend computes the nullifier hash (which will be revealed on-chain):

```typescript
app.post("/api/withdraw", async (req, res) => {
  const { nullifier, secret, amount, leafIndex, recipient } = req.body

  // Compute nullifier_hash = Hash(nullifier)
  // This is what gets revealed on-chain to prevent double-spend
  const nullifierHash = poseidon2Hash([nullifier])

  // The commitment was: Hash(nullifier, secret, amount)
  // nullifierHash is: Hash(nullifier)
  // These two hashes can't be linked! Different inputs, same nullifier.
```

**Key insight:** The nullifier_hash is revealed on-chain, but it can't be linked back to the original commitment because:
- Commitment = Hash(nullifier, secret, amount) - 3 inputs
- NullifierHash = Hash(nullifier) - 1 input

These are two different hash outputs. Knowing one doesn't reveal the other.

The backend returns the nullifier hash along with other data for the transaction:

```typescript
  res.json({
    nullifierHash: nullifierHashBytes,  // Will be stored on-chain
    proof: proofBytes,                  // ZK proof (Step 4-5)
    root: merkleRootBytes,
    // ... other data
  })
})
```

---

### 4. Frontend Sends Transaction with Nullifier Hash (READ)

**File:** `frontend/src/components/WithdrawSection.tsx`

The frontend builds the withdrawal transaction:

```typescript
  const { nullifierHash, proof, root } = await proofResponse.json()

  // Encode instruction data - includes nullifier_hash
  const dataEncoder = getWithdrawInstructionDataEncoder()
  const instructionData = dataEncoder.encode({
    proof: new Uint8Array(proof),           // Step 5
    nullifierHash: new Uint8Array(nullifierHash),  // For double-spend prevention
    root: new Uint8Array(root),
    recipient: recipientAddress,
    amount: BigInt(note.amount),
  })
```

The transaction goes to the Solana program. Let's add the nullifier checking...

---

### 5. Program Checks and Stores Nullifier (TYPE)

**File:** `anchor/programs/private_transfers/src/lib.rs`

This is where we make our changes. The program needs to:
1. Store a set of used nullifier hashes
2. Check if this nullifier was already used
3. Mark it as used before transferring funds

#### Add NullifierSet struct

Find after the Pool impl block:

```rust
impl Pool {
    /// Check if a Merkle root exists in our recent history
    /// This is called during withdrawal to verify the proof is against a valid root
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        // Simple linear scan - O(n) where n = ROOT_HISTORY_SIZE (10)
        // Fine for small arrays, but would need optimization for larger sizes
        self.roots.iter().any(|r| r == root)
    }
}

// Step 3: Add NullifierSet struct with is_nullifier_used and mark_nullifier_used methods
```

Replace with:

```rust
impl Pool {
    /// Check if a Merkle root exists in our recent history
    /// This is called during withdrawal to verify the proof is against a valid root
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        // Simple linear scan - O(n) where n = ROOT_HISTORY_SIZE (10)
        // Fine for small arrays, but would need optimization for larger sizes
        self.roots.iter().any(|r| r == root)
    }
}

/// Stores all used nullifier hashes to prevent double-spending
/// This is a separate account (PDA) because:
/// 1. It can grow independently from the Pool account
/// 2. Keeps concerns separated (pool config vs spent nullifiers)
#[account]
#[derive(InitSpace)]
pub struct NullifierSet {
    pub pool: Pubkey,              // 32 bytes - which pool this nullifier set belongs to
    #[max_len(256)]                // Tell Anchor max Vec size for space calculation
    pub nullifiers: Vec<[u8; 32]>, // Dynamic list of used nullifier hashes
}

impl NullifierSet {
    /// Check if a nullifier hash has already been used (spent)
    /// Returns true if found (already spent), false if not found (can spend)
    pub fn is_nullifier_used(&self, nullifier_hash: &[u8; 32]) -> bool {
        // Linear search through all nullifiers
        // O(n) complexity - fine for 256 items, would need optimization for more
        self.nullifiers.contains(nullifier_hash)
    }

    /// Mark a nullifier hash as used (spent)
    /// Called AFTER validation but BEFORE transfer for security
    pub fn mark_nullifier_used(&mut self, nullifier_hash: [u8; 32]) -> Result<()> {
        // Safety check: don't exceed our max capacity
        require!(
            self.nullifiers.len() < 256,
            PrivateTransfersError::NullifierSetFull
        );
        // Add the nullifier hash to our list of spent nullifiers
        self.nullifiers.push(nullifier_hash);
        Ok(())
    }
}
```

**Solana concept - Vec in Accounts:**
- Unlike fixed-size arrays, `Vec` can grow dynamically
- BUT: Solana accounts have fixed size at creation
- `#[max_len(256)]` tells Anchor to allocate space for up to 256 items upfront
- Space calculation: 4 bytes (Vec length) + 256 * 32 bytes = 8,196 bytes
- If Vec exceeds allocated space, transaction will fail

**Why a separate account?**
- Pool has fixed fields (authority, counters, root history)
- NullifierSet needs a growing list
- Separating them lets us allocate appropriate space for each
- Also follows Solana best practice of single-responsibility accounts

#### Add NullifierSet to Initialize accounts

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
        init,                                        // Create a new account
        payer = authority,                           // Authority pays the rent
        space = 8 + NullifierSet::INIT_SPACE,       // 8-byte discriminator + struct size
        seeds = [b"nullifiers", pool.key().as_ref()],  // PDA seeds: "nullifiers" + pool address
        bump                                         // Anchor finds valid bump automatically
    )]
    pub nullifier_set: Account<'info, NullifierSet>,

    #[account(seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

**Solana concept - PDA (Program Derived Address):**
- PDAs are deterministic addresses computed from seeds
- Anyone can compute the same PDA given the same seeds
- `seeds = [b"nullifiers", pool.key().as_ref()]` means:
  - First seed: the literal bytes "nullifiers"
  - Second seed: the pool's public key (32 bytes)
- This guarantees exactly ONE nullifier set per pool

**How much SOL for rent?**
- Space: 8 + 32 + 4 + (256 * 32) = 8,236 bytes
- At ~0.00000348 SOL per byte = ~0.029 SOL rent-exempt minimum
- This is paid once at creation and never again (rent-exempt)

#### Initialize nullifier_set in initialize function

Find:

```rust
        pool.roots[0] = EMPTY_ROOT;    // Initialize with the empty tree root
        // Step 3: Initialize nullifier_set.pool

        msg!("Pool initialized");
```

Replace with:

```rust
        pool.roots[0] = EMPTY_ROOT;    // Initialize with the empty tree root

        // Link the nullifier set to this pool
        // This creates a bidirectional relationship:
        // - Pool PDA is derived from "pool" seed
        // - NullifierSet PDA is derived from "nullifiers" + pool address
        let nullifier_set = &mut ctx.accounts.nullifier_set;
        nullifier_set.pool = pool.key();

        msg!("Pool initialized");
```

#### Add NullifierSet to Withdraw accounts

Find:

```rust
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [b"pool"], bump)]
    pub pool: Account<'info, Pool>,

    // Step 3: Add nullifier_set account here

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

Replace with:

```rust
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"pool"], bump)]   // Added `mut` - we need to read it
    pub pool: Account<'info, Pool>,

    #[account(
        mut,                                           // Mutable - we'll add to the Vec
        seeds = [b"nullifiers", pool.key().as_ref()],  // Same PDA derivation as in Initialize
        bump                                           // Anchor validates the bump
    )]
    pub nullifier_set: Account<'info, NullifierSet>,

    #[account(mut, seeds = [b"vault", pool.key().as_ref()], bump)]
    pub pool_vault: SystemAccount<'info>,
```

**Solana concept - mut constraint:**
- `mut` means this account's data will be modified
- Solana runtime locks mutable accounts during transaction
- This prevents concurrent modifications (important for double-spend prevention!)
- Without `mut`, trying to modify the account will fail

#### Update withdraw function signature

Find:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // Step 5: Add proof: Vec<u8>
        // Step 3: Add nullifier_hash: [u8; 32]
        root: [u8; 32],        // The Merkle root the ZK proof was generated against
        recipient: Pubkey,      // Who receives the funds
        amount: u64,            // How many lamports to withdraw
    ) -> Result<()> {
        // Step 3: Check nullifier not used

        // Verify the root exists in our history
```

Replace with:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        // Step 5: Add proof: Vec<u8>
        nullifier_hash: [u8; 32],  // Hash of the secret nullifier - used to prevent double-spend
        root: [u8; 32],            // The Merkle root the ZK proof was generated against
        recipient: Pubkey,          // Who receives the funds
        amount: u64,                // How many lamports to withdraw
    ) -> Result<()> {
        // Get mutable reference to nullifier set
        let nullifier_set = &mut ctx.accounts.nullifier_set;

        // CRITICAL: Check this nullifier hasn't been used before
        // If someone tries to withdraw twice with the same deposit note,
        // the nullifier_hash will be the same and we reject it
        require!(
            !nullifier_set.is_nullifier_used(&nullifier_hash),
            PrivateTransfersError::NullifierUsed
        );

        // Verify the root exists in our history
```

**Why check before doing anything else?**
- Fail fast: If nullifier is used, reject immediately
- Saves compute units: Don't do expensive operations if we'll reject anyway
- Security pattern: Check-then-act (though we mark as used later)

#### Mark nullifier as used before transfer

Find:

```rust
        require!(
            ctx.accounts.pool_vault.lamports() >= amount,
            PrivateTransfersError::InsufficientVaultBalance
        );

        // Step 5: Verify ZK proof via CPI
        // Step 3: Mark nullifier as used

        let pool_key = ctx.accounts.pool.key();
```

Replace with:

```rust
        require!(
            ctx.accounts.pool_vault.lamports() >= amount,
            PrivateTransfersError::InsufficientVaultBalance
        );

        // Step 5: Verify ZK proof via CPI

        // CRITICAL: Mark nullifier as used BEFORE transfer
        // This is the "checks-effects-interactions" pattern:
        // 1. Checks: All validations above (nullifier unused, root valid, balance sufficient)
        // 2. Effects: Update state (mark nullifier used) <-- HERE
        // 3. Interactions: External calls (transfer SOL) <-- AFTER
        //
        // Why before transfer? If we marked it after and the transfer somehow
        // re-entered our program, the nullifier wouldn't be marked yet.
        // Marking before prevents reentrancy attacks.
        nullifier_set.mark_nullifier_used(nullifier_hash)?;

        let pool_key = ctx.accounts.pool.key();
```

**Solana concept - Checks-Effects-Interactions Pattern:**
- This is a security pattern from Ethereum, also applies to Solana
- Order of operations:
  1. **Checks**: Validate all conditions (require! statements)
  2. **Effects**: Update your program's state (modify accounts)
  3. **Interactions**: Call external programs (CPI, transfers)
- Why? If external call fails/reenters, your state is already updated correctly

#### Update WithdrawEvent

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
    pub nullifier_hash: [u8; 32],  // The spent nullifier - can be used to verify withdrawal
    pub recipient: Pubkey,          // Who received the funds
    pub timestamp: i64,             // When the withdrawal happened
}
```

**Why include nullifier_hash in the event?**
- Allows indexers to track which nullifiers have been spent
- Users can verify their withdrawal by matching the hash
- Auditors can reconstruct the full history
- Note: We removed `amount` - in a real privacy system, amounts should also be hidden

#### Update the emit! in withdraw

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
            nullifier_hash,                           // The spent nullifier hash
            recipient: ctx.accounts.recipient.key(),  // Who got the funds
            timestamp: Clock::get()?.unix_timestamp,  // When it happened
        });
```

#### Update the log message in withdraw

Find:

```rust
        msg!("Public withdrawal: {} lamports to {}", amount, recipient);
```

Replace with:

```rust
        msg!("Withdrawal: {} lamports to {}", amount, recipient);
```

#### Add error codes

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

---

### Build

```bash
cd anchor
anchor build
```

---

## The Unlinkability Explained

Let's trace through why the nullifier_hash can't be linked to the commitment:

**At deposit time:**
```
nullifier = random 256-bit number (kept secret)
secret = random 256-bit number (kept secret)
amount = how much to deposit

commitment = Hash(nullifier, secret, amount)  <-- stored on-chain
```

**At withdrawal time:**
```
nullifier_hash = Hash(nullifier)  <-- revealed on-chain
```

**Why can't someone link them?**
- Commitment uses THREE inputs: nullifier, secret, amount
- NullifierHash uses ONE input: nullifier
- Hash functions are one-way: you can't reverse them
- Even knowing nullifier_hash, you can't find nullifier (one-way)
- Even if you somehow knew nullifier, you'd also need secret to compute commitment
- The ZK proof verifies the relationship without revealing the inputs

---

## What Changed

Now when someone withdraws:

1. They submit a nullifier_hash
2. We check if it's in our list of used hashes
3. If used: reject (double-spend attempt)
4. If not used: add to list and proceed with transfer

The nullifier_hash can't be linked to the original commitment because they're computed from different inputs.

---

## What's Still Missing

We can prove membership (Step 2) and prevent double-spending (Step 3). But we're not actually verifying a ZK proof yet - we're just trusting that the user knows the secret inputs.

Anyone could submit a fake nullifier_hash right now and withdraw! We need the ZK circuit to verify they actually know the deposit secrets.

Next step: The ZK circuit that proves everything without revealing anything.

Continue to [Step 4: The ZK Circuit](./step-4-zk-circuit.md).
