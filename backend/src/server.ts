import express from "express";
import cors from "cors";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { createSolanaRpc, address } from "@solana/kit";
import bs58 from "bs58";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const DEVNET_ENDPOINT = "https://api.devnet.solana.com";
const rpc = createSolanaRpc(DEVNET_ENDPOINT);

const LAMPORTS_PER_SOL = 1_000_000_000n;

const HASHER_DIR = path.resolve(__dirname, "../../circuits/hasher");
const MERKLE_HASHER_DIR = path.resolve(
  __dirname,
  "../../circuits/merkle-hasher"
);
const WITHDRAWAL_DIR = path.resolve(__dirname, "../../circuits/withdrawal");
const SUNSPOT_BIN = process.env.SUNSPOT_BIN || "sunspot";

const PROGRAM_ID = address("2QRZu5cWy8x8jEFc9nhsnrnQSMAKwNpiLpCXrMRb3oUn");

const BN254_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
const TREE_DEPTH = 10;

// Pre-computed zeros for empty Merkle tree (Poseidon2 hashes)
const EMPTY_TREE_ZEROS = [
  "0x00",
  "0x228981b886e5effb2c05a6be7ab4a05fde6bf702a2d039e46c87057dd729ef97",
  "0x2f6a8be8895ea075e9886e26117e7548e47d1a2f2b5cc2c59c12b9cc0d8e59ce",
  "0x1279f65e8f84160aaa3197fa899787e63fef6b534ce28f13d4de46780c634a3d",
  "0x0ea5554534bc087eb074801b9d30dec37bac8bcee7d91dd174df44d8c8ccb33c",
  "0x0939e2e1ac7fa082c6057be7c26f2c5b02a6f4af4689b68c8bf2f17520d40454",
  "0x22b3ae9d6c2ed095bafefb4a6be76af3220e1ce409c2e0997cd1aa78233e08f6",
  "0x077307ac8beaee984464a1e8955a43679bc81fe5aeedbfa7e48ea1cf9f22b964",
  "0x1c4fce8686b33085507decf4a69fc35d7362eddd5e56f501a267c137a8808550",
  "0x2b8dd4f519cb1722919e2e99428f5c5df73695e09983eb994375ff5b793ba34f",
];

async function getNextLeafIndex(): Promise<number> {
  try {
    // Find pool PDA
    const poolSeed = Buffer.from("pool");
    const programIdBytes = bs58.decode(PROGRAM_ID);

    // Derive PDA (simplified - in production use @solana/kit properly)
    const seeds = [poolSeed];
    let bump = 255;
    let poolPda: string | null = null;

    // Try to find valid bump
    while (bump >= 0) {
      try {
        const seedsWithBump = [...seeds, Buffer.from([bump])];
        const hash = crypto.createHash("sha256");
        for (const seed of seedsWithBump) {
          hash.update(seed);
        }
        hash.update(programIdBytes);
        hash.update(Buffer.from("ProgramDerivedAddress"));

        const derived = hash.digest();
        // Check if on curve - simplified check
        poolPda = bs58.encode(derived.slice(0, 32));
        break;
      } catch {
        bump--;
      }
    }

    if (!poolPda) {
      console.log("Could not derive pool PDA, using index 0");
      return 0;
    }

    const accountInfo = await rpc
      .getAccountInfo(address(poolPda), { encoding: "base64" })
      .send();

    if (!accountInfo.value) {
      console.log("Pool not initialized, using index 0");
      return 0;
    }

    // Parse pool account data
    // Layout: discriminator (8) + authority (32) + next_leaf_index (8) + ...
    const data = Buffer.from(accountInfo.value.data[0], "base64");
    const nextLeafIndex = data.readBigUInt64LE(40); // offset 8 + 32 = 40

    return Number(nextLeafIndex);
  } catch (error) {
    console.log("Error fetching leaf index, using 0:", error);
    return 0;
  }
}

function generateRandomField(): bigint {
  let value: bigint;
  do {
    const bytes = crypto.randomBytes(32);
    value = BigInt("0x" + bytes.toString("hex"));
  } while (value >= BN254_MODULUS);
  return value;
}

