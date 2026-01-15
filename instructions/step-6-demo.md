# Step 6: Demo & Wrap-up

## Goal

See the complete privacy flow in action and understand what you've built.

## Run the Demo

```bash
cd frontend
bun run dev
```

Open http://localhost:3000 in your browser.

## The Complete Flow

### 1. Connect Wallet

Connect a wallet (e.g., Phantom on devnet).

### 2. Deposit

Enter an amount (e.g., 0.1 SOL) and click Deposit.

Behind the scenes, the frontend:

- Generates a random nullifier and secret
- Computes the commitment hash
- Computes the new Merkle root
- Submits the transaction

When complete, the transaction shows a commitment - just a hash. No link to your wallet address.

**Important**: Save the deposit note that appears. It contains the nullifier and secret you need to withdraw later.

### 3. Switch Wallets

Switch to a completely different wallet in Phantom. This simulates Alice depositing and Bob withdrawing.

### 4. Withdraw

Paste the deposit note from before and click Withdraw.

The frontend:

- Reconstructs the commitment from the note
- Generates a Merkle proof
- Generates a ZK proof (this takes ~30 seconds)
- Submits the withdrawal transaction

The funds arrive in the new wallet!

### 5. Verify on Explorer

Open Solana Explorer and look at the two transactions:

- **Deposit**: Shows `commitment: 0x7a3b...`
- **Withdrawal**: Shows `nullifier_hash: 0x9c2f...`

Can you link these? **No!** Without knowing the original nullifier, there's no way to connect them. That's privacy.

## What You Built

| Component        | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| Commitment       | Hides deposit details in a hash                       |
| Nullifier        | Prevents double-spend without revealing which deposit |
| Merkle Tree      | Efficient membership proofs with O(log n) data        |
| ZK Circuit       | Proves everything without revealing private inputs    |
| Sunspot Verifier | Trustlessly verifies proofs on Solana                 |

## The Privacy Guarantee

```
Observer sees:
├── Deposit:  commitment = 0x7a3b...
└── Withdraw: nullifier_hash = 0x9c2f...

Without the nullifier, these CANNOT be linked.
```

## Caveats

This is an educational implementation. Some limitations:

- **Variable amounts reduce privacy**: Deposits/withdrawals can be correlated by amount
- **Not audited**: Don't use in production without professional audit
- **Limited capacity**: Nullifier set capped at 256 entries in this demo

But the core concepts are exactly what production privacy systems like Tornado Cash use.

## Common Questions

**Q: Why Poseidon hash and not SHA256?**

Poseidon is designed for ZK circuits. SHA256 would require tens of thousands more constraints, making proofs much slower and more expensive.

**Q: How long does proof generation take?**

About 30 seconds on a laptop. This happens client-side in the browser/backend.

**Q: What's the cost of verification?**

About 1.4 million compute units, which costs a few cents extra in transaction fees.

**Q: Can the pool operator steal funds?**

No. Funds can only move with a valid ZK proof, and only the depositor has the nullifier/secret needed to create that proof.

**Q: What happens if I lose my deposit note?**

The funds are lost forever. The note contains the secrets needed to withdraw. There's no recovery mechanism.

## Resources

- [Noir Documentation](https://noir-lang.org/docs)
- [Sunspot Repository](https://github.com/reilabs/sunspot)
- [Tornado Cash Whitepaper](https://tornado.cash/Tornado.cash_whitepaper_v1.4.pdf) (original concept)

## Summary

You've built a complete privacy-preserving transfer system on Solana using:

1. **Cryptographic commitments** to hide deposit details
2. **Nullifiers** to prevent double-spending privately
3. **Merkle trees** for efficient membership proofs
4. **Zero-knowledge proofs** to prove without revealing
5. **On-chain verification** via Sunspot

The result: deposits and withdrawals are completely unlinkable on the public blockchain.

Congratulations on completing the tutorial!
