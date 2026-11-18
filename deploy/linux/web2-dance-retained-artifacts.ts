import assert from "node:assert/strict";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { privateFile } from "./backend-state.ts";

export async function readDanceActivationArtifact(
  path: string, maxBytes: number, selected?: BigIntStats,
) {
  const file = await privateFile(path, maxBytes);
  try {
    const before = await file.stat({ bigint: true });
    assert(!selected || selected.dev === before.dev && selected.ino === before.ino &&
      selected.size === before.size && selected.mtimeNs === before.mtimeNs && selected.ctimeNs === before.ctimeNs,
      "web2_dance_activation_file_changed");
    // Read at most the admitted size plus one byte, even if a writer grows it.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    assert(length <= maxBytes && BigInt(length) === before.size && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      named.dev === after.dev && named.ino === after.ino && named.nlink === 1n &&
      named.size === after.size && named.mtimeNs === after.mtimeNs && named.ctimeNs === after.ctimeNs,
      "web2_dance_activation_file_changed");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

export async function readOptionalDanceActivationArtifact(path: string, maxBytes: number) {
  let selected: BigIntStats;
  try {
    // Only an absent directory entry disables activation. A dangling symlink,
    // raced rename or failed read of a present entry must refuse.
    selected = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readDanceActivationArtifact(path, maxBytes, selected);
}

export async function retainDanceActivationArtifact(path: string, value: string, bound: number) {
  assert(Buffer.byteLength(value) <= bound, "web2_dance_activation_artifact_too_large");
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assert(await readDanceActivationArtifact(path, bound) === value, "web2_dance_activation_original_changed");
    const prior = await privateFile(path, bound);
    try { await prior.sync(); } finally { await prior.close(); }
    return;
  }
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
