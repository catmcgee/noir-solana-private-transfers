# Step 2: Nullifiers - Teleprompter Script

## Opening (The Double-Spend Problem)

We can now deposit privately. Great. But we have a new problem: how do we prevent someone from withdrawing multiple times from the same deposit?

In your escrow, this was easy. After the trade completed, you closed the escrow account. The account literally doesn't exist anymore. Can't double-spend something that's gone.

But we can't do that here. If we mark "commitment X was spent," everyone knows which deposit was withdrawn. That destroys our privacy.

We need to track "something was spent" without revealing which commitment it was.

This is where nullifiers come in.

---

## How Nullifiers Work

Let me walk you through the nullifier mechanism. It's clever.

Remember when you deposited? You generated a random nullifier and included it in your commitment. You kept this nullifier secret.

Now when you want to withdraw, you reveal something derived from that nullifier - specifically, you reveal the hash of your nullifier. We call this the nullifier hash.

The program stores all used nullifier hashes. When someone tries to withdraw, we check: is this nullifier hash already in our list? If yes, reject. If no, allow and add it to the list.

---

## Why This Preserves Privacy

Here's the key insight: the same nullifier always produces the same nullifier hash. If you try to withdraw twice with the same deposit, you'd submit the same nullifier hash twice. The second attempt gets rejected.

But - and this is crucial - observers can't link the nullifier hash back to the original commitment.

Why not? Because they're computed from different things.

The commitment is: hash of nullifier, secret, and amount.

The nullifier hash is: hash of just the nullifier.

Different inputs, different outputs. Without knowing the original nullifier, you can't connect these two values.

So an observer sees: deposit with commitment zero-x-abc. Later, withdrawal with nullifier hash zero-x-xyz. Are they related? No way to tell.

---

## A Concrete Example

Let me make this concrete.

Alice deposits. She generates nullifier twelve-three-four-five. Her commitment is hash of that nullifier plus her secret plus her amount. Say the commitment is zero-x-aaa.

Later, Alice wants to withdraw. She computes hash of just her nullifier - twelve-three-four-five. That gives her nullifier hash zero-x-bbb.

She submits the withdrawal with nullifier hash zero-x-bbb. The program checks: is zero-x-bbb in the used list? No. Great, proceed. Add zero-x-bbb to the list.

Now if Alice tries to withdraw again using the same deposit, she'd compute the same nullifier hash - zero-x-bbb. The program checks: is zero-x-bbb in the list? Yes. Rejected. Double-spend prevented.

But can anyone connect zero-x-aaa (the commitment) to zero-x-bbb (the nullifier hash)? No. They're cryptographically unrelated unless you know the nullifier.

---

## Storing Nullifiers On Solana

How do we store all these nullifier hashes on Solana?

We have a few options.

Option one: a Vec in an account. Simple to implement. But accounts have size limits. A Vec can grow, but you're capped at ten megabytes per account.

Option two: a PDA per nullifier. Create a new account for each nullifier hash. Unlimited capacity, but more complex and costs rent for each.

Option three: a Merkle tree of nullifiers. Most efficient for large scale. You store just the root on-chain and maintain the tree off-chain. This is what production systems use.

For this demo, we'll use a Vec. It's the simplest approach and supports two hundred fifty-six nullifiers. That's eight kilobytes of storage - plenty for learning.

---

## The NullifierSet Account

We create a new PDA called NullifierSet. It's derived from the pool address, so each pool has exactly one nullifier set.

The account stores a Vec of thirty-two byte arrays. Each entry is a used nullifier hash.

When someone withdraws, we check if their nullifier hash is in the Vec. If not, we add it.

Simple, but effective.

---

## What's Still Missing

We've made good progress. We have commitments hiding deposit details. We have nullifiers preventing double-spends.

But there's a problem. Right now, anyone could submit any nullifier hash and withdraw. We're not actually verifying that they know a valid deposit.

Think about it. What's stopping me from making up a random nullifier hash and claiming a withdrawal? Nothing, yet.

We need to prove two things: that we know a real commitment in the pool, and that our nullifier hash corresponds to it.

For the first part, we need to prove our commitment exists. That's where Merkle trees come in.

For the second part, we need to prove the relationship between commitment and nullifier hash without revealing either. That's where ZK proofs come in.

Let's tackle Merkle trees next.
