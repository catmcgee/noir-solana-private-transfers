# Private Transfers on Solana with Noir ZK

## What You'll Build

In this tutorial, you'll build a privacy-preserving transfer system on Solana using zero-knowledge proofs. By the end, you'll have a working application where:

- Users can deposit SOL into a pool
- Deposits are hidden behind cryptographic commitments
- Users can withdraw to any wallet without revealing which deposit was theirs
- Double-spending is prevented without compromising privacy

## How It Works

The system uses several cryptographic primitives working together:

1. **Commitments** - Hide deposit details in a hash
2. **Nullifiers** - Prevent double-spending without revealing which deposit
3. **Merkle Trees** - Efficiently prove a deposit exists
4. **ZK Circuits** - Prove everything without revealing anything
5. **On-chain Verification** - Trustlessly verify proofs on Solana

## Prerequisites

Before starting, make sure you have installed:

- [Bun](https://bun.sh) - Package manager
- [Noir/Nargo v1.0.0-beta.13](https://noir-lang.org/docs) - ZK circuit compiler
- [Sunspot CLI](https://github.com/reilabs/sunspot) - Solana ZK verifier
- [Anchor v1.0.0-rc.2](https://anchor-lang.com) - Solana framework
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) - Solana tools

## Tutorial Steps

| Step | Topic | What You'll Learn |
|------|-------|-------------------|
| 0 | [Introduction](./step-0-introduction.md) | Understanding the problem and starter code |
| 1 | [Commitments](./step-1-commitments.md) | Hiding deposit details with hashes |
| 2 | [Nullifiers](./step-2-nullifiers.md) | Preventing double-spending privately |
| 3 | [Merkle Trees](./step-3-merkle-trees.md) | Efficient membership proofs |
| 4 | [ZK Circuits](./step-4-zk-circuits.md) | Understanding the withdrawal proof |
| 5 | [Sunspot Verification](./step-5-sunspot-verification.md) | On-chain proof verification |
| 6 | [Demo](./step-6-demo.md) | Running the complete system |

**Appendix**: [Client Architecture](./step-client-architecture.md) - How the frontend/backend generate hashes and proofs

## Quick Start

```bash
# Clone the repo and install dependencies
bun install

# Build the starter
cd anchor
anchor build

# Verify circuits compile
cd ../circuits/hasher && nargo compile
cd ../withdrawal && nargo compile

# Start the frontend
cd ../../frontend && bun run dev
```

## Architecture Overview

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │      │                 │
│    Frontend     │─────▶│    Backend      │─────▶│  Noir Circuits  │
│    (React)      │      │   (Express)     │      │   (nargo CLI)   │
│                 │◀─────│                 │◀─────│                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
        │                                                  │
        │                                                  │
        ▼                                                  ▼
┌─────────────────┐                              ┌─────────────────┐
│                 │                              │                 │
│  Solana RPC     │◀────────────────────────────│ Sunspot Verifier│
│                 │                              │   (on-chain)    │
└─────────────────┘                              └─────────────────┘
```

## Project Structure

```
noir-solana-private-transfers/
├── circuits/                    # Noir ZK circuits (already complete)
│   ├── hasher/                  # Computes commitment & nullifier_hash
│   ├── merkle-hasher/           # Computes Merkle roots
│   └── withdrawal/              # Main withdrawal proof circuit
├── anchor/                      # Solana program
│   └── programs/private_transfers/src/lib.rs  # You'll modify this
├── backend/                     # Proof generation server
├── frontend/                    # React UI
└── instructions/                # This tutorial
```

## Learning Path

This tutorial focuses on **Solana integration** with ZK proofs. The Noir circuits are already complete - you'll walk through them to understand what they do, then implement the Solana program that uses them.

**You'll modify:** `anchor/programs/private_transfers/src/lib.rs`

**You'll understand:** The Noir circuits in `circuits/`

Ready? Start with [Step 0: Introduction](./step-0-introduction.md).
