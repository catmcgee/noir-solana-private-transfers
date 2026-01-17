# Step 5: Sunspot Verification - Teleprompter Script

## Opening (On-Chain Verification)

We have our ZK proof. Now we need to verify it on Solana.

This is the final piece of the puzzle. Everything we've built - commitments, nullifiers, Merkle trees, the ZK circuit - it all comes down to this moment. Can we verify that proof on-chain?

The answer is yes, using Sunspot and CPI.

---

## CPI Refresher

If you remember from your escrow project, CPI stands for Cross-Program Invocation. It's how one Solana program calls another.

In your escrow, you probably used CPI to transfer tokens via the Token Program. Your program didn't implement token transfers - it called the Token Program to do it.

Same pattern here. Our program doesn't implement ZK verification. We call a separate verifier program that Sunspot generated. The verifier does the heavy cryptographic lifting.

The flow is simple. We package up the proof and public inputs. We call the verifier. If the proof is invalid, it returns an error and our whole transaction fails - atomically. If valid, execution continues and we process the withdrawal.

---

## The Verifier Program

Sunspot generates a complete Solana program from your verification key. This program has the verification logic and the key itself baked right into the code.

You deploy this verifier to Solana just like any other program. It gets a program ID - an address on the network.

When our private transfers program needs to verify a proof, it calls this verifier's program ID via CPI. The verifier checks the cryptographic equation and returns success or failure.

No accounts needed on the verifier side. It's stateless. Just give it proof bytes and public inputs, and it tells you valid or invalid.

---

## What The Verifier Does

Without going too deep into the math, here's what the verifier actually computes.

It receives the proof - those three curve points A, B, and C. It also receives the public inputs - root, nullifier hash, recipient, amount.

It performs something called a pairing check. This is an operation on elliptic curves that has special algebraic properties.

The equation looks something like: pairing of A and B equals pairing of some fixed points times pairing of public inputs times pairing of C.

If this equation balances, the prover knew valid private inputs. If it doesn't, they were trying to cheat.

The math is beautiful but complex. You don't need to understand it to use it. That's the power of abstraction.

---

## Compute Units

Here's something practical you need to know: ZK verification is expensive.

It uses about one-point-four million compute units. Solana's default transaction limit is two hundred thousand.

If you just submit a withdrawal transaction without requesting more compute, it'll fail. "Exceeded compute budget."

The fix is simple. You add a Compute Budget instruction before your withdrawal. It requests the extra compute units you need.

In the frontend code, we include this instruction first in the transaction. Request one-point-four million units, then do the withdrawal.

The extra compute costs a bit more in fees. But we're talking a few cents at most. Solana's fee structure is incredibly cheap even for heavy computation.

---

## Input Encoding

One detail that trips people up: the order of public inputs matters.

The verifier expects inputs in a specific format and order. If you get it wrong, verification fails even with a valid proof.

Our order matches the circuit definition:
1. Root
2. Nullifier hash
3. Recipient
4. Amount

Each is encoded as thirty-two bytes, big-endian. The amount gets padded to thirty-two bytes.

We also add a twelve-byte header that describes how many public inputs there are. This is a Sunspot-specific format.

Get any of this wrong and you'll get cryptic verification failures. The encoding function in our code handles all these details correctly.

---

## Atomic Transaction Safety

Something really nice about Solana: transactions are atomic.

When our withdrawal instruction runs, it:
1. Checks the nullifier isn't used
2. Checks the root is known
3. Calls the verifier via CPI
4. Marks the nullifier used
5. Transfers the funds

If any step fails, the entire transaction reverts. Nothing is partially applied.

This is crucial for security. Imagine if the verifier failed but we'd already marked the nullifier used. The user couldn't withdraw again. Their funds would be stuck.

With atomic transactions, either everything succeeds or nothing happens. Clean and safe.

---

## What You've Built

Let's step back and appreciate what you've accomplished.

You can now verify a zero-knowledge proof on Solana.

A user can prove "I have a valid deposit in this pool" without revealing which deposit it is.

The blockchain sees: deposit at time one, commitment zero-x-abc.
The blockchain sees: withdrawal at time two, nullifier hash zero-x-xyz.

There is no way to connect these. The linkage is cryptographically hidden.

That's privacy on a public blockchain. A transaction graph that doesn't reveal who paid whom.

---

## Deployment

Now let's deploy the verifier and update our program to use it.

After that, we'll run the full demo and see everything working end to end.