function computeHashes(
  nullifier: bigint,
  secret: bigint,
  amount: bigint
): {
  commitment: string;
  nullifierHash: string;
} {
  const proverToml = `nullifier = "${nullifier}"
secret = "${secret}"
amount = "${amount}"
`;
  fs.writeFileSync(path.join(HASHER_DIR, "Prover.toml"), proverToml);

  const result = execSync("nargo execute 2>&1", {
    cwd: HASHER_DIR,
    encoding: "utf-8",
  });

  const outputMatch = result.match(/Circuit output: \(([^,]+),\s*([^)]+)\)/);
  if (!outputMatch) {
    throw new Error(`Failed to parse hasher output: ${result}`);
  }

  return {
    commitment: outputMatch[1].trim(),
    nullifierHash: outputMatch[2].trim(),
  };
}

function computeMerkleRoot(commitment: string, leafIndex: number): string {
  const proverToml = `leaf = "${commitment}"\nleaf_index = "${leafIndex}"\n`;
  fs.writeFileSync(path.join(MERKLE_HASHER_DIR, "Prover.toml"), proverToml);

  const result = execSync("nargo execute 2>&1", {
    cwd: MERKLE_HASHER_DIR,
    encoding: "utf-8",
  });

  const outputMatch = result.match(/Circuit output: (0x[a-fA-F0-9]+)/);
  if (!outputMatch) {
    throw new Error(`Failed to parse merkle-hasher output: ${result}`);
  }

  return outputMatch[1];
}

function pubkeyToField(pubkeyBase58: string): string {
  const bytes = bs58.decode(pubkeyBase58);

  if (bytes.length !== 32) {
    throw new Error(
      `Invalid pubkey length: expected 32 bytes, got ${bytes.length}`
    );
  }

  // Take first 31 bytes to fit within BN254 field modulus
  const truncatedBytes = bytes.slice(0, 31);
  const hex = Buffer.from(truncatedBytes).toString("hex");
  const value = BigInt("0x" + hex);

  if (value >= BN254_MODULUS) {
    throw new Error("Pubkey conversion resulted in value outside field");
  }

  return value.toString();
}

function getMerkleProof(leafIndex: number): {
  proof: string[];
  isEven: boolean[];
} {
  const proof: string[] = [];
  const isEven: boolean[] = [];

  let idx = leafIndex;
  for (let i = 0; i < TREE_DEPTH; i++) {
    // At each level, sibling is an empty subtree (zeros[i])
    proof.push(EMPTY_TREE_ZEROS[i]);
    // is_even = true means leaf is on left (even index at this level)
    isEven.push((idx & 1) === 0);
    idx = idx >> 1;
  }

  return { proof, isEven };
}

function writeProverToml(
  nullifier: string,
  secret: string,
  amount: string,
  nullifierHash: string,
  recipient: string,
  merkleRoot: string,
  merkleProof: string[],
  isEven: boolean[]
): void {
  const toml = `# Generated by backend API
# Public Inputs
root = "${merkleRoot}"
nullifier_hash = "${nullifierHash}"
recipient = "${recipient}"
amount = "${amount}"

# Private Inputs
nullifier = "${nullifier}"
secret = "${secret}"

merkle_proof = [
    ${merkleProof.map((p) => `"${p}"`).join(",\n    ")}
]

is_even = [${isEven.join(", ")}]
`;
  fs.writeFileSync(path.join(WITHDRAWAL_DIR, "Prover.toml"), toml);
}

function generateProof(): { proof: Buffer; publicWitness: Buffer } {
  execSync("nargo execute", {
    cwd: WITHDRAWAL_DIR,
    stdio: "pipe",
  });

  execSync(
    `${SUNSPOT_BIN} prove target/withdrawal.json target/withdrawal.gz target/withdrawal.ccs target/withdrawal.pk`,
    {
      cwd: WITHDRAWAL_DIR,
      stdio: "pipe",
    }
  );

  const proof = fs.readFileSync(
    path.join(WITHDRAWAL_DIR, "target/withdrawal.proof")
  );
  const publicWitness = fs.readFileSync(
    path.join(WITHDRAWAL_DIR, "target/withdrawal.pw")
  );

  return { proof, publicWitness };
}

// ============ API ENDPOINTS ============

