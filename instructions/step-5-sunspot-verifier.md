# Step 5: Sunspot Verifier

## Goal

Deploy the Sunspot verifier program that validates ZK proofs on-chain.

---

* Tell Sunspot where our verifier template is
* Generate verifier from verifier key, which is a Solana program
* Deploy the verifier to devnet

---

### Set the GNARK_VERIFIER_KEY environment variable

Wherever you installed sunspot, inside that directory you'll find `gnark-solana/crates/verifier-bin`. This needs to be exported as a variable

```bash
export GNARK_VERIFIER_BIN="$HOME/.sunspot/gnark-solana/crates/verifier-bin"
```

---

## Generate the Verifier Program

```bash
cd circuit
sunspot deploy target/withdrawal.vk
```

This creates:
- `target/withdrawal.so` - The compiled Solana program
- `target/withdrawal-keypair.json` - Keypair for deployment

---


## Deploy to Devnet

Make sure you have SOL:

```bash
solana config set --url devnet
solana balance
# If needed: solana airdrop 2
```

Deploy:

```bash
solana program deploy circuit/target/withdrawal.so
```

**Copy the Program ID:**

```
Program Id: Amugr8yL9EQVAgGwqds9gCmjzs8fh6H3wjJ3eB4pBhXV
```

Save this for Step 6.

---

## What You Deployed

The verifier program:
- Has your verification key baked in
- Only accepts proofs from your specific circuit
- Uses BN254 elliptic curve pairings (~1.4M compute units)
- Is stateless - no accounts needed, just CPI

---

## Next Step

Now we'll update our program to call this verifier during withdrawals.

Continue to [Step 6: Verification CPI](./step-6-verification-cpi.md).
