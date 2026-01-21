# Step 7: Frontend and Demo

## Goal

Implement the deposit transaction in the frontend and run the complete demo.

---

## What You'll Do

* Implement the deposit transaction in `DepositSection.tsx`
* Run and test the complete privacy-preserving transfer flow

---

## Update the Frontend

**File:** `frontend/src/components/DepositSection.tsx`

---

### 1. Uncomment the imports

Find:

```typescript
import { useState } from 'react'
import { useWalletConnection, useSendTransaction } from '@solana/react-hooks'
// Step 1: You'll use these imports for PDA computation
// import { getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'
import { PRIVATE_TRANSFERS_PROGRAM_ADDRESS } from '../generated'
// Step 1: You'll use this import for encoding instruction data
// import { getDepositInstructionDataEncoder } from '../generated'
import { getWalletAddress } from '../utils'
import { API_URL, LAMPORTS_PER_SOL, DEFAULT_DEPOSIT_AMOUNT } from '../constants'
// Step 1: You'll use these imports for building the instruction
// import { SEEDS, SYSTEM_PROGRAM_ID } from '../constants'
import type { DepositNote, DepositApiResponse } from '../types'
```

Replace with:

```typescript
import { useState } from 'react'
import { useWalletConnection, useSendTransaction } from '@solana/react-hooks'
import { getProgramDerivedAddress, getBytesEncoder, getAddressEncoder } from '@solana/kit'
import { getDepositInstructionDataEncoder, PRIVATE_TRANSFERS_PROGRAM_ADDRESS } from '../generated'
import { getWalletAddress } from '../utils'
import { API_URL, LAMPORTS_PER_SOL, SEEDS, SYSTEM_PROGRAM_ID, DEFAULT_DEPOSIT_AMOUNT } from '../constants'
import type { DepositNote, DepositApiResponse } from '../types'
```

---

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
      // Pool PDA - seeds: [b"pool"]
      const [poolPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [getBytesEncoder().encode(SEEDS.POOL)],
      })

      // Vault PDA - seeds: [b"vault", pool.key()]
      const [poolVaultPda] = await getProgramDerivedAddress({
        programAddress,
        seeds: [
          getBytesEncoder().encode(SEEDS.VAULT),
          getAddressEncoder().encode(poolPda),
        ],
      })

      // === Encode instruction data ===
      // The encoder knows the exact byte layout your program expects
      const dataEncoder = getDepositInstructionDataEncoder()
      const instructionData = dataEncoder.encode({
        commitment: new Uint8Array(onChainData.commitment),
        newRoot: new Uint8Array(onChainData.newRoot),
        amount: BigInt(onChainData.amount),
      })

      // === Build the instruction ===
      // Account roles: 0=readonly, 1=writable, 2=readonly+signer, 3=writable+signer
      const depositInstruction = {
        programAddress,
        accounts: [
          { address: poolPda, role: 1 },           // pool: writable
          { address: poolVaultPda, role: 1 },      // pool_vault: writable
          { address: walletAddress, role: 3 },     // depositor: writable + signer
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

## Understanding the Code

### PDA Seeds

The `SEEDS` constant in `constants.ts` contains pre-encoded byte arrays:

```typescript
export const SEEDS = {
  POOL: new Uint8Array([112, 111, 111, 108]),      // "pool"
  VAULT: new Uint8Array([118, 97, 117, 108, 116]), // "vault"
  NULLIFIERS: new Uint8Array([...]),               // "nullifiers"
}
```

These match the seeds in your Anchor program (`seeds = [b"pool"]`).

### Account Roles

Solana Kit uses numeric roles for account permissions:

| Role | Name | Description |
|------|------|-------------|
| 0 | READONLY | Can read but not modify |
| 1 | WRITABLE | Can read and modify |
| 2 | READONLY_SIGNER | Readonly but must sign |
| 3 | WRITABLE_SIGNER | Writable and must sign |

### Generated Encoders

Codama generates type-safe encoders from your Anchor IDL. The encoder handles:
- 8-byte discriminator (identifies which instruction)
- Field serialization in correct order
- Proper byte alignment

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
