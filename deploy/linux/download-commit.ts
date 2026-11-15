import assert from "node:assert/strict";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { privateDirectory, type OperationLease } from "./backend-state.ts";

/** A durable file is not a durable directory entry. The actual destination,
 * which may differ from the operation journal directory, must be synced first. */
export async function commitCiphertextDownload(input: {
  file: FileHandle; destination: string; destinationDirectory: string;
  key: string; bytes: number; archiveSha256: string; lease: OperationLease;
}) {
  assert.equal(dirname(input.destination), input.destinationDirectory);
  await input.lease.assertHeld(); await privateDirectory(input.destinationDirectory);
  const originalParent = await lstat(input.destinationDirectory);
  const parent = await open(input.destinationDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinnedParent = await parent.stat(), pinnedFile = await input.file.stat();
    const same = (a: {dev: number; ino: number}, b: {dev: number; ino: number}) => a.dev === b.dev && a.ino === b.ino;
    assert(same(originalParent, pinnedParent) && pinnedParent.isDirectory() &&
      pinnedParent.uid === process.getuid!() && !(pinnedParent.mode & 0o077), "download_parent_identity_changed");
    assert(pinnedFile.isFile() && pinnedFile.nlink === 1 && pinnedFile.uid === process.getuid!() &&
      !(pinnedFile.mode & 0o077) && pinnedFile.size === input.bytes, "download_file_identity_invalid");
    async function assertRecordedPaths() {
      assert.equal(await realpath(input.destinationDirectory), input.destinationDirectory, "download_parent_not_canonical");
      const currentParent = await lstat(input.destinationDirectory), currentFile = await lstat(input.destination);
      assert(currentParent.isDirectory() && !currentParent.isSymbolicLink() && same(currentParent, pinnedParent) &&
        currentParent.uid === pinnedParent.uid && !(currentParent.mode & 0o077), "download_parent_identity_changed");
      assert(currentFile.isFile() && !currentFile.isSymbolicLink() && currentFile.nlink === 1 &&
        same(currentFile, pinnedFile) && currentFile.uid === pinnedFile.uid && !(currentFile.mode & 0o077) &&
        currentFile.size === input.bytes && same(await input.file.stat(), pinnedFile), "download_destination_identity_changed");
    }
    await assertRecordedPaths();
    await input.file.sync();
    // Sync the ORIGINAL directory handle, never a replacement at its old path.
    await parent.sync();
    await input.lease.assertHeld(); await assertRecordedPaths();
    return await input.lease.record("download-complete-readback", {
      key: input.key, bytes: input.bytes, archiveSha256: input.archiveSha256,
      destination: input.destination, destinationDirectory: input.destinationDirectory,
      fileIdentity: {dev: pinnedFile.dev, ino: pinnedFile.ino}, parentIdentity: {dev: pinnedParent.dev, ino: pinnedParent.ino},
    });
  } finally { await parent.close(); }
}
