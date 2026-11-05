import { readFile, lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { insist, object } from "../packages/community/common.ts";
import { seal, unseal } from "../apps/creator-spike/infra/protected-data.ts";

export const creatorAccount = "08a4c22cf52e2ecae883e36f80a33f4a";
export const creatorDatabase = "2cdb3ab0-e45f-4a63-9d65-da0a6f1dd0ed";
export const creatorResources = {
  CreatorTestDatabase: {
    type: "Cloudflare.D1Database",
    identity: { databaseId: creatorDatabase },
  },
  WalletTest: {
    type: "Cloudflare.Worker",
    identity: {
      workerId: "fc39d9a234914a2ca83ff43c542f1eb0",
      workerName: "pirate-wallet-test",
    },
  },
  CommunityTest: {
    type: "Cloudflare.Worker",
    identity: {
      workerId: "d767e34b050243019a34cf7ed7fb9179",
      workerName: "pirate-creator-spike",
    },
  },
} as const;
const prefix = "pirate-creator-wallet-testnet/testnet/";
export const creatorOriginalState = join(
  homedir(),
  ".local/state/pirate-creator-wallet-testnet/alchemy/state",
);
export const fileDigest = (bytes: Uint8Array | string) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;

export function assertCreatorState(
  value: unknown,
  logical: string,
  secret?: string,
) {
  if (logical === "__stack_output__") return;
  const expected = creatorResources[logical as keyof typeof creatorResources];
  insist(expected, "unknown_creator_state", 409);
  const record = object(value),
    updating = record.status === "updating",
    attr = object(updating ? object(record.old).attr : record.attr);
  insist(
    ["created", "updated", "updating"].includes(String(record.status)) &&
      record.resourceType === expected.type &&
      record.logicalId === logical &&
      attr.accountId === creatorAccount &&
      Object.entries(expected.identity).every(([key, id]) => attr[key] === id),
    "creator_state_identity_changed",
    409,
  );
  if (secret && expected.type === "Cloudflare.Worker")
    insist(
      JSON.stringify(record).includes(secret),
      "creator_state_signer_changed",
      409,
    );
}
export async function creatorPredecessor(directory = creatorOriginalState) {
  const hashes: Record<string, string> = {};
  for (const logical of [
    ...Object.keys(creatorResources),
    "__stack_output__",
  ]) {
    const relative = `${prefix}${logical}.json`,
      path = join(directory, relative),
      metadata = await lstat(path);
    insist(
      metadata.isFile() &&
        metadata.uid === process.getuid!() &&
        !(metadata.mode & 0o077),
      "creator_predecessor_not_private",
      409,
    );
    const contents = await readFile(path, "utf8");
    assertCreatorState(JSON.parse(contents), logical);
    hashes[relative] = fileDigest(contents);
  }
  return hashes;
}
export async function verifyCreatorPredecessor(
  hashes: Record<string, string>,
  secret: string,
  directory = creatorOriginalState,
) {
  for (const [relative, digest] of Object.entries(hashes)) {
    insist(
      relative.startsWith(prefix) &&
        /^\w+\.json$/.test(relative.slice(prefix.length)),
      "invalid_creator_state_path",
      409,
    );
    const source = await readFile(join(directory, relative), "utf8");
    insist(fileDigest(source) === digest, "creator_predecessor_changed", 409);
    assertCreatorState(
      JSON.parse(source),
      relative.slice(prefix.length, -5),
      secret,
    );
  }
}

export async function verifyCreatorSuccessor(
  destination: string,
  hashes: Record<string, string>,
  password: string,
  secret: string,
) {
  for (const relative of Object.keys(hashes)) {
    insist(
      relative.startsWith(prefix) &&
        /^\w+\.json$/.test(relative.slice(prefix.length)),
      "invalid_creator_state_path",
      409,
    );
    const path = join(destination, relative),
      metadata = await lstat(path);
    insist(
      metadata.isFile() &&
        metadata.uid === process.getuid!() &&
        !(metadata.mode & 0o077),
      "creator_state_not_private",
      409,
    );
    assertCreatorState(
      JSON.parse(
        unseal(
          await readFile(path, "utf8"),
          password,
          `alchemy-state:${relative}`,
        ),
      ),
      relative.slice(prefix.length, -5),
      secret,
    );
  }
}
/** Restore a verified historical state into a separate encrypted successor.
 * Never changes or deletes the original plaintext-state preservation source. */
export async function restoreCreatorState(
  destination: string,
  hashes: Record<string, string>,
  password: string,
  secret: string,
  original = creatorOriginalState,
) {
  destination = resolve(destination);
  for (const [relative, digest] of Object.entries(hashes)) {
    insist(
      relative.startsWith(prefix) &&
        /^\w+\.json$/.test(relative.slice(prefix.length)),
      "invalid_creator_state_path",
      409,
    );
    const logical = relative.slice(prefix.length, -5),
      source = await readFile(join(original, relative), "utf8");
    insist(fileDigest(source) === digest, "creator_predecessor_changed", 409);
    assertCreatorState(JSON.parse(source), logical, secret);
    const file = join(destination, relative);
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    let exists = false;
    try {
      await lstat(file);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const metadata = await lstat(file);
      insist(
        metadata.isFile() &&
          metadata.uid === process.getuid!() &&
          !(metadata.mode & 0o077),
        "creator_state_not_private",
        409,
      );
      const current = JSON.parse(
        unseal(
          await readFile(file, "utf8"),
          password,
          `alchemy-state:${relative}`,
        ),
      );
      assertCreatorState(current, logical, secret);
      continue;
    }
    // A crash can leave only an opaque temporary file. The final state name
    // appears atomically after the complete encrypted bytes are fsynced.
    const temporary = `${file}.restore-${randomUUID()}.tmp`,
      handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        seal(source, password, `alchemy-state:${relative}`),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, file); // cannot replace another writer's state
    let parent = join(file, "..");
    for (;;) {
      const folder = await open(parent, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      const above = join(parent, "..");
      if (above === parent) break;
      parent = above;
    }
    await unlink(temporary); // the durable final name retains these same bytes
  }
}
