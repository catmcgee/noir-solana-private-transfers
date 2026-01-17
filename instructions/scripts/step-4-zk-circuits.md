# Step 4: ZK Circuits - Teleprompter Script

## Opening (Everything Comes Together)

This is where everything comes together. This is the magic step.

We have commitments that hide deposit details. We have nullifiers that prevent double-spending. We have Merkle trees that prove membership.

But the Merkle proof reveals which commitment is ours. If I show the proof for leaf five, everyone knows I'm the person who made deposit five.

So let's wrap everything in a zero-knowledge proof.

---

## What A ZK Proof Does

A ZK proof lets you prove a statement without revealing the data that makes it true.

In our case, we're proving: "I know a nullifier, secret, and amount. When I hash them together, I get a commitment. That commitment exists in the Merkle tree with this root. And when I hash just the nullifier, I get this nullifier hash."

The verifier checks this proof and becomes completely convinced that we have a valid deposit. But they learn nothing about which deposit it is.

They don't learn the nullifier. They don't learn the secret. They don't learn the leaf index. They don't learn the Merkle path. All of that stays private.

All they see is: valid proof, here's the nullifier hash, here's the root, here's the amount. Proceed with withdrawal.

---

## Choosing A Proof System

Solana doesn't have native ZK verification, so we need to pick a proof system. There are several options.

STARKs produce large proofs - around fifty kilobytes. Way too big for Solana's transaction limits. Also expensive to verify.

PLONK produces medium proofs - around five hundred bytes. Better, but verification still costs around two million compute units.

Groth16 produces tiny proofs - just two hundred fifty-six bytes. Verification costs about one-point-four million compute units.

For Solana, Groth16 is the clear winner. Smallest proofs, fastest verification, and good tooling through Sunspot.

---

## What Is Groth16?

Groth16 is a zk-SNARK. Let me unpack that acronym.

Zero-Knowledge: the verifier learns nothing about private inputs.

Succinct: the proof is tiny. Two hundred fifty-six bytes regardless of how complex the computation is.

Non-Interactive: there's no back-and-forth. The prover generates one proof, submits it, done.

Argument of Knowledge: the prover must actually know the private inputs. They can't fake it.

The proof itself consists of three elliptic curve points on something called the BN254 curve.

Point A is sixty-four bytes. Point B is one hundred twenty-eight bytes. Point C is sixty-four bytes. Total: two fifty-six bytes.

That's all you need to know about the math. The cryptography underneath is complex - elliptic curve pairings, polynomial commitments, lots of algebra. But thanks to tools like Noir and Sunspot, we don't need to understand it.

We write our logic. The tools handle the math.

---

## The Trusted Setup Trade-Off

There's one trade-off with Groth16 you should know about: it requires a trusted setup.

Before you can use a Groth16 circuit, someone needs to generate the proving and verification keys. This process involves random numbers that must be destroyed afterward.

If those random numbers were kept, someone could forge fake proofs. That would break the whole system.

For this tutorial, we generate keys locally. That's fine for learning - you're trusting yourself.

Production systems use what's called multi-party computation ceremonies. Dozens or hundreds of participants each contribute randomness. The setup is secure as long as at least one participant honestly destroyed their random values.

Famous projects like Zcash have done these ceremonies with thousands of participants. The probability that every single one was compromised approaches zero.

---

## Public Versus Private Inputs

Our circuit has two types of inputs. Understanding the difference is crucial.

Public inputs are visible to everyone. They go on-chain. The verifier needs to see them.

In our circuit, the public inputs are:
- The Merkle root we're proving against
- The nullifier hash (for double-spend tracking)
- The recipient address (prevents front-running)
- The amount being withdrawn

Private inputs are never revealed. Not to the blockchain, not to the verifier, not to anyone.

In our circuit, the private inputs are:
- The nullifier (your secret from deposit)
- The secret (more randomness from deposit)
- The Merkle proof path (ten sibling hashes)
- The path directions (which side at each level)

The proof attests that these private inputs exist and satisfy our constraints. But it reveals nothing about their actual values.

---

## What The Circuit Proves

Let me walk through what our circuit actually proves. There are four key assertions.

First: I can compute a valid commitment. Given my private nullifier, secret, and the public amount, the hash equals a commitment that exists in the tree.

Second: My nullifier hash is correct. Hash of my private nullifier equals the public nullifier hash I'm submitting.

Third: The commitment is in the tree. Starting from my commitment, using my private Merkle proof path, I can compute up to the public root.

Fourth: Everything is bound to this recipient. The public recipient address is included in the proof, so no one can front-run by substituting their address.

If all four assertions pass, the proof is valid. If any private input is wrong - even by one bit - the proof fails.

---

## Proof Generation Flow

Here's how proof generation works in practice.

You have your deposit note: nullifier, secret, amount, leaf index.

You give this to the backend. The backend:
1. Looks up the current Merkle root
2. Computes your Merkle proof path from the tree
3. Writes all inputs to a file
4. Runs the Noir circuit to generate a witness
5. Runs Sunspot to generate the Groth16 proof

This takes about thirty seconds. Proof generation is computationally intensive.

The result is a two-fifty-six byte proof. You include this in your withdrawal transaction.

---

## Sunspot Key Generation

Before we can generate proofs, we need proving and verification keys. Sunspot handles this.

First, we compile our Noir circuit. This produces an intermediate format called ACIR.

Then Sunspot converts ACIR to a format compatible with Groth16. This is called CCS.

Then Sunspot runs the setup ceremony, producing two files:
- The proving key, about two megabytes. Used client-side to generate proofs.
- The verification key, about one kilobyte. Baked into the on-chain verifier.

The verification key doesn't go into an account. Sunspot generates an entirely separate Solana program with the verification logic baked in. Our program calls this verifier via CPI.

---

## Noir Makes This Accessible

A few years ago, building a system like this required deep expertise in cryptography. You'd be writing constraint systems by hand, debugging arithmetic circuits, dealing with finite field arithmetic.

Noir changes that. You write code that looks almost like normal programming. Functions, variables, assertions. The compiler handles converting it to constraints.

You focus on the logic: "hash these values, check this equality, compute this Merkle root." Noir and Sunspot handle turning that into a ZK proof.

That's why we can teach this in a bootcamp. The tools have matured to where the cryptography is abstracted away.

---

## Let's Generate The Keys

Alright, let's run the Sunspot commands to generate our proving and verification keys.

Then in the next step, we'll deploy the verifier and wire up the CPI.
