# Step 6: Demo - Teleprompter Script

## Opening

Alright, we've built all the pieces. Commitments. Nullifiers. Merkle trees. ZK circuits. On-chain verification.

Now let's see it all work together.

I'm going to walk through the complete flow - deposit and withdraw - while explaining what's happening in the code.

---

## The Architecture

Before we start, let me remind you of the architecture.

We have a React frontend. This is where users interact - connect wallet, enter amounts, click buttons.

We have an Express backend. This handles the ZK stuff - computing hashes, generating proofs. Eventually, Sunspot will have client-side libraries and this backend won't be needed. But for now, proving happens server-side.

We have the Solana program. This stores state and verifies proofs on-chain.

And we have the Sunspot verifier. A separate program that does the cryptographic verification.

The frontend talks to the backend for ZK operations. The frontend talks to Solana for transactions. The Solana program talks to the Sunspot verifier via CPI.

---

## Connecting Wallet

First, we connect a wallet.

The frontend uses Solana Kit, the modern Solana JavaScript library. It auto-discovers wallet extensions like Phantom.

We're on devnet - Solana's persistent test network. You can get free SOL from faucets. Never use mainnet for testing - that's real money.

When you connect, the wallet gives us your public key. We can now build transactions that you'll sign.

---

## Making A Deposit

Now let's deposit some SOL.

When I click deposit, several things happen.

First, we call the backend API. We send the amount and our wallet address.

The backend generates two random field elements - the nullifier and secret. These are big numbers in a specific range compatible with our ZK circuit.

Then the backend runs the Noir hasher circuit. It computes the commitment - hash of nullifier, secret, and amount. It also computes the nullifier hash - hash of just the nullifier.

The backend returns two things: the deposit note, which contains our secrets, and the on-chain data, which contains the commitment and new Merkle root.

Next, on the frontend, we derive the PDAs.

We compute the pool address from the seed "pool." We compute the vault address from "vault" plus the pool address. These are deterministic - given the seeds and program ID, anyone can derive the same addresses.

Then we encode the instruction data.

Solana instructions are binary. We use a generated encoder that converts our JavaScript objects into the exact byte format the program expects. The format includes a discriminator - a hash of the instruction name - so the program knows which function to call.

Then we build and send the transaction.

The wallet pops up asking us to approve. When we sign, it submits to the network and waits for confirmation.

---

## The Deposit Note

After the deposit confirms, we get a deposit note.

This is crucial. This note contains our nullifier and secret. Without it, we cannot withdraw.

In a real application, you'd want to think carefully about how users store this. Local storage? Encrypted backup? Hardware wallet integration?

For the demo, we just display it. Copy it and save it somewhere. You'll need it in a minute.

---

## Switching Wallets

Now I'm going to switch to a completely different wallet.

This is the key demonstration. Alice deposited. Now Bob is going to withdraw. Two different people, two different wallets.

If this were a regular transfer, the blockchain would show Alice sent to Bob. Clear linkage.

With our private pool, the blockchain shows: someone deposited, someone withdrew. No linkage possible.

---

## Making A Withdrawal

Now let's withdraw using the deposit note.

I paste in the note from before. This contains the nullifier, secret, amount, and other metadata.

When I click withdraw, more complex things happen.

First, we call the backend again. This time for proof generation.

The backend reconstructs the Merkle proof - it computes the sibling hashes at each level of the tree. Then it writes all the inputs to a file: the public inputs (root, nullifier hash, recipient, amount) and the private inputs (nullifier, secret, Merkle proof, path directions).

Then it runs Noir to generate a witness - this is the intermediate computation trace.

Then it runs Sunspot to generate the actual Groth16 proof. This takes about thirty seconds. The proof is two hundred fifty-six bytes.

Back on the frontend, we need to request extra compute units.

We create a Compute Budget instruction asking for one-point-four million units. This goes first in our transaction.

Then we build the withdrawal instruction.

It includes the proof, the nullifier hash, the Merkle root, the recipient address, and the amount. The accounts include the pool, nullifier set, vault, recipient, and the Sunspot verifier program.

We send both instructions together. Atomic execution - both succeed or both fail.

---

## What Happens On-Chain

Let me trace through what the Solana program does when it receives our withdrawal.

First, it checks that the nullifier hash isn't already used. If it is, someone's trying to double-spend. Reject.

Second, it checks that the Merkle root exists in the root history. If not, the proof was made against an old or invalid root. Reject.

Third, it calls the Sunspot verifier via CPI. It passes the proof bytes and the encoded public inputs. The verifier checks the cryptographic equation. If invalid, it returns an error and our whole transaction fails.

If we get past the verifier, the proof is valid. We know the user has a legitimate deposit.

Fourth, we mark the nullifier hash as used. Add it to the nullifier set. This prevents using this deposit again.

Fifth, we transfer SOL from the vault to the recipient. The vault is a PDA, so the program can sign for it.

Done. The withdrawal completes.

---

## Checking The Explorer

Let's look at these transactions on Solana Explorer.

Here's the deposit transaction. Look at the logs. It shows the commitment hash and the leaf index. Notice there's no depositor address in the event.

Here's the withdrawal transaction. It shows the nullifier hash and the recipient. Notice there's no commitment reference.

Two transactions. Cryptographically unlinked. Privacy achieved.

---

## Recap: What You Built

Let me summarize the complete system.

Commitments hide deposit details. Instead of storing who deposited, we store a hash. The hash reveals nothing about the depositor.

Nullifiers prevent double-spending. Each deposit has a unique nullifier. When you withdraw, you reveal the nullifier hash. Same deposit, same nullifier, same hash. Can't withdraw twice.

Merkle trees prove membership efficiently. We store just the root on-chain - thirty-two bytes representing all deposits. Users prove their commitment exists with a compact proof.

ZK circuits tie it all together. We prove we know the commitment, we prove the nullifier hash matches, we prove the commitment is in the tree - all without revealing which commitment.

Sunspot verifies proofs on Solana. A CPI call checks the cryptographic equation. Invalid proofs fail. Valid proofs proceed.

---

## Limitations

A few limitations to remember.

This is educational code, not production code. It hasn't been audited. Don't deploy this with real funds.

Variable amounts reduce privacy. If you deposit one-point-two-three-four-five-six-seven SOL and someone withdraws that exact amount, correlation is easy. Fixed amounts provide stronger anonymity.

The nullifier set is capped at two hundred fifty-six entries. A production system would use a Merkle tree of nullifiers to scale.

The Merkle tree isn't fully implemented for multiple deposits. Our demo assumes single deposits with empty tree leaves. A production system needs an indexer service.

---

## What's Next

If you want to take this further, here are some ideas.

Implement fixed deposit amounts for stronger privacy. Everyone deposits exactly one SOL. Withdrawals become indistinguishable.

Build a proper indexer service. Watch deposit events, maintain the full Merkle tree, serve proofs on demand.

Scale the nullifier set. Use a Merkle tree instead of a Vec to support unlimited withdrawals.

Add relayers for transaction privacy. Right now, the withdrawer submits the transaction. Their IP and wallet pay fees. A relayer system hides even that.

---

## Closing

Congratulations. You've built a privacy-preserving transfer system on Solana.

You understand commitments and nullifiers. You understand Merkle trees and membership proofs. You understand zero-knowledge proofs and on-chain verification.

These are foundational concepts that appear throughout blockchain privacy technology. Tornado Cash, Zcash, Aztec - they all use variations of these ideas.

You now have the knowledge to understand how these systems work, and the practical experience of building one yourself.

Thanks for following along.
