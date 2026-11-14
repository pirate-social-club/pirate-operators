import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

export const MAX_MANIFEST = 16 * 1024 * 1024;
export const MAX_FILES = 100_000;
// This version uses one GCM message. Keep payload plus metadata comfortably
// below its per-message bound; larger cohorts need a new chunked format.
export const MAX_BYTES = 32 * 1024 ** 3;
export interface CohortIdentity {
  deploymentId: string;
  releaseSha256: string;
  backendSha256: string;
  profileSha256: string;
  origin: string;
  communityId: string;
  // A reference to the actual stopped-writer receipt, not a verified flag.
  // The caller must authenticate that receipt and the complete writer inventory.
  writerFenceSha256: string;
}
export interface CohortFile { path: string; bytes: number; sha256: string }
export interface CohortManifest {
  schema: "pirate.cold-cohort/1";
  identity: CohortIdentity;
  roles: string[];
  directories: string[];
  files: CohortFile[];
  totalBytes: number;
}
export interface Snapshot {
  manifest: CohortManifest;
  roots: Readonly<Record<string, string>>;
  witnesses: Readonly<Record<string, string>>;
}

export const sha256 = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
export const isDigest = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const label = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 &&
  /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:-]/.test(value);
const roleValid = (role: unknown): role is string => typeof role === "string" &&
  role.length > 0 && role.length <= 48 && /^[a-z]/.test(role) && !/[^a-z0-9-]/.test(role);
