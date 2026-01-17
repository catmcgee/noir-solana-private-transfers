# Step 1: Commitments - Teleprompter Script

## Opening (The Problem with Public Deposits)

In this step, we're going to solve our first privacy problem: hiding who made each deposit.

Right now, if you look at the starter code, the deposit event includes the depositor's public key. Everyone can see exactly who put money in the pool.

We're going to replace that public key with something called a commitment.

---

## What Is A Commitment?

A commitment is really just a hash. But in the ZK world, we call it a commitment because you're "committing" to certain values without revealing them.

Think of it like a sealed envelope. You write something on a piece of paper, put it in an envelope, and seal it. Everyone can see the envelope exists, but no one can see what's inside.

Later, you can open the envelope and prove what you wrote. But until then, it's hidden.

That's exactly what a cryptographic commitment does. You hash your secret values together. The hash is public - everyone can see it. But the original values? Hidden.

---

## The Commitment Formula

Our commitment formula is: hash of nullifier, secret, and amount.

The nullifier is a random value you generate locally. You'll need this to withdraw later. Think of it as your secret password.

The secret is another random value. It adds extra entropy. Two layers of randomness.

The amount is how much you're depositing.

You hash these three things together using a function called Poseidon. The result is a thirty-two byte commitment.

Given just the commitment, you cannot reverse-engineer the inputs. That's the magic of cryptographic hashes - they're one-way functions.

---

## Why Poseidon?

You might wonder why we use Poseidon instead of something familiar like SHA-256.

The answer is efficiency inside ZK circuits.

When you create a ZK proof, every computation has a cost measured in "constraints." SHA-256 requires tens of thousands of constraints. It's designed for CPUs, not for ZK circuits.

Poseidon was designed specifically for ZK systems. It requires only a few hundred constraints. Same security, way more efficient.

So throughout this project, whenever we hash something, we use Poseidon.

---

## Why Not Hash On-Chain?

Here's an important question. Why don't we compute this hash on-chain?

Think about it. If we called hash of nullifier, secret, amount as a Solana instruction, what happens? Those values are in the transaction data. And all Solana transaction data is public.

Everyone would see your nullifier. Everyone would see your secret. The whole point of the commitment is to hide these values. Hashing on-chain completely defeats the purpose.

So instead, we hash off-chain. Your browser or client computes the hash locally. Only the thirty-two byte result gets submitted to Solana. The private inputs never touch the blockchain.

---

## What If Someone Cheats?

You might worry - what if someone submits a wrong commitment? What if they just make up random bytes?

Here's the beautiful thing: it doesn't matter.

If you submit an invalid commitment, you can never withdraw. The ZK proof requires you to know the actual nullifier, secret, and amount that produce that commitment. If you don't know them, you can't create a valid proof.

So cheating on the commitment only hurts yourself. You'd be locking funds forever with no way to retrieve them.

The ZK proof, which we'll build later, verifies that the hash was computed correctly - without revealing what went into it.

---

## On-Chain Hashing Does Exist

Now, I should mention - on-chain Poseidon does exist and is useful. Just not for private data.

ZK proofs aren't only about hiding information. They're also used to compress data.

For example, Light Protocol uses something called ZK Compression. Instead of storing full account data on-chain, they store a Merkle root - a tiny fingerprint. The actual data lives off-chain, and ZK proofs verify that state changes are valid.

This cuts storage costs by a thousand X for things like airdrops and NFT mints.

In that case, they hash on-chain because the data - addresses, balances - is public anyway. They're using ZK for compression, not privacy.

Our use case is different. We need privacy. So we hash off-chain.

---

## The Hasher Circuit

Let me show you the Noir circuit that computes our commitment.

The circuit takes three inputs: nullifier, secret, and amount.

It outputs two values: the commitment, which is hash of all three, and the nullifier hash, which is hash of just the nullifier. We'll use the nullifier hash in the next step for double-spend prevention.

This circuit runs off-chain. When you deposit, your client calls this circuit to compute the commitment before submitting the transaction.

---

## Deposit Notes

Here's something crucial. When you deposit, you need to save your nullifier, secret, and amount. This is called a deposit note.

Think of it as your receipt. You need this to withdraw later. It's the only proof that you made a deposit.

And here's the scary part: if you lose this note, your funds are gone forever. There's no recovery mechanism. No "forgot password" button. The nullifier and secret exist only on your device. Lose them, lose everything.

This is a fundamental property of privacy systems. True privacy means no one - not even the system - can recover your funds without your secrets.

In production systems, you'd want to think carefully about backup mechanisms. Encrypted cloud storage, hardware wallets, something. But the core principle remains: your secrets are yours alone.

---

## What Changes On-Chain

Let me summarize what we're changing in the Solana program.

Before, the deposit event showed the depositor's public key. Alice's address, right there for everyone to see.

After, the deposit event shows a commitment. Just thirty-two bytes of hash. No address. No identity.

Alice deposits, and observers see: commitment zero-x-seven-a-three-b-something at leaf index zero.

Bob deposits, and observers see: commitment zero-x-two-c-five-d-something at leaf index one.

Neither commitment reveals anything about Alice or Bob. The connection between person and deposit is completely hidden.

---

## The Withdrawal Problem

So now we can deposit privately. But how do we withdraw?

We can't just say "I want to withdraw commitment X." That would reveal which deposit is ours, destroying the privacy we just built.

We need to prove we know a valid commitment without revealing which one.

That's where nullifiers come in. Let's look at that next.
