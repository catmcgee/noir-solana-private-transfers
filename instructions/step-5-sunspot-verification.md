# Step 5: On-Chain Verification with Sunspot

## Goal

Deploy the Sunspot verifier and add CPI (Cross-Program Invocation) to verify ZK proofs on-chain.

## The Verification Flow

We have a ZK proof that proves everything we need. But how do we verify it on Solana?

Sunspot generates a Solana program specifically for verifying our proofs. We deploy this verifier, then our main program calls it via CPI.

If the proof is invalid, the verifier returns an error and our whole transaction fails. If valid, we proceed with the withdrawal.

## Deploy the Verifier

### Generate and Deploy

```bash
# Generate Solana verifier program from verification key
sunspot deploy --vk circuits/withdrawal/target/withdrawal.vk --output anchor/programs/verifier

# Build everything including the new verifier
cd anchor
anchor build

# Deploy to devnet (make sure you have SOL!)
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

**Important**: Copy the verifier program ID from the output!

Example output:
```
Deploying program "verifier"...
Program Id: CU2Vgym4wiTNcJCuW6r7DV6bCGULJxKdwFjfGfmksSVZ
```

## Update the Solana Program

Now add CPI (Cross-Program Invocation) to call the verifier from your main program.

### 1. Add imports and verifier ID at the top

In `lib.rs`, find:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;

declare_id!("2QRZu5cWy8x8jEFc9nhsnrnQSMAKwNpiLpCXrMRb3oUn");
```

Replace with:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;

declare_id!("2QRZu5cWy8x8jEFc9nhsnrnQSMAKwNpiLpCXrMRb3oUn");

// PASTE YOUR VERIFIER PROGRAM ID HERE!
pub const SUNSPOT_VERIFIER_ID: Pubkey = pubkey!("CU2Vgym4wiTNcJCuW6r7DV6bCGULJxKdwFjfGfmksSVZ");
```

### 2. Add encode_public_inputs function

Find:

```rust
// TODO (Step 5): Add encode_public_inputs function for Gnark witness format

#[derive(Accounts)]
pub struct Initialize<'info> {
```

Replace with:

```rust
/// Encode public inputs in Gnark witness format
/// Format: 12-byte header + 4x32-byte public inputs
fn encode_public_inputs(
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
) -> Vec<u8> {
    const NR_PUBLIC_INPUTS: u32 = 4;
    let mut inputs = Vec::with_capacity(12 + 128);

    // Header: num_public (4) | num_private (4) | vector_len (4)
    inputs.extend_from_slice(&NR_PUBLIC_INPUTS.to_be_bytes());
    inputs.extend_from_slice(&0u32.to_be_bytes());
    inputs.extend_from_slice(&NR_PUBLIC_INPUTS.to_be_bytes());

    // Public inputs - ORDER MUST MATCH CIRCUIT!
    inputs.extend_from_slice(root);
    inputs.extend_from_slice(nullifier_hash);
    inputs.extend_from_slice(recipient.as_ref());

    // Amount as 32-byte big-endian
    let mut amount_bytes = [0u8; 32];
    amount_bytes[24..32].copy_from_slice(&amount.to_be_bytes());
    inputs.extend_from_slice(&amount_bytes);

    inputs
}

#[derive(Accounts)]
pub struct Initialize<'info> {
```

### 3. Add verifier program to Withdraw accounts

Find:

```rust
    /// CHECK: Validated in instruction logic
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    // TODO (Step 5): Add Sunspot verifier program account

    pub system_program: Program<'info, System>,
}
```

Replace with:

```rust
    /// CHECK: Validated in instruction logic
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: Validated by constraint
    #[account(constraint = verifier_program.key() == SUNSPOT_VERIFIER_ID @ PrivateTransfersError::InvalidVerifier)]
    pub verifier_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