export function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "cohort_object_required");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "cohort_fields_invalid");
}
export function statePath(value: unknown): asserts value is string {
  assert(typeof value === "string" && value.length <= 1024, "cohort_path_invalid");
  const parts = value.split("/");
  assert(parts.length <= 32 && parts.every((part) =>
    part.length > 0 && part.length <= 128 && part !== "." && part !== ".." && !/[^A-Za-z0-9._-]/.test(part)),
  "cohort_path_invalid");
}
export function validateIdentity(value: unknown): asserts value is CohortIdentity {
  exactKeys(value, ["deploymentId", "releaseSha256", "backendSha256", "profileSha256", "origin", "communityId", "writerFenceSha256"]);
  assert(label(value.deploymentId) && isDigest(value.releaseSha256) && isDigest(value.backendSha256) &&
    isDigest(value.profileSha256) && isDigest(value.writerFenceSha256), "cohort_identity_invalid");
  assert(typeof value.communityId === "string" && value.communityId.length === 66 &&
    /^0x[a-f0-9]{64}$/.test(value.communityId), "cohort_community_invalid");
  assert(typeof value.origin === "string", "cohort_origin_invalid");
  const url = new URL(value.origin);
  assert(url.protocol === "https:" && url.origin === value.origin && !url.username && !url.password,
    "cohort_origin_invalid");
}
export function validateManifest(value: unknown): asserts value is CohortManifest {
  exactKeys(value, ["schema", "identity", "roles", "directories", "files", "totalBytes"]);
  assert.equal(value.schema, "pirate.cold-cohort/1"); validateIdentity(value.identity);
  assert(Array.isArray(value.roles) && value.roles.length > 0 && value.roles.length <= 64 &&
    value.roles.every(roleValid), "cohort_roles_invalid");
  assert.deepEqual(value.roles, [...new Set(value.roles)].sort(), "cohort_roles_invalid");
  assert(Array.isArray(value.directories) && value.directories.length <= MAX_FILES &&
    Array.isArray(value.files) && value.files.length <= MAX_FILES, "cohort_inventory_limit");
  const directories = value.directories as unknown[];
  directories.forEach(statePath);
  assert.deepEqual(directories, [...new Set(directories)].sort(), "cohort_directories_invalid");
  const directorySet = new Set(directories as string[]);
  assert((value.roles as string[]).every((role) => directorySet.has(role)), "cohort_root_missing");
  const paths: string[] = [];
  let total = 0;
  for (const item of value.files) {
    exactKeys(item, ["path", "bytes", "sha256"]); statePath(item.path);
    assert(Number.isSafeInteger(item.bytes) && (item.bytes as number) >= 0 && isDigest(item.sha256), "cohort_file_invalid");
    assert(!directorySet.has(item.path), "cohort_path_conflict");
    paths.push(item.path); total += item.bytes as number;
    assert(Number.isSafeInteger(total) && total <= MAX_BYTES, "cohort_size_limit");
  }
  assert.deepEqual(paths, [...new Set(paths)].sort(), "cohort_files_invalid");
  for (const path of [...directories as string[], ...paths]) {
    const parts = path.split("/");
    assert(!(parts.length === 2 && parts[1] === "restore-fence.json"), "cohort_unreconciled_restore");
    assert((value.roles as string[]).includes(parts[0]!), "cohort_role_mismatch");
    for (let n = 1; n < parts.length; n++) assert(directorySet.has(parts.slice(0, n).join("/")), "cohort_parent_missing");
  }
  assert.equal(value.totalBytes, total, "cohort_total_invalid");
}
export async function privateDirectory(path: string) {
  assert.equal(await realpath(path), path, "cohort_directory_not_canonical");
  const s = await lstat(path);
  assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid!() &&
    (s.mode & 0o077) === 0, "cohort_directory_not_private");
}
export async function regular(path: string) {
  assert.equal(await realpath(path), path, "cohort_file_not_canonical");
  const before = await lstat(path, { bigint: true });
  assert(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid!()),
    "cohort_file_not_owned_regular");
  // A raced FIFO must not block an open before the descriptor can be checked.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat({ bigint: true });
    assert(s.isFile() && s.nlink === 1n && s.uid === BigInt(process.getuid!()), "cohort_file_not_owned_regular");
    assert(s.dev === before.dev && s.ino === before.ino, "cohort_file_changed");
    assert(s.size <= BigInt(MAX_BYTES), "cohort_size_limit");
    return file;
  } catch (error) { await file.close(); throw error; }
}
export async function stamp(file: FileHandle) {
  const s = await file.stat({ bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}
export async function* stableBytes(path: string, expectedStamp?: string) {
  const file = await regular(path);
  try {
    const before = await stamp(file);
    if (expectedStamp !== undefined) assert.equal(before, expectedStamp, "cohort_file_changed");
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) yield chunk as Buffer;
    assert.equal(await stamp(file), before, "cohort_file_changed");
  } finally { await file.close(); }
}
export async function captureSnapshot(identity: CohortIdentity, bindings: Readonly<Record<string, string>>): Promise<Snapshot> {
  validateIdentity(identity);
  const roots = { ...bindings }, roles = Object.keys(roots).sort();
  assert(roles.length > 0 && roles.length <= 64 && roles.every(roleValid), "cohort_roles_invalid");
  for (const root of Object.values(roots)) await privateDirectory(root);
  const allRoots = Object.values(roots);
  assert(new Set(allRoots).size === allRoots.length && allRoots.every((a) =>
    allRoots.every((b) => a === b || !a.startsWith(b + "/"))), "cohort_root_alias");
  const directories: string[] = [], files: CohortFile[] = [], witnesses: Record<string, string> = {};
  let totalBytes = 0;
  async function visit(path: string, relative: string): Promise<void> {
    statePath(relative); const s = await lstat(path);
    assert(!s.isSymbolicLink() && s.uid === process.getuid!(), "cohort_path_not_owned");
    if (s.isDirectory()) {
      assert.equal(await realpath(path), path, "cohort_directory_changed"); directories.push(relative);
      assert(directories.length <= MAX_FILES, "cohort_inventory_limit");
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative + "/" + name);
    } else {
      assert(s.isFile() && s.nlink === 1, "cohort_file_not_owned_regular");
      const file = await regular(path); const witness = await stamp(file); await file.close();
      let bytes = 0; const hash = createHash("sha256");
      for await (const chunk of stableBytes(path, witness)) {
        bytes += chunk.length; assert(totalBytes + bytes <= MAX_BYTES, "cohort_size_limit"); hash.update(chunk);
      }
      totalBytes += bytes;
      witnesses[relative] = witness; files.push({ path: relative, bytes, sha256: hash.digest("hex") });
      assert(files.length <= MAX_FILES, "cohort_inventory_limit");
    }
  }
  for (const role of roles) await visit(roots[role]!, role);
  const manifest: CohortManifest = { schema: "pirate.cold-cohort/1", identity: structuredClone(identity), roles,
    directories: directories.sort(), files,
    totalBytes };
  // All admitted path characters are ASCII. Use byte order, not locale order.
  manifest.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  validateManifest(manifest);
  return { manifest, roots, witnesses };
}
export function sourcePath(snapshot: Snapshot, relative: string) {
  statePath(relative); const [role, ...parts] = relative.split("/");
  assert(snapshot.roots[role!] && parts.length > 0, "cohort_role_mismatch");
  return join(snapshot.roots[role!]!, ...parts);
}
