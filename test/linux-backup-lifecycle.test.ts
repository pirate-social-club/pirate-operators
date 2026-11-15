import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOperation, hash, privateFile, processIdentity } from "../deploy/linux/backend-state.ts";
import { createBackupStaging, withRecoveryKeyFd } from "../deploy/linux/backup-staging.ts";

// Real filesystem unit boundaries only. These do not establish native host
// custody, encryption, Docker writer fencing or application recovery acceptance.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pirate-backup-boundary-"));
  const operations = join(root, "operations"), staging = join(root, "staging");
  await mkdir(operations, { mode: 0o700 }); await mkdir(staging, { mode: 0o700 });
  const actual = await processIdentity(process.pid); assert(actual);
  const lease = await acquireOperation(operations, "operation-1", "1".repeat(64), { test: "filesystem-only" }, actual.pidNamespace);
  return { root, operations, staging, lease, close: () => rm(root, { recursive: true, force: true }) };
}
async function* chunks(...values: Uint8Array[]) { for (const value of values) yield value; }

test("exclusive durable operation preserves the original identity on a competing attempt", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.operations, "active-operation.json"));
    await f.lease.assertHeld();
    await assert.rejects(acquireOperation(f.operations, "operation-2", "1".repeat(64), {}, f.lease.holder.pidNamespace), { code: "EEXIST" });
    assert.deepEqual(await readFile(join(f.operations, "active-operation.json")), before);
  } finally { await f.close(); }
});
test("ciphertext staging consumes a full lost-response replay without changing identity", async () => {
  const f = await fixture();
  try {
    const storage = await createBackupStaging(f.staging, f.lease), body = new TextEncoder().encode("opaque staged bytes");
    const first = await storage.stageBackup({ requestId: "request-1", byteLength: body.length, bytes: chunks(body) });
    let consumed = false;
    async function* replay() { yield body.subarray(0, 3); yield body.subarray(3); consumed = true; }
    const next = await storage.stageBackup({ requestId: "request-1", byteLength: body.length, bytes: replay() });
    assert(consumed); assert.deepEqual(next, first); assert.equal(first.ciphertextDigest, "0x" + hash(body));
    assert.deepEqual(await storage.reconcileStaged(first.backupId), {
      backupId: first.backupId, ciphertextDigest: first.ciphertextDigest, byteLength: body.length,
      intent: { relativePath: first.backupId + "-intent.json", sha256: hash(JSON.stringify({ requestId: "request-1", byteLength: body.length }) + "\n") },
    });
  } finally { await f.close(); }
});
test("a truncated upload retains its original partial and refuses a replacement", async () => {
  const f = await fixture();
  try {
    const storage = await createBackupStaging(f.staging, f.lease);
    await assert.rejects(storage.stageBackup({ requestId: "incomplete", byteLength: 8, bytes: chunks(new Uint8Array([1, 2])) }));
    const files = await readdir(f.staging); assert(files.some((file) => file.endsWith(".partial")));
    await assert.rejects(storage.stageBackup({ requestId: "incomplete", byteLength: 8, bytes: chunks(new Uint8Array(8)) }),
      /backup_upload_uncertain_reconcile_original_request/);
    assert.deepEqual(await readdir(f.staging), files);
  } finally { await f.close(); }
});
test("private file reads reject aliases instead of reading another secret or adopting hardlinks", async () => {
  const f = await fixture();
  try {
    const original = join(f.staging, "original"); await writeFile(original, "fixture", { mode: 0o600 });
    const alias = join(f.staging, "alias"); await symlink(original, alias); await assert.rejects(privateFile(alias, 32));
    await link(original, join(f.staging, "hardlink")); await assert.rejects(privateFile(original, 32));
  } finally { await f.close(); }
});
test("the managed key reader refuses an unrelated fd before attempting to read it", async () => {
  await assert.rejects(withRecoveryKeyFd(4, async () => { throw new Error("must not run"); }, []), /backup_dedicated_key_fd_required/);
});
