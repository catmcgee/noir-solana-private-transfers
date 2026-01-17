# Step 3: Merkle Trees - Teleprompter Script

## Opening (The Membership Problem)

We need to prove that our commitment exists in the pool. Sounds simple, but there's a catch.

Imagine we have a thousand deposits. How do we prove one specific commitment is among them?

The naive approach: include all thousand commitments in the transaction. Let the program search through them. But wait - Solana transactions have about a twelve hundred byte limit. A thousand commitments would be thirty-two thousand bytes. Not gonna fit.

Even if we could fit them, searching a list of a thousand items on-chain would be expensive. Compute units would go through the roof.

We need something smarter. We need Merkle trees.

---

## What Is A Merkle Tree?

A Merkle tree is a data structure that lets you prove membership efficiently.

Picture a tree structure. At the bottom, you have leaves - your actual data. In our case, each leaf is a commitment.

Now, take pairs of leaves and hash them together. That gives you the next level up. Keep doing this - hash pairs together - until you reach a single value at the top. That's called the root.

The root is like a fingerprint of the entire tree. It's just thirty-two bytes, but it represents all the data below it.

Here's the powerful part. If you change any leaf - even by one bit - the root changes completely. The root cryptographically commits to the entire tree contents.

---

## Merkle Proofs

Now here's where it gets useful. To prove a specific leaf exists in the tree, you don't need to show the whole tree.

You just need the siblings along the path from your leaf to the root.

Let me explain. Say your commitment is at leaf position five. To prove it, you provide:
- Your commitment (the leaf)
- The sibling at level one
- The sibling at level two
- And so on up to the root

The verifier starts with your leaf. Hashes it with the sibling, gets the parent. Hashes that with the next sibling, gets the grandparent. Continues up to the root.

If the computed root matches the known root, your leaf is definitely in the tree. If any value is wrong, the computation produces garbage.

---

## The Efficiency

This is incredibly efficient.

For a tree with a thousand leaves, the depth is log-two of a thousand, which is about ten levels.

So instead of sending a thousand commitments, you send ten sibling hashes. That's three hundred twenty bytes instead of thirty-two thousand.

For a million leaves? Twenty siblings. Six hundred forty bytes.

The proof size grows logarithmically while the tree can grow exponentially. That's why Merkle trees are everywhere in blockchain.

---

## What We Store On-Chain

Given how powerful Merkle proofs are, what do we actually need to store on Solana?

Just the root. A single thirty-two byte hash.

That root represents our entire tree of deposits. When someone wants to prove their deposit exists, they provide a Merkle proof. We verify it against the stored root.

This is a common Solana pattern: when data is too large for on-chain storage, store a hash and verify against it.

---

## Where Does The Full Tree Live?

If we only store the root on-chain, where does the full tree live?

Off-chain. In a backend, an indexer, or a database.

Here's the flow.

When someone deposits, our program emits an event with the commitment and leaf index. The root gets updated on-chain.

An off-chain service - let's call it an indexer - watches these deposit events. It maintains the full tree structure: which commitment is at which position.

When someone wants to withdraw, they give their deposit note to the backend. The backend looks up their leaf index, computes the Merkle proof from the tree, and returns it.

The withdrawal transaction then includes this Merkle proof, which the on-chain program verifies against the stored root.

---

## Demo Simplification

For this bootcamp demo, we simplify things.

We assume all other tree leaves are empty - filled with zeros. This means if you're the only depositor, your Merkle proof is just pre-computed zero hashes at each level.

This lets us skip building a full indexer service. The backend can compute proofs knowing just your deposit and assuming everything else is empty.

In a production system, you'd need a proper database storing all commitments and an indexer watching all deposit events. But that's infrastructure work, not ZK work. We'll skip it for learning.

---

## Why Root History?

One more detail: we don't store just one root. We store the last ten roots in what's called a ring buffer.

Why? Because Solana is fast. Really fast.

Imagine this scenario. You start generating a ZK proof. Your proof references the current Merkle root - let's call it root X.

But generating a proof takes thirty seconds. During that time, someone else deposits. The root changes to Y.

You submit your transaction with a proof against root X. But the current root is Y. Does your proof fail?

With a single root, yes. Your proof would be rejected because the root changed.

With root history, no. We keep the last ten roots. Your proof against the old root X still works, because X is still in our history.

This gives users timing flexibility. Start your proof, take your time, submit when ready. As long as the root you used is still in the recent history, you're good.

---

## Client-Computed Roots

You might wonder: who computes the new root when someone deposits?

The client does. Off-chain.

When you deposit, your frontend computes what the new Merkle root will be after adding your commitment. It submits this new root along with the commitment.

Is this safe? What if someone submits a wrong root?

Here's the thing: a wrong root is useless. If you submit an invalid root, anyone trying to prove against that root will fail. You can't create a valid Merkle proof for a tree that doesn't match the root.

So submitting a bad root only creates a root that no one can use. It doesn't help any attacker. The worst case is wasted space in the root history.

---

## One More Problem

We're almost there. We have:
- Commitments hiding deposit details
- Nullifiers preventing double-spends
- Merkle trees proving membership efficiently

But there's still a privacy leak. The Merkle proof itself reveals which commitment is ours.

If I provide a proof for the commitment at leaf index five, everyone knows I made deposit number five. The Merkle path is deterministic - given a leaf index, there's exactly one valid proof.

We need to hide the Merkle proof inside a zero-knowledge proof.

That's what we do next.