app.post("/api/deposit", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || isNaN(Number(amount))) {
      return res
        .status(400)
        .json({ error: "Invalid amount: must be a number" });
    }

    const amountNum = Number(amount);
    if (amountNum <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid amount: must be positive" });
    }

    if (!Number.isInteger(amountNum)) {
      return res
        .status(400)
        .json({ error: "Invalid amount: must be an integer (lamports)" });
    }

    const MIN_DEPOSIT = 1_000_000;
    if (amountNum < MIN_DEPOSIT) {
      return res.status(400).json({
        error: `Invalid amount: minimum deposit is ${MIN_DEPOSIT} lamports (0.001 SOL)`,
      });
    }

    const leafIndex = await getNextLeafIndex();
    console.log(
      `Generating deposit for ${amount} lamports at leaf index ${leafIndex}...`
    );

    const nullifier = generateRandomField();
    const secret = generateRandomField();
    const amountBigInt = BigInt(amount);

    const hashes = computeHashes(nullifier, secret, amountBigInt);
    const merkleRoot = computeMerkleRoot(hashes.commitment, leafIndex);

    const depositNote = {
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      amount: amount.toString(),
      commitment: hashes.commitment,
      nullifierHash: hashes.nullifierHash,
      merkleRoot: merkleRoot,
      leafIndex: leafIndex,
      timestamp: Date.now(),
    };

    const commitmentBytes = Array.from(
      Buffer.from(hashes.commitment.slice(2), "hex")
    );
    const merkleRootBytes = Array.from(Buffer.from(merkleRoot.slice(2), "hex"));

    console.log(
      `Deposit note generated: ${hashes.commitment.slice(
        0,
        16
      )}... at index ${leafIndex}`
    );

    res.json({
      depositNote,
      onChainData: {
        commitment: commitmentBytes,
        newRoot: merkleRootBytes,
        amount: amount.toString(),
      },
    });
  } catch (error) {
    console.error("Deposit generation error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.post("/api/withdraw", (req, res) => {
  try {
    const { depositNote, recipient } = req.body;

    if (!depositNote) {
      return res.status(400).json({ error: "Missing depositNote" });
    }

    if (!recipient) {
      return res.status(400).json({ error: "Missing recipient address" });
    }

    const requiredFields = [
      "nullifier",
      "secret",
      "amount",
      "commitment",
      "nullifierHash",
      "merkleRoot",
      "leafIndex",
    ];
    for (const field of requiredFields) {
      if (depositNote[field] === undefined) {
        return res
          .status(400)
          .json({ error: `Invalid depositNote: missing ${field}` });
      }
    }

    try {
      const decoded = bs58.decode(recipient);
      if (decoded.length !== 32) {
        return res.status(400).json({
          error: "Invalid recipient: must be a 32-byte Solana address",
        });
      }
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid recipient: not valid base58" });
    }

    const leafIndex = Number(depositNote.leafIndex);
    console.log(
      `Generating withdrawal proof for recipient ${recipient} at leaf index ${leafIndex}...`
    );

    const recipientField = pubkeyToField(recipient);
    const { proof: merkleProof, isEven } = getMerkleProof(leafIndex);

    writeProverToml(
      depositNote.nullifier,
      depositNote.secret,
      depositNote.amount,
      depositNote.nullifierHash,
      recipientField,
      depositNote.merkleRoot,
      merkleProof,
      isEven
    );

    console.log("Generating ZK proof...");
    const { proof, publicWitness } = generateProof();

    console.log(`Proof generated: ${proof.length} bytes`);

    const withdrawalProof = {
      proof: Array.from(proof),
      publicWitness: Array.from(publicWitness),
      nullifierHash: depositNote.nullifierHash,
      merkleRoot: depositNote.merkleRoot,
      recipient: recipient,
      amount: depositNote.amount,
    };

    res.json({ withdrawalProof });
  } catch (error) {
    console.error("Withdrawal proof generation error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/airdrop", async (req, res) => {
  try {
    const { address: addressStr, amount } = req.body;

    if (!addressStr) {
      return res.status(400).json({ error: "Missing address" });
    }

    const recipient = address(addressStr);
    const lamports = BigInt(amount || LAMPORTS_PER_SOL);

    console.log(
      `Requesting airdrop of ${
        Number(lamports) / Number(LAMPORTS_PER_SOL)
      } SOL to ${addressStr}...`
    );

    const airdropSignature = await rpc
      .requestAirdrop(recipient, lamports)
      .send();

    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const {
        value: [status],
      } = await rpc.getSignatureStatuses([airdropSignature]).send();
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        confirmed = true;
      }
    }

    if (!confirmed) {
      throw new Error("Airdrop confirmation timeout");
    }

    console.log(`Airdrop successful: ${airdropSignature}`);
    res.json({ success: true, signature: airdropSignature });
  } catch (error) {
    console.error("Airdrop error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 4001;

app.listen(PORT, () => {
  console.log(`Backend API server running on http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  POST /api/deposit - Generate deposit note");
  console.log("  POST /api/withdraw - Generate withdrawal proof");
  console.log("  POST /api/airdrop - Request devnet SOL airdrop");
  console.log("  GET /api/health - Health check");
});