```

### 4. Update withdraw function signature to include proof

Find:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        nullifier_hash: [u8; 32],
        root: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

Replace with:

```rust
    pub fn withdraw(
        ctx: Context<Withdraw>,
        proof: Vec<u8>,
        nullifier_hash: [u8; 32],
        root: [u8; 32],
        recipient: Pubkey,
        amount: u64,
    ) -> Result<()> {
```

### 5. Add ZK proof verification via CPI

Find:

```rust
        require!(
            ctx.accounts.pool_vault.lamports() >= amount,
            PrivateTransfersError::InsufficientVaultBalance
        );

        // Mark nullifier as used (prevents double-spend)
```

Replace with:

```rust
        require!(
            ctx.accounts.pool_vault.lamports() >= amount,
            PrivateTransfersError::InsufficientVaultBalance
        );

        // VERIFY ZK PROOF via CPI to Sunspot verifier
        let public_inputs = encode_public_inputs(&root, &nullifier_hash, &recipient, amount);
        let instruction_data = [proof.as_slice(), public_inputs.as_slice()].concat();

        invoke(
            &Instruction {
                program_id: ctx.accounts.verifier_program.key(),
                accounts: vec![],
                data: instruction_data,
            },
            &[ctx.accounts.verifier_program.to_account_info()],
        )?;
        // If we reach here, the proof is valid!

        // Mark nullifier as used (prevents double-spend)
```

### 6. Add InvalidVerifier error

Find:

```rust
    #[msg("Unknown Merkle root")]
    InvalidRoot,
    // TODO (Step 5): Add InvalidVerifier
}
```

Replace with:

```rust
    #[msg("Unknown Merkle root")]
    InvalidRoot,
    #[msg("Invalid verifier program")]
    InvalidVerifier,
}
```

### Build and Deploy

```bash
anchor build
anchor deploy --provider.cluster devnet
```

## Understanding the Verification Flow

1. User generates a ZK proof off-chain using the proving key
2. They submit a transaction with: `proof` (256 bytes) + `nullifier_hash` + `root` + `recipient` + `amount`
3. Our program does the checks: nullifier unused, root is known
4. We call the Sunspot verifier via CPI
5. The verifier checks the proof cryptographically
6. If invalid: error, transaction fails
7. If valid: we continue, mark nullifier used, transfer funds

## Public Inputs Format

The CPI data format is:
```
instruction_data = proof_bytes || public_inputs_bytes
```

- Proof: 256 bytes (Groth16 format)
- Public inputs: 12-byte header + 4×32-byte values = 140 bytes

**Critical**: The public inputs ORDER must match exactly what the circuit expects:
1. root
2. nullifier_hash
3. recipient
4. amount

## Compute Units

ZK verification is expensive. It uses about **1.4 million compute units**. The default limit is 200K, so the frontend needs to request more via `ComputeBudgetProgram`.

```typescript
// Frontend must request extra compute units
const computeBudgetData = new Uint8Array(5);
computeBudgetData[0] = 2;  // SetComputeUnitLimit instruction
new DataView(computeBudgetData.buffer).setUint32(1, 1_400_000, true);
```

### Test

```bash
anchor test --provider.cluster devnet
```

## What You've Built

You just verified a zero-knowledge proof on Solana!

The user proved they know a valid deposit without revealing which one. The blockchain sees:
- **Deposit**: commitment `0x7a3b...` at index 42
- **Withdraw**: nullifier_hash `0x9c2f...` to recipient Bob

These two pieces of information CANNOT be linked without knowing the original nullifier. That's privacy.

## Key Concepts

| Concept | Description |
|---------|-------------|
| CPI | Cross-Program Invocation - calling another program |
| Proof Format | 256 bytes (Groth16) + 140 bytes (public inputs) |
| Input Order | Must match circuit exactly |
| Compute Units | ~1.4M needed for verification |

## Next Step

Continue to [Step 6: Demo](./step-6-demo.md) to see the complete system in action.
