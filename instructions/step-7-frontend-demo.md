# Step 7: Frontend and Demo

## Goal

Implement the deposit transaction in the frontend and run the complete demo.

---

## What You'll Do

* Implement the deposit transaction in `DepositSection.tsx`
* Run and test the complete privacy-preserving transfer flow

---

## Generate IDL with Codama

Codama allows you to generate Typescript interfaces that automatically do serialization so you don't have to worry about that in your frontend. 

* Go to `frontend/scripts/generate-client.ts`
* Run `bun run scripts/generate-client.ts`
* Look at `generated` folder

## Update the Frontend

**File:** `frontend/src/components/DepositSection.tsx`

---

### 1. Uncomment the imports

Find:

```typescript
import { useState } from 'react'
...
```

Add 
```typescript
import { getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'
import { getDepositInstructionDataEncoder, PRIVATE_TRANSFERS_PROGRAM_ADDRESS } from '../generated'
import { SEEDS, SYSTEM_PROGRAM_ID } from '../constants'
```

---

## Add consts
in frontend/constants.ts

Set SUNSPOT_VERIFIER_ID to the program ID

### 2. Implement the deposit transaction

Find:

```typescript
      // ============================================================
      // TODO: Implement in Step 1 - Replace this entire block
      // ============================================================
      // 1. Uncomment the imports at the top of the file
      // 2. Define programAddress = PRIVATE_TRANSFERS_PROGRAM_ADDRESS
      // 3. Compute PDAs: poolPda and poolVaultPda
      // 4. Encode instruction data with getDepositInstructionDataEncoder()
      // 5. Build depositInstruction with programAddress, accounts, data
      // 6. Delete this throw statement
      console.log('You will use:', { onChainData, programAddress: PRIVATE_TRANSFERS_PROGRAM_ADDRESS })
      throw new Error('TODO: Implement deposit transaction in Step 1. See instructions.')
      // ============================================================

      // After implementing, your depositInstruction will be used here:
      setStatus('Please sign in your wallet...')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const depositInstruction = null as any // Replace with your implementation
```

Replace with:

```typescript
      // Get the program address from the generated client
      const programAddress = PRIVATE_TRANSFERS_PROGRAM_ADDRESS

      // === Compute PDAs ===
      // PDAs (Program Derived Addresses) are deterministic addresses owned by programs
      // Same seeds + same program = same address every time

      // Pool PDA - seeds: [b"pool"]
      // getBytesEncoder() converts strings/arrays to the byte format Solana expects
      const [poolPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [getBytesEncoder().encode(SEEDS.POOL)],  // SEEDS.POOL = "pool"
      })

      // Vault PDA - seeds: [b"vault", pool.key()]
      // getAddressEncoder() converts a Solana address (base58 string) to bytes
      const [poolVaultPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          getBytesEncoder().encode(SEEDS.VAULT),  // SEEDS.VAULT = "vault"
          getAddressEncoder().encode(poolPda),    // The pool's address as bytes
        ],
      })

      // === Encode instruction data ===
      // Codama generates this encoder from your IDL - it knows the exact byte layout
      // No manual serialization needed!
      const dataEncoder = getDepositInstructionDataEncoder()
      const instructionData = dataEncoder.encode({
        commitment: new Uint8Array(onChainData.commitment),
        newRoot: new Uint8Array(onChainData.newRoot),
        amount: BigInt(onChainData.amount),  // BigInt for u64
      })

      // === Build the instruction ===
      // Account roles (from @solana/kit):
      // 0 = readonly, 1 = writable, 2 = readonly+signer, 3 = writable+signer
      // Order must match the Deposit struct in your Anchor program!
      const depositInstruction = {
        programAddress,
        accounts: [
          { address: poolPda, role: 1 },           // pool: writable (we update next_leaf_index)
          { address: poolVaultPda, role: 1 },      // pool_vault: writable (receives SOL)
          { address: walletAddress, role: 3 },     // depositor: writable + signer (sends SOL)
          { address: SYSTEM_PROGRAM_ID, role: 0 }, // system_program: readonly
        ],
        data: instructionData,
      }

      setStatus('Please sign in your wallet...')
```

---

### 3. Remove the eslint disable comment

Find:

```typescript
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (txError: any) {
```

Replace with:

```typescript
      } catch (txError) {
```

---

### Generated Encoders

Codama generates type-safe encoders from your Anchor IDL. The encoder handles:
- 8-byte discriminator (identifies which instruction)
- Field serialization in correct order
- Proper byte alignment

---

## Initialize the Pool (First Time Only!)

Before any deposits or withdrawals can happen, the pool must be initialized. This creates the Pool and NullifierSet accounts on-chain.

```bash
cd anchor
anchor run initialize
```

> This only needs to run once per deployment. If you redeploy the program, you'll need to initialize again. The initialize instruction creates PDAs for the pool, vault, and nullifier set.

---

## Run and Test the Demo

### 1. Start the Backend

The backend handles proof generation (runs Noir prover server-side).

```bash
cd backend
bun install
bun run dev
```

Runs on `http://localhost:4001`.

### 2. Start the Frontend

```bash
cd frontend
bun install
bun run dev
```

Open `http://localhost:3000`.

---

## Test the Complete Flow

### Deposit

1. Connect wallet (devnet)
2. Enter amount (e.g., 0.1 SOL)
3. Click **Deposit**
4. **Save your deposit note!** (contains secret + nullifier needed for withdrawal)

### Withdraw

1. Switch to a different wallet (optional - simulates Alice → Bob)
2. Paste the deposit note
3. Enter recipient address
4. Click **Withdraw**
5. Wait ~30 seconds for proof generation
6. Approve the transaction

---

## Verify Privacy on Explorer

Open [Solana Explorer](https://explorer.solana.com/?cluster=devnet).

**Deposit transaction shows:**
- `commitment: 0x7a3b...` (not your address!)
- `leaf_index: 0`
- `new_root: 0xabc1...`

**Withdrawal transaction shows:**
- `nullifier_hash: 0x9c2f...` (different hash)
- `recipient: Bob's_address`
- NO link to original deposit!

**Why unlinkable:**

```
Deposit:    commitment = Hash(nullifier, secret, amount)
Withdrawal: nullifier_hash = Hash(nullifier)

Different hashes, same nullifier internally - can't be linked without knowing the secret!
```

---

## What You Built

| Component | Purpose |
|-----------|---------|
| Commitment | Hides who deposited |
| Merkle tree | Proves deposit exists |
| Nullifier hash | Prevents double-spending |
| ZK proof | Proves everything privately |
| Verifier CPI | On-chain proof verification |
| Codama | Type-safe client generation |

---

## Congratulations!

You've built a privacy-preserving transfer system on Solana using:
- **Noir** for ZK circuits
- **Sunspot** for Groth16 proofs
- **Anchor** for the Solana program
- **Codama** for client generation
- **Solana Kit** for the frontend

The core concepts - commitments, nullifiers, Merkle trees, ZK proofs - are the foundation of privacy applications like Tornado Cash and Zcash, now running on Solana.
