# Step 5: onchain Verification with Sunspot

## Goal

Deploy the Sunspot verifier and add CPI (Cross-Program Invocation) to verify ZK proofs onchain.

## CPI Refresher

Here we do a cross-program invocation to call the **Sunspot Verifier Program**:

```rust
// Our CPI to verifier
invoke(&verifier_instruction, &[verifier_account])?;
```

The verifier is just a Solana program.

## The Verification Flow

If the proof is invalid, the verifier returns an error and our whole transaction fails (it's atomic, like all Solana transactions). If valid, we proceed with the withdrawal.

![image](./assets/cpi.png)

## Deploy the verifier

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

## Back to our original program

Now add CPI (Cross-Program Invocation) to call the verifier from your main program.

### 1. Add imports and verifier ID at the top

In `lib.rs`, find:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::system_program;

declare_id!("2QRZu5cWy8x8jEFc9nhsnrnQSMAKwNpiLpCXrMRb3oUn");
```

Replace with:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::system_program;

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
/// This is the binary format Sunspot verifier expects
fn encode_public_inputs(
    root: &[u8; 32],
    nullifier_hash: &[u8; 32],
    recipient: &Pubkey,      // Solana Pubkey is 32 bytes
    amount: u64,
) -> Vec<u8> {
    const NR_PUBLIC_INPUTS: u32 = 4;
    let mut inputs = Vec::with_capacity(12 + 128);  // Pre-allocate for efficiency

    // Gnark header format (12 bytes total)
    inputs.extend_from_slice(&NR_PUBLIC_INPUTS.to_be_bytes());  // 4 bytes
    inputs.extend_from_slice(&0u32.to_be_bytes());              // 4 bytes (private=0)
    inputs.extend_from_slice(&NR_PUBLIC_INPUTS.to_be_bytes());  // 4 bytes

    // Public inputs - ORDER MUST MATCH NOIR CIRCUIT EXACTLY!
    // If order is wrong, proof verification will fail
    inputs.extend_from_slice(root);                  // 32 bytes
    inputs.extend_from_slice(nullifier_hash);        // 32 bytes
    inputs.extend_from_slice(recipient.as_ref());    // Pubkey -> &[u8; 32]

    // Amount as 32-byte big-endian (ZK field element format)
    let mut amount_bytes = [0u8; 32];
    amount_bytes[24..32].copy_from_slice(&amount.to_be_bytes());
    inputs.extend_from_slice(&amount_bytes);

    inputs  // Total: 12 + 128 = 140 bytes
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
    /// CHECK: Validated in instruction logic (recipient param must match)
    #[account(mut)]  // mut because we're transferring lamports TO it
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: Constraint validates this is the real Sunspot verifier
    #[account(
        constraint = verifier_program.key() == SUNSPOT_VERIFIER_ID
            @ PrivateTransfersError::InvalidVerifier
    )]
    pub verifier_program: UncheckedAccount<'info>,
    // UncheckedAccount = we just need the AccountInfo for CPI
    // No deserialization needed - verifier is an external program

    pub system_program: Program<'info, System>,  // For SOL transfers
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

This is the core of privacy - we verify the ZK proof onchain.

> 💡 **Solana Reminder**: We use `invoke()` here, not `invoke_signed()`, because we're not signing on behalf of a PDA, we're just calling another program. The verifier doesn't need any account signatures; it just validates the proof bytes. Later, when we transfer from the vault PDA, we'll need `invoke_signed()`.

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

        // VERIFY ZK PROOF via CPI (Cross-Program Invocation)
        // CPI = calling another Solana program from within our program
        let public_inputs = encode_public_inputs(&root, &nullifier_hash, &recipient, amount);
        let instruction_data = [proof.as_slice(), public_inputs.as_slice()].concat();

        // invoke() is Solana's syscall for CPI
        // Unlike invoke_signed(), we don't need PDA signing - just calling
        invoke(
            &Instruction {
                program_id: ctx.accounts.verifier_program.key(),  // The Sunspot verifier
                accounts: vec![],  // Verifier is stateless - no accounts needed
                data: instruction_data,  // proof bytes + public inputs
            },
            &[ctx.accounts.verifier_program.to_account_info()],
        )?;
        // If invoke() returns Ok, the ZK proof is valid!
        // If invalid, it returns Err and our whole tx fails (atomic)

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

1. User generates a ZK proof offchain using the proving key
2. They submit a transaction with: `proof` (256 bytes) + `nullifier_hash` + `root` + `recipient` + `amount`
3. Our program does the checks: nullifier unused, root is known
4. We call the Sunspot verifier via CPI
5. The verifier checks the proof cryptographically
6. If invalid: error, transaction fails
7. If valid: we continue, mark nullifier used, transfer funds

## Inside the verifier

You can look at this yourself, but this is totally out of scope for the bootcamp and for most privacy products you might want to build.

The Sunspot verifier is basically Groth16 as code. It performs **elliptic curve pairings** on BN254. Without diving into the math, here's the intuition:

```
Verifier receives:
  - Proof: (A, B, C) - three curve points
  - Public inputs: (root, nullifier_hash, recipient, amount)

Verifier computes:
  e(A, B) == e(α, β) × e(public_inputs, γ) × e(C, δ)

  where e() is a "pairing" function and α,β,γ,δ are from the verification key
```

If this equation holds, the prover knew valid private inputs. If not, they're lying.

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

ZK verification is expensive. It uses about **1.4 million compute units**.

> 💡 **Solana Reminder**: Every Solana transaction has a compute unit limit (default 200K). Complex operations like ZK verification need more. You request extra compute units by adding a `ComputeBudgetProgram` instruction before your main instruction

```typescript
// Frontend must request extra compute units
import { ComputeBudgetProgram } from "@solana/web3.js";

// Add this instruction FIRST in your transaction
ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
```

The extra compute costs more in fees, but it's still cheap (~$0.02 per withdrawal). Solana is awesome.

### Test

```bash
anchor test --provider.cluster devnet
```

## What You've Built

You just verified a zero-knowledge proof on Solana!

The user proved they know a valid deposit without revealing which one. The blockchain sees:

- **Deposit**: commitment `0x7a3b...` at index 42
- **Withdraw**: nullifier_hash `0x9c2f...` to recipient Bob

These two pieces of information can't be linked without knowing the original nullifier.

## Key Concepts

| Concept       | Description                                        |
| ------------- | -------------------------------------------------- |
| CPI           | Cross-Program Invocation - calling another program |
| Proof Format  | 256 bytes (Groth16) + 140 bytes (public inputs)    |
| Input Order   | Must match circuit exactly                         |
| Compute Units | ~1.4M needed for verification                      |

## Next Step

Continue to [Step 6: Demo](./step-6-demo.md) to see the complete system in action.
