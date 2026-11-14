import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { Effect, Stream } from "effect";
import { Files } from "files-sdk/effect";
import { createObjectStorage } from "../../packages/storage/files.ts";
import { writeAll, verifyCiphertext, MAX_CIPHERTEXT_BYTES } from "./backup-staging.ts";
import { createJSON, hash, privateFile, privateDirectory, rawDigest, type OperationLease } from "./backend-state.ts";
import type { ColdBackupReceipt } from "./cold-backup-operation.ts";
import type { ReadStream } from "node:fs";
import { commitCiphertextDownload } from "./download-commit.ts";

/** Actual Files SDK transport, separate from encryption and key custody.
 * The profile is supplied from the existing verified operator configuration;
 * Filebase is the wizard default, B2/custom S3 use the same existing factory.
 * No bucket creation, guessed endpoint, public URL or pinning token fallback. */
export async function exportEncryptedBackup(input: {
  lease: OperationLease; receipt: ColdBackupReceipt; profile: unknown; credentials: unknown; signal: AbortSignal;
  ticketDirectory: string;
  authorizeProviderWrite(): Promise<void>;
}) {
  await input.lease.assertHeld(); await input.authorizeProviderWrite(); assert(!input.signal.aborted);
  const receipt = input.receipt;
  assert(rawDigest(receipt.archiveSha256));
  await verifyCiphertext(receipt.output, "0x" + receipt.archiveSha256, receipt.encryptedBytes);
  const storage = createObjectStorage(input.profile, input.credentials);
  const key = "backups/" + input.lease.operationId + "-" + receipt.archiveSha256 + ".pc1";
  let source: Awaited<ReturnType<typeof privateFile>> | undefined;
  let bodyStream: ReadStream | undefined;
  try {
    assert.equal(storage.profile.role, "backup", "backup_role_required");
    await input.lease.record("export-intent", { key, archiveSha256: receipt.archiveSha256, bytes: receipt.encryptedBytes, profile: storage.profile });
    source = await privateFile(receipt.output, MAX_CIPHERTEXT_BYTES);
    const magic = Buffer.from("PIRATE-ENCRYPTED-COHORT-1\n", "ascii"), prefix = Buffer.alloc(magic.length);
    const read = await source.read(prefix, 0, prefix.length, 0);
    assert.equal(read.bytesRead, magic.length); assert.deepEqual(prefix, magic, "backup_encrypted_archive_required");
    bodyStream = source.createReadStream({ autoClose: false, start: 0 });
    const uploadStream = Readable.toWeb(bodyStream) as ReadableStream<Uint8Array>;
    const actual = await Effect.runPromise(Effect.gen(function* () {
      const files = yield* Files;
      const uploaded = yield* files.upload(key, uploadStream, { contentType: "application/octet-stream",
        multipart: { partSize: 5 * 1024 * 1024, concurrency: 1 } });
      const head = yield* files.head(key), downloaded = yield* files.download(key);
      const digest = createHash("sha256"); let size = 0;
      yield* Stream.runForEach(downloaded.stream, (chunk) => Effect.sync(() => {
        assert(chunk instanceof Uint8Array); size += chunk.byteLength; assert(size <= receipt.encryptedBytes); digest.update(chunk);
      }));
      assert.equal(uploaded.size, receipt.encryptedBytes); assert.equal(head.size, receipt.encryptedBytes);
      assert.equal(size, receipt.encryptedBytes); assert.equal(digest.digest("hex"), receipt.archiveSha256);
      return { key, bytes: size, archiveSha256: receipt.archiveSha256 };
    }).pipe(Effect.provide(storage.layer)), { signal: input.signal });
    await input.lease.assertHeld(); await input.lease.record("export-full-download-readback", actual);
    const { output, ...backup } = receipt;
    const ticket = await createJSON(input.ticketDirectory, "recovery-ticket-" + hash(input.lease.operationId).slice(0, 32), {
      schema: "pirate.cold-recovery-ticket/1", profile: storage.profile, objectKey: key, backup,
    });
    // Ticket + authenticated ciphertext bytes + separately held key recover
    // without the original local directory or provider metadata. No credential
    // or recovery key is embedded in the ticket.
    return { ...actual, ticket, archiveReadback: "MATCH" as const, bucketPrivacy: "UNPROVED" as const };
  } finally {
    storage.close(); bodyStream?.destroy(); if (source) await source.close();
    // Failure retains the export intent; reconciliation downloads this original
    // key. This owner never issues an automatic second upload or delete.
  }
}

/** Recover a complete local ciphertext from real SDK download bytes. */
export async function importEncryptedBackup(input: {
  lease: OperationLease; key: string; archiveSha256: string; encryptedBytes: number;
  destination: string; destinationDirectory: string; profile: unknown; credentials: unknown; signal: AbortSignal;
  authorizeProviderRead(): Promise<void>;
}) {
  await input.lease.assertHeld(); await input.authorizeProviderRead(); assert(rawDigest(input.archiveSha256));
  assert(input.encryptedBytes > 0 && input.encryptedBytes <= MAX_CIPHERTEXT_BYTES);
  await privateDirectory(input.destinationDirectory);
  const path = await import("node:path");
  assert.equal(path.dirname(input.destination), input.destinationDirectory);
  const storage = createObjectStorage(input.profile, input.credentials), digest = createHash("sha256"); let size = 0;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assert.equal(storage.profile.role, "backup");
    output = await open(input.destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await Effect.runPromise(Effect.gen(function* () {
      const files = yield* Files, downloaded = yield* files.download(input.key);
      yield* Stream.runForEach(downloaded.stream, (chunk) => Effect.tryPromise(async () => {
        assert(chunk instanceof Uint8Array); size += chunk.byteLength; assert(size <= input.encryptedBytes);
        assert(output); digest.update(chunk); await writeAll(output, chunk);
      }));
    }).pipe(Effect.provide(storage.layer)), { signal: input.signal });
    assert.equal(size, input.encryptedBytes); assert.equal(digest.digest("hex"), input.archiveSha256);
    await commitCiphertextDownload({ file: output, destination: input.destination, destinationDirectory: input.destinationDirectory,
      key: input.key, bytes: size, archiveSha256: input.archiveSha256, lease: input.lease });
    return { localCiphertext: input.destination, bytes: size, archiveSha256: input.archiveSha256 };
  } finally { try { if (output) await output.close(); } finally { storage.close(); } }
}
