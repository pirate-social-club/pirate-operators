import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createJSON, hash, privateDirectory, privateFile, safeId, syncDirectory, type OperationLease } from "./backend-state.ts";

export const MAX_CIPHERTEXT_BYTES = 32 * 1024 ** 3 + 16 * 1024 ** 2 + 4096;
export async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    assert(bytesWritten > 0); offset += bytesWritten;
  }
}
export async function readJSON(path: string) {
  const file = await privateFile(path, 1048576);
  try { return JSON.parse(await file.readFile("utf8")) as unknown; } finally { await file.close(); }
}
export async function verifyCiphertext(path: string, expectedDigest: string, expectedBytes: number) {
  const file = await privateFile(path, MAX_CIPHERTEXT_BYTES), digest = createHash("sha256"); let bytes = 0;
  try {
    const before = await file.stat({ bigint: true });
    for await (const chunk of file.createReadStream({ autoClose: false })) { digest.update(chunk); bytes += chunk.length; }
    const after = await file.stat({ bigint: true });
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "backup_ciphertext_changed");
    assert.equal(bytes, expectedBytes); assert.equal("0x" + digest.digest("hex"), expectedDigest);
  } finally { await file.close(); }
}
/** Real immutable ciphertext staging for the frozen wizard method. */
export async function createBackupStaging(directory: string, lease: OperationLease) {
  await privateDirectory(directory);
  return {
    async stageBackup(input: { requestId: string; byteLength: number; bytes: AsyncIterable<Uint8Array> }) {
      await lease.assertHeld(); assert(safeId(input.requestId) && Number.isSafeInteger(input.byteLength) &&
        input.byteLength > 0 && input.byteLength <= MAX_CIPHERTEXT_BYTES);
      const id = "backup-" + hash(input.requestId), path = join(directory, id + ".ciphertext");
      let prior: { backupId: string; ciphertextDigest: string; byteLength: number } | undefined;
      try { prior = await readJSON(join(directory, id + "-complete.json")) as typeof prior; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (prior) {
        // A lost response does not cause a new identity or overwrite. Consume
        // and verify the entire retry stream, as required by the frozen factory.
        assert(prior.backupId === id && prior.byteLength === input.byteLength);
        const check = createHash("sha256"); let received = 0;
        for await (const chunk of input.bytes) {
          await lease.assertHeld(); assert(chunk instanceof Uint8Array);
          received += chunk.byteLength; assert(received <= input.byteLength); check.update(chunk);
        }
        assert.equal(received, input.byteLength); assert.equal("0x" + check.digest("hex"), prior.ciphertextDigest);
        await verifyCiphertext(path, prior.ciphertextDigest, prior.byteLength);
        return { backupId: id, ciphertextDigest: prior.ciphertextDigest };
      }
      // An existing request remains recoverable after an uncertain response.
      // It is not silently consumed as a new upload, overwritten or discarded.
      let intent;
      try { intent = await createJSON(directory, id + "-intent", { requestId: input.requestId, byteLength: input.byteLength }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("backup_upload_uncertain_reconcile_original_request");
        throw error;
      }
      const partial = path + ".partial";
      const file = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const digest = createHash("sha256"); let size = 0;
      try {
        for await (const chunk of input.bytes) {
          await lease.assertHeld(); assert(chunk instanceof Uint8Array);
          size += chunk.byteLength; assert(size <= input.byteLength); digest.update(chunk); await writeAll(file, chunk);
        }
        assert.equal(size, input.byteLength); await file.sync();
      } finally { await file.close(); }
      // No overwrite. A failed partial upload remains with its durable intent.
      await link(partial, path); await unlink(partial); await syncDirectory(directory);
      const ciphertextDigest = "0x" + digest.digest("hex");
      const receipt = { backupId: id, ciphertextDigest, byteLength: size, intent };
      await createJSON(directory, id + "-complete", receipt); await lease.record("ciphertext-staged", receipt);
      return { backupId: id, ciphertextDigest };
    },
    async reconcileStaged(backupId: string) {
      await lease.assertHeld(); assert(safeId(backupId));
      const value = await readJSON(join(directory, backupId + "-complete.json")) as {
        backupId: string; ciphertextDigest: string; byteLength: number;
      };
      assert.equal(value.backupId, backupId);
      await verifyCiphertext(join(directory, backupId + ".ciphertext"), value.ciphertextDigest, value.byteLength);
      return value;
    },
  };
}

/** Existing managed-key boundary: inherited fd, never argv/env/journal/archive.
 * The supplying owner must close the pipe; the admitted outer bound handles
 * stalled input. Key creation, provider lookup and password guessing are absent. */
export async function withRecoveryKeyFd<T>(fd: number, action: (key: Uint8Array) => Promise<T>, excludedRoots: readonly string[]) {
  assert.equal(fd, 3, "backup_dedicated_key_fd_required");
  const { readSync, fstatSync, readlinkSync, realpathSync } = await import("node:fs");
  const descriptor = fstatSync(fd);
  if (descriptor.isFile()) {
    const path = readlinkSync("/proc/self/fd/" + fd);
    assert(realpathSync(path) === path && descriptor.nlink === 1 && descriptor.uid === process.getuid!() &&
      !(descriptor.mode & 0o077) && descriptor.size === 32, "backup_recovery_key_file_not_private");
    assert(excludedRoots.every((root) => path !== root && !path.startsWith(root + "/")), "backup_recovery_key_inside_cohort");
  } else assert(descriptor.isFIFO() || descriptor.isSocket(), "backup_managed_key_pipe_required");
  const key = Buffer.alloc(33); let size = 0;
  try {
    while (size < key.length) {
      const n = readSync(fd, key, size, key.length - size, null); if (n === 0) break; size += n;
    }
    assert.equal(size, 32, "backup_recovery_key_size");
    return await action(key.subarray(0, 32));
  } finally { key.fill(0); }
}
