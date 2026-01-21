# Step 6: Verification CPI

## Goal

Update the program to verify ZK proofs by calling the Sunspot verifier via CPI.

---


## Update the Program

**File:** `anchor/programs/private_transfers/src/lib.rs`

---

## Part 1: Add Imports and Verifier ID

To call another Solana program (CPI = Cross-Program Invocation), we need the `Instruction` type and `invoke` function. We also need to know the address of the verifier program we deployed in Step 5.

### 1. Add imports at the top

Find:

```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program;
```

Replace with:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::system_program;
```

### 2. Add verifier ID constant

This is the program ID of the Sunspot verifier you deployed in Step 5. Every CPI call needs the target program's address.

Find:

```rust
// Step 2: Add Merkle tree constants here
// Step 5: Add SUNSPOT_VERIFIER_ID here

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000;
```

Replace with (use YOUR verifier ID from Step 5):

```rust
pub const SUNSPOT_VERIFIER_ID: Pubkey = pubkey!("YOUR_VERIFIER_PROGRAM_ID_HERE");

pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000_000;
```

---

## Part 2: Encode Public Inputs for the Verifier

The Gnark/Sunspot verifier expects a specific binary format for its input. We need to encode our public inputs (root, nullifier, recipient, amount) exactly as the verifier expects.

### What the Verifier Expects

The instruction data format is: `proof_bytes || public_witness_bytes`


### 3. Add encode_public_inputs function

This function builds the public inputs in the exact format the verifier expects.

Find:

```rust
// Step 5: Add encode_public_inputs function here

#[derive(Accounts)]
pub struct Initialize<'info> {
```

Replace with:

```rust
/// Encodes public inputs in the format expected by the Gnark/Sunspot verifier.
/// The verifier expects a specific binary format: a 12-byte header followed by
/// each public input as a 32-byte big-endian field element.
///
/// Big-endian means most significant byte first - the opposite of how Solana
/// and most CPUs store numbers (little-endian).
fn encode_public_inputs(
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
) -> Vec<u8> {
    const NR_PUBLIC_INPUTS: u32 = 4;
    
    // Pre-allocate: 12 bytes header + 4 inputs × 32 bytes each = 140 bytes
    let mut inputs = Vec::with_capacity(12 + 128);

    // === Gnark Header (12 bytes) ===
    // The Gnark verifier expects:
    // - Bytes 0-3:  Number of public inputs (big-endian u32)
    // - Bytes 4-7:  Number of commitments, always 0 for us (big-endian u32)
    // - Bytes 8-11: Number of public inputs again (big-endian u32)
    inputs.extend_from_slice(&NR_PUBLIC_INPUTS.to_be_bytes());
    inputs.extend_from_slice(&0u32.to_be_bytes());
    inputs.extend_from_slice(&NR_PUBLIC_INPUTS.to_be_bytes());

    // === Public Inputs (each 32 bytes, big-endian) ===
    // IMPORTANT: Order must exactly match the circuit's public input declaration!
    // Our circuit declares: root, nullifier_hash, recipient, amount
    
    // 1. Merkle root - proves the commitment exists in the tree
    inputs.extend_from_slice(root);
    
    // 2. Nullifier hash - prevents double-spending
    inputs.extend_from_slice(nullifier_hash);
    
    // 3. Recipient pubkey - who receives the funds (32 bytes)
    inputs.extend_from_slice(recipient.as_ref());

    // 4. Amount - padded to 32 bytes (u64 is only 8 bytes)
    //    Left-pad with 24 zero bytes, then the 8-byte big-endian value
    let mut amount_bytes = [0u8; 32];
    amount_bytes[24..32].copy_from_slice(&amount.to_be_bytes());
    inputs.extend_from_slice(&amount_bytes);

    inputs
}

#[derive(Accounts)]
pub struct Initialize<'info> {
```

---

## Part 3: Add Verifier to Withdraw Accounts

The withdraw instruction needs access to the verifier program so it can call it via CPI. We validate that the passed program is actually our verifier (not some malicious program).

### 4. Add verifier to Withdraw accounts

Find:

```rust
    /// CHECK: Validated in instruction logic
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

}
```

Addd

```rust
   
    /// Safety: Validated by the constraint that checks it matches SUNSPOT_VERIFIER_ID.
    #[account(
        constraint = verifier_program.key() == SUNSPOT_VERIFIER_ID @ PrivateTransfersError::InvalidVerifier
    )]
     /// CHECK: External program without an Anchor IDL in our project.
    /// We use UncheckedAccount because we can't use Program<'info, SunspotVerifier>
    /// without importing that program's types.
    pub verifier_program: UncheckedAccount<'info>, // TYPE THIS FIRST
}
```

Add error

```rust
    #[msg("Invalid verifier program")]
    InvalidVerifier,
```

Now our progrram knows about the verifier program

---

## Part 4: Update Withdraw to Verify Proofs

Now we update the withdraw function to:
1. Accept the proof as input
2. Encode the public inputs
3. Call the verifier via CPI
4. Only proceed if verification succeeds (CPI failure = transaction reverts)

### 5. Update withdraw function signature

Find:

```rust
    pub fn withdraw(
    ) -> Result<()> {
```

Add

```rust
    pub fn withdraw(
      
        // The ZK proof generated by the client (324 bytes)
        proof: Vec<u8>,
      
    ) -> Result<()> {
```

### 6. Add verification CPI call

This is where the magic happens. We call the verifier program with the proof and public inputs. If the proof is invalid, the CPI fails and the entire transaction reverts - no funds are transferred.

Find:

```rust
        require!(
            ctx.accounts.pool_vault.lamports() >= amount,
            PrivateTransfersError::InsufficientVaultBalance
        );

        // under here 

       
```

Add
```rust

        // === Verify ZK proof via CPI ===
        // Encode public inputs in the format the verifier expects
        let public_inputs = encode_public_inputs(&root, &nullifier_hash, &recipient, amount);
        
        // Concatenate proof + public inputs (this is what the verifier program reads)
        let instruction_data = [proof.as_slice(), public_inputs.as_slice()].concat();

        // Call the verifier program - if proof is invalid, this fails and reverts everything
        invoke(
            &Instruction {
                program_id: ctx.accounts.verifier_program.key(),
                accounts: vec![],  // Verifier needs no accounts, just the instruction data
                data: instruction_data,
            },
            &[ctx.accounts.verifier_program.to_account_info()],
        )?;

        // If we get here, proof was valid! Mark nullifier and transfer funds
        nullifier_set.mark_nullifier_used(nullifier_hash)?;
```

---

## Build and Deploy

```bash
cd anchor
anchor build
anchor deploy --provider.cluster devnet
```

---

## What Changed

- Withdrawals now require a ZK proof
- Program calls verifier via CPI before releasing funds
- If verification fails, entire transaction reverts
- No funds can move without a valid proof

---

## Next Step

The program is complete! Let's build the frontend and test everything.

Continue to [Step 7: Frontend and Demo](./step-7-frontend-demo.md).
