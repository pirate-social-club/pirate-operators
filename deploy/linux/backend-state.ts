import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export const safeId = (value: string) => value.length > 0 && value.length <= 128 && !/[^a-zA-Z0-9_-]/.test(value);
export const rawDigest = (value: string) => value.length === 64 && !/[^a-f0-9]/.test(value);
/** Preserve the actual opaque installation reference. Durable native scope is
 * a separate explicitly recorded binding; it is never silently hashed here. */
export const installationReference = (value:string) => typeof value==="string" && value.length>0 && value.length<=200 && !/[\x00-\x1f\x7f]/.test(value);
export async function privateDirectory(path: string) {
  assert.equal(await realpath(path), path, "backend_path_not_canonical");
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid!() && !(info.mode & 0o077), "backend_private_directory_required");
}
export async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function privateFile(path: string, maxBytes: number) {
  assert.equal(await realpath(path), path, "backend_file_not_canonical");
  const before = await lstat(path);
  assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid!() && !(before.mode & 0o077), "backend_private_file_required");
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    assert(actual.dev === before.dev && actual.ino === before.ino && actual.isFile() && actual.nlink === 1 &&
      actual.size <= maxBytes && actual.uid === process.getuid!() && !(actual.mode & 0o077), "backend_file_changed");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function createJSON(directory: string, name: string, value: unknown) {
  await privateDirectory(directory); assert(safeId(name), "backend_evidence_name_invalid");
  const body = Buffer.from(JSON.stringify(value) + "\n"), path = join(directory, name + ".json");
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
  await syncDirectory(directory); return { relativePath: name + ".json", sha256: hash(body) };
}
export async function processIdentity(pid: number) {
  const prefix = "/proc/" + pid;
  let raw: string;
  try { raw = await (await import("node:fs/promises")).readFile(prefix + "/stat", "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
  const fs = await import("node:fs/promises");
  // Namespace denial is uncertainty, never process absence.
  const observed = { hostPid: pid, hostStartTicks: fields[19]!, hostGroup: Number(fields[2]), hostSession: Number(fields[3]),
    uid: (await lstat(prefix)).uid, pidNamespace: await fs.readlink(prefix + "/ns/pid"),
    networkNamespace: await fs.readlink(prefix + "/ns/net") };
  const after = await fs.readFile(prefix + "/stat", "utf8");
  const next = after.slice(after.lastIndexOf(")") + 2).split(/\s+/);
  assert.equal(next[19], observed.hostStartTicks, "backend_process_lifetime_changed_during_observation");
  return observed;
}
export type ProcessIdentity = NonNullable<Awaited<ReturnType<typeof processIdentity>>>;
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity | null) {
  return b !== null && ["hostPid", "hostStartTicks", "hostGroup", "hostSession", "uid", "pidNamespace", "networkNamespace"]
    .every((key) => a[key as keyof ProcessIdentity] === b[key as keyof ProcessIdentity]);
}

/** Persistent exclusive operation lease. A crash leaves a recoverable barrier.
 * No stale-lock stealing, permission repair, adoption or automatic retry. */
export async function acquireOperation(directory: string, operationId: string, installationId: string, intent: unknown,
  hostPidNamespace: string) {
  await privateDirectory(directory); assert(safeId(operationId) && installationReference(installationId));
  const observedHolder = await processIdentity(process.pid); assert(observedHolder && observedHolder.pidNamespace === hostPidNamespace, "backend_host_frame_unproved");
  const holder: ProcessIdentity = observedHolder;
  const leasePath = join(directory, "active-operation.json");
  const lease = await open(leasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const identity = await lease.stat(), intentDigest = hash(JSON.stringify(intent));
  const bytes = Buffer.from(JSON.stringify({ operationId, installationId, intentDigest, holder }) + "\n");
  try { await lease.writeFile(bytes); await lease.sync(); } finally { await lease.close(); }
  await syncDirectory(directory);
  const fileId = hash(operationId);
  const intentRef = await createJSON(directory, "intent-" + fileId, { operationId, installationId, intentDigest, intent });
  let sequence = 0, previous = intentRef.sha256, released = false;
  async function assertHeld() {
    assert(!released && sameProcess(holder, await processIdentity(process.pid)), "backend_custody_changed");
    const fd = await privateFile(leasePath, 65536);
    try {
      const current = await fd.stat(); assert(current.dev === identity.dev && current.ino === identity.ino);
      assert.equal(hash(await fd.readFile()), hash(bytes), "backend_custody_file_changed");
    } finally { await fd.close(); }
  }
  return {
    directory, operationId, installationId, holder, intentRef, assertHeld,
    async record(phase: string, facts: unknown) {
      await assertHeld(); assert(safeId(phase));
      const ref = await createJSON(directory, fileId + "-" + String(++sequence).padStart(4, "0") + "-" + hash(phase).slice(0, 16),
        { operationId, installationId, sequence, previous, phase, at: Date.now(), facts });
      previous = ref.sha256; return ref;
    },
    async release(): Promise<never> {
      await assertHeld();
      // A void callback cannot prove independent custody/resource/domain
      // admission. That actual owning join does not exist in these inputs yet.
      throw new Error("backend_release_authority_join_missing_preserve_original_operation");
    },
  };
}
export type OperationLease = Awaited<ReturnType<typeof acquireOperation>>;
