import { readFile, lstat, open, link, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { canonical, insist, object } from "../packages/community/common.ts";

export const digest = (bytes: Uint8Array | string) =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;
export async function privateJson(path: string) {
  try {
    const stat = await lstat(path);
    insist(
      stat.isFile() && stat.uid === process.getuid!() && !(stat.mode & 0o077),
      "community_metadata_not_private",
      409,
    );
    return object(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/** A final name appears only after complete bytes are durable. A lost response
 * can reuse the same document; a conflicting committed value is never replaced. */
export async function durableJson(
  path: string,
  value: unknown,
  boundary?: (phase: "prepared" | "committed") => Promise<void>,
) {
  const temporary = `${path}.${randomUUID()}.tmp`,
    handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await boundary?.("prepared");
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await privateJson(path);
    insist(
      existing && canonical(existing) === canonical(value),
      "community_metadata_conflict",
      409,
    );
  }
  const parent = await open(join(path, ".."), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  await boundary?.("committed");
  await unlink(temporary);
}
/** Replace reviewed metadata only when its exact predecessor remains present. */
export async function replacePrivateJson(
  path: string,
  value: unknown,
  previousDigest: string,
) {
  const old = await readFile(path);
  insist(
    digest(old) === previousDigest,
    "reviewed_metadata_predecessor_changed",
    409,
  );
  const temporary = `${path}.${randomUUID()}.tmp`,
    handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  insist(
    digest(await readFile(path)) === previousDigest,
    "reviewed_metadata_predecessor_changed",
    409,
  );
  await rename(temporary, path);
  const parent = await open(join(path, ".."), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
