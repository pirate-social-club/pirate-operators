import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  captureSnapshot, isDigest, MAX_BYTES, MAX_MANIFEST, privateDirectory, regular,
  sha256, sourcePath, stableBytes, stamp, validateIdentity, validateManifest,
  type CohortIdentity, type CohortManifest, type Snapshot,
} from "./cohort-manifest.ts";
import { profileDigest } from "./profile-canonical.ts";

const OUTER = Buffer.from("PIRATE-ENCRYPTED-COHORT-1\n", "ascii");
const INNER = Buffer.from("PIRATE-COLD-COHORT-1\n", "ascii");
const TAG_BYTES = 16, NONCE_BYTES = 12;
const exclusive = (path: string) => open(path,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function writeAll(file: FileHandle, bytes: Uint8Array) {
  let position = 0;
  while (position < bytes.length) {
    const result = await file.write(bytes, position, bytes.length - position, null);
    assert(result.bytesWritten > 0, "cohort_write_incomplete"); position += result.bytesWritten;
  }
}
async function readExact(file: FileHandle, position: number, bytes: number) {
  const buffer = Buffer.alloc(bytes); let offset = 0;
  while (offset < bytes) {
    const result = await file.read(buffer, offset, bytes - offset, position + offset);
    assert(result.bytesRead > 0, "cohort_truncated"); offset += result.bytesRead;
  }
  return buffer;
}
async function* range(file: FileHandle, position: number, bytes: number) {
  let offset = 0;
  while (offset < bytes) {
    const part = await readExact(file, position + offset, Math.min(64 * 1024, bytes - offset));
    offset += part.length; yield part;
  }
}
async function freshPath(path: string) {
  const name = basename(path);
  assert(name.length > 0 && name.length <= 128 && /^[A-Za-z0-9]/.test(name) &&
    !/[^A-Za-z0-9._-]/.test(name), "cohort_output_name_invalid");
  assert.equal(join(dirname(path), name), path, "cohort_output_not_canonical");
  await privateDirectory(dirname(path));
}
function keyCopy(key: Uint8Array) { assert.equal(key.byteLength, 32, "cohort_key_size"); return Buffer.from(key); }
function manifestBytes(manifest: CohortManifest) {
  validateManifest(manifest); const bytes = Buffer.from(JSON.stringify(manifest));
  assert(bytes.length <= MAX_MANIFEST, "cohort_manifest_limit"); return bytes;
}

/** Byte-layer codec only. Actual stopped-writer fencing is a caller precondition.
 * It cannot authenticate the supplied writerFenceSha256 or admit a full profile.
 * Failed partial ciphertext is retained; no existing archive is overwritten. */
export async function sealSnapshot(input: { snapshot: Snapshot; key: Uint8Array; output: string }) {
  const snapshot = structuredClone(input.snapshot);
  const metadata = manifestBytes(snapshot.manifest); await freshPath(input.output);
  const before = await captureSnapshot(snapshot.manifest.identity, snapshot.roots);
  assert.deepEqual(before.manifest, snapshot.manifest, "cohort_inventory_changed");
  assert.deepEqual(before.witnesses, snapshot.witnesses, "cohort_file_changed");
  const key = keyCopy(input.key), nonce = randomBytes(NONCE_BYTES);
  const temporary = input.output + ".partial-" + randomBytes(12).toString("hex");
  let file: FileHandle | undefined;
  const encryptedHash = createHash("sha256"); let encryptedBytes = 0;
  async function save(bytes: Uint8Array) { assert(file); await writeAll(file, bytes); encryptedHash.update(bytes); encryptedBytes += bytes.length; }
  try {
    file = await exclusive(temporary);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES }); cipher.setAAD(OUTER);
    await save(Buffer.concat([OUTER, nonce]));
    const size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
    for (const bytes of [INNER, size, metadata]) await save(cipher.update(bytes));
    for (const row of snapshot.manifest.files) {
      const hash = createHash("sha256"); let bytes = 0;
      for await (const part of stableBytes(sourcePath(snapshot, row.path), snapshot.witnesses[row.path])) {
        hash.update(part); bytes += part.length; assert(bytes <= row.bytes, "cohort_file_changed");
        await save(cipher.update(part));
      }
      assert.equal(bytes, row.bytes, "cohort_file_changed");
      assert.equal(hash.digest("hex"), row.sha256, "cohort_file_changed");
    }
    const after = await captureSnapshot(snapshot.manifest.identity, snapshot.roots);
    assert.deepEqual(after.manifest, snapshot.manifest, "cohort_inventory_changed");
    assert.deepEqual(after.witnesses, snapshot.witnesses, "cohort_file_changed");
    await save(cipher.final()); await save(cipher.getAuthTag()); await file.sync();
  } finally { key.fill(0); if (file) await file.close(); }
  // link is atomic and refuses an already existing destination, unlike rename.
  await link(temporary, input.output); await unlink(temporary); await syncDirectory(dirname(input.output));
  return { kind: "encrypted-state-artifact" as const, output: input.output,
    archiveSha256: encryptedHash.digest("hex"), encryptedBytes,
    manifestSha256: sha256(metadata), files: snapshot.manifest.files.length,
    totalBytes: snapshot.manifest.totalBytes };
}

async function decrypt(input: { archive: string; archiveSha256: string; key: Uint8Array; target: FileHandle }) {
  assert(isDigest(input.archiveSha256), "cohort_archive_digest_invalid");
  const key = keyCopy(input.key); let source: FileHandle | undefined;
  const target = input.target;
  try {
    source = await regular(input.archive);
    const before = await stamp(source), size = Number((await source.stat()).size);
    const headerSize = OUTER.length + NONCE_BYTES;
    assert(Number.isSafeInteger(size) && size >= headerSize + TAG_BYTES &&
      size <= MAX_BYTES + MAX_MANIFEST + 4096, "cohort_encrypted_size_invalid");
    const header = await readExact(source, 0, headerSize);
    assert.deepEqual(header.subarray(0, OUTER.length), OUTER, "cohort_format_invalid");
    const tag = await readExact(source, size - TAG_BYTES, TAG_BYTES);
    const cipher = createDecipheriv("aes-256-gcm", key, header.subarray(OUTER.length), { authTagLength: TAG_BYTES });
    cipher.setAAD(OUTER); cipher.setAuthTag(tag);
    const hash = createHash("sha256").update(header);
    for await (const part of range(source, headerSize, size - headerSize - TAG_BYTES)) {
      hash.update(part); await writeAll(target, cipher.update(part));
    }
    hash.update(tag);
    assert.equal(hash.digest("hex"), input.archiveSha256, "cohort_archive_changed");
    await writeAll(target, cipher.final()); // Authentication completes before extraction.
    assert.equal(await stamp(source), before, "cohort_archive_changed");
    await target.sync(); await target.chmod(0o400); await target.sync();
  } finally {
    key.fill(0);
    if (source) await source.close();
  }
}

async function readManifest(file: FileHandle) {
  const prefix = await readExact(file, 0, INNER.length + 4);
  assert.deepEqual(prefix.subarray(0, INNER.length), INNER, "cohort_plaintext_format_invalid");
  const size = prefix.readUInt32BE(INNER.length); assert(size > 0 && size <= MAX_MANIFEST, "cohort_manifest_limit");
  const metadata = await readExact(file, prefix.length, size);
  const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  validateManifest(manifest);
  assert.equal((await file.stat()).size, prefix.length + size + manifest.totalBytes, "cohort_payload_size_invalid");
  let offset = prefix.length + size;
  // Verify every file before creating the destination or extracting any state.
  for (const row of manifest.files) {
    const hash = createHash("sha256");
    for await (const part of range(file, offset, row.bytes)) hash.update(part);
    assert.equal(hash.digest("hex"), row.sha256, "cohort_payload_hash_invalid"); offset += row.bytes;
  }
  return { manifest, metadata, payloadOffset: prefix.length + size };
}

/** Restores bytes into a new private target, without starting any service.
 * Release/backend/role checks are exact. External revocations, credentials,
 * authority and complete-profile admission still require real reconciliation. */
interface RestoreSnapshotInput {
  archive: string; archiveSha256: string; key: Uint8Array;
  expectedIdentity: CohortIdentity; expectedRoles: readonly string[];
  stagingDirectory: string; target: string;
}
export async function restoreSnapshot(input:RestoreSnapshotInput){return restoreBytes(input);}
export async function restoreCurrentAuthorizedSnapshot(input:RestoreSnapshotInput & {
  signal:AbortSignal;assertCurrent:()=>Promise<void>;
}){
  assert(typeof input.assertCurrent==="function","actual_current_effect_authority_required");
  const assertCurrent=async()=>{assert(!input.signal.aborted,"native_effect_cancelled");
    await input.assertCurrent();assert(!input.signal.aborted,"native_effect_cancelled");};
  return restoreBytes(input,assertCurrent);
}
async function restoreBytes(input:RestoreSnapshotInput,assertCurrent?:()=>Promise<void>) {
  validateIdentity(input.expectedIdentity);
  await privateDirectory(input.stagingDirectory); await freshPath(input.target);
  const plaintext = join(input.stagingDirectory, "cohort-" + randomBytes(12).toString("hex") + ".private");
  let file: FileHandle | undefined;
  let plaintextIdentity: { dev: number; ino: number } | undefined;
  try {
    if(assertCurrent)await assertCurrent();const target = await exclusive(plaintext);
    try {
      const allocated = await target.stat(); plaintextIdentity = { dev: allocated.dev, ino: allocated.ino };
      await decrypt({ ...input, target });
    } finally { await target.close(); }
    file = await regular(plaintext);
    const { manifest, metadata, payloadOffset } = await readManifest(file);
    assert.deepEqual(manifest.identity, input.expectedIdentity, "cohort_identity_mismatch");
    assert.deepEqual(manifest.roles, input.expectedRoles, "cohort_roles_mismatch");
    // No recursive mkdir: an existing destination is never adopted or merged.
    if(assertCurrent)await assertCurrent();await mkdir(input.target, { mode: 0o700 });
    const directories = [...manifest.directories].sort((a, b) =>
      a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
    for (const directory of directories) {if(assertCurrent)await assertCurrent();await mkdir(join(input.target, directory), { mode: 0o700 });}
    const fence = Buffer.from(JSON.stringify({ schema: "pirate.restore-fence/1",
      archiveSha256: input.archiveSha256, manifestSha256: sha256(metadata), identity: manifest.identity }) + "\n");
    // Persist each role's fence before restoring any runnable backend state.
    for (const role of manifest.roles) {
      if(assertCurrent)await assertCurrent();const marker = await exclusive(join(input.target, role, "restore-fence.json"));
      try { if(assertCurrent)await assertCurrent();await writeAll(marker, fence); await marker.sync(); } finally { await marker.close(); }
      await syncDirectory(join(input.target, role));
    }
    await syncDirectory(input.target); await syncDirectory(dirname(input.target));
    let offset = payloadOffset;
    for (const row of manifest.files) {
      if(assertCurrent)await assertCurrent();const output = await exclusive(join(input.target, row.path)), hash = createHash("sha256");
      try {
        for await (const part of range(file, offset, row.bytes)) { hash.update(part);if(assertCurrent)await assertCurrent();await writeAll(output, part); }
        assert.equal(hash.digest("hex"), row.sha256, "cohort_payload_changed"); await output.sync();
      } finally { await output.close(); }
      offset += row.bytes;
    }
    const receipt = { schema: "pirate.restored-cohort/1", state: "restored-fenced",
      archiveSha256: input.archiveSha256, manifestSha256: sha256(metadata), identity: manifest.identity,
      roles: manifest.roles, files: manifest.files.length, totalBytes: manifest.totalBytes };
    if(assertCurrent)await assertCurrent();const marker = await exclusive(join(input.target, "restored-cohort.json"));
    try { if(assertCurrent)await assertCurrent();await writeAll(marker, Buffer.from(JSON.stringify(receipt) + "\n")); await marker.sync(); }
    finally { await marker.close(); }
    for (const directory of directories.reverse()) await syncDirectory(join(input.target, directory));
    await syncDirectory(input.target); await syncDirectory(dirname(input.target));
    if(assertCurrent)await assertCurrent();return receipt;
  } finally {
    try { if (file) await file.close(); }
    finally {
      // Only this call's random temporary plaintext is removed. The ciphertext,
      // original state and any failed fresh restore target remain untouched.
      try {
        if (plaintextIdentity) {
          const actual = await lstat(plaintext);
          assert(actual.dev === plaintextIdentity.dev && actual.ino === plaintextIdentity.ino &&
            actual.isFile() && !actual.isSymbolicLink() && actual.nlink === 1, "cohort_plaintext_custody_changed");
          await unlink(plaintext);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

export interface OriginalProfileRecordBinding {
  path: string;
  fileSha256: string;
  canonicalProfileSha256: string;
}

/** Discover the full signed profile from authenticated archive bytes alone;
 * current installation/namespace authority is verified by the caller. */
export async function inspectAuthenticatedFullProfile(input: {
  archive:string;archiveSha256:string;key:Uint8Array;stagingDirectory:string;
}) {
  await privateDirectory(input.stagingDirectory);
  const path=join(input.stagingDirectory,"inspect-original-"+randomBytes(12).toString("hex")+".private");
  let file:FileHandle|undefined,owned:{dev:number;ino:number}|undefined;
  try {
    const target=await exclusive(path);
    try {const s=await target.stat();owned={dev:s.dev,ino:s.ino};await decrypt({...input,target});}
    finally {await target.close();}
    file=await regular(path);const {manifest,metadata,payloadOffset}=await readManifest(file);
    async function record(name:string) {
      const i=manifest.files.findIndex(r=>r.path===name);assert(i>=0,"authenticated_original_profile_record_missing");
      const row=manifest.files[i]!;assert(row.bytes<=1048576);
      const offset=payloadOffset+manifest.files.slice(0,i).reduce((n,r)=>n+r.bytes,0);
      const bytes=await readExact(file!,offset,row.bytes);assert.equal(sha256(bytes),row.sha256);
      return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    }
    const profile=await record("configuration/linux-profile.json"),authority=await record("configuration/profile-authority.json");
    assert.equal(profileDigest(profile),manifest.identity.profileSha256,"archive_original_profile_binding_changed");
    assert(profile?.schema==="pirate.community-linux-profile/2","archive_legacy_profile_requires_explicit_inventory_export");
    const mapping=profile.infrastructure?.mapping,evidence=mapping?.evidence;
    assert(evidence && typeof evidence.relativePath==="string" && !evidence.relativePath.startsWith("/") &&
      evidence.relativePath.split("/").every((part:string)=>part && part!=="." && part!==".." && /^[A-Za-z0-9_.-]+$/.test(part)),
      "archive_original_directory_evidence_path_invalid");
    const originalLedger=manifest.files.find(row=>row.path==="configuration/"+evidence.relativePath);
    assert(originalLedger && originalLedger.sha256===evidence.sha256,"archive_original_directory_evidence_missing_or_changed");
    return {profile,authority,manifest,manifestBytes:metadata,manifestSha256:sha256(metadata),producerAuthorityVerified:false as const};
  } finally {
    await file?.close();
    if(owned){const s=await lstat(path);assert(s.isFile() && s.nlink===1 && s.dev===owned.dev && s.ino===owned.ino);await unlink(path);await syncDirectory(input.stagingDirectory);}
  }
}

/** Authenticate EVERY archive/payload byte before extracting the original full
 * profile JSON. This is an internal candidate, not RestoreInspection.profile:
 * archived bytes do not establish the producer's authority or current policy. */
export async function inspectSnapshotProfile(input: {
  archive: string; archiveSha256: string; key: Uint8Array; stagingDirectory: string;
  expectedIdentity: CohortIdentity; expectedRoles: readonly string[];
  originalProfileRecord: OriginalProfileRecordBinding;
}) {
  validateIdentity(input.expectedIdentity); await privateDirectory(input.stagingDirectory);
  const binding = input.originalProfileRecord;
  assert(binding && isDigest(binding.fileSha256) && isDigest(binding.canonicalProfileSha256),
    "backup_original_profile_record_binding_missing");
  const plaintext = join(input.stagingDirectory, "inspect-profile-" + randomBytes(12).toString("hex") + ".private");
  let file: FileHandle | undefined; let owned: { dev: number; ino: number } | undefined;
  try {
    const target = await exclusive(plaintext);
    try {
      const identity = await target.stat(); owned = { dev: identity.dev, ino: identity.ino };
      await decrypt({ archive: input.archive, archiveSha256: input.archiveSha256, key: input.key, target });
    } finally { await target.close(); }
    file = await regular(plaintext);
    const { manifest, metadata, payloadOffset } = await readManifest(file);
    assert.deepEqual(manifest.identity, input.expectedIdentity, "cohort_identity_mismatch");
    assert.deepEqual(manifest.roles, input.expectedRoles, "cohort_roles_mismatch");
    const index = manifest.files.findIndex((item) => item.path === binding.path);
    assert(index >= 0, "backup_original_profile_record_absent");
    const row = manifest.files[index]!;
    assert(row.bytes <= 1048576 && row.sha256 === binding.fileSha256, "backup_original_profile_record_hash_mismatch");
    const offset = payloadOffset + manifest.files.slice(0, index).reduce((sum, item) => sum + item.bytes, 0);
    const bytes = await readExact(file, offset, row.bytes);
    assert.equal(sha256(bytes), binding.fileSha256);
    const originalProfile: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert(originalProfile !== null && typeof originalProfile === "object" && !Array.isArray(originalProfile),
      "backup_original_full_profile_required");
    const canonical = profileDigest(originalProfile);
    assert.equal(canonical, binding.canonicalProfileSha256, "backup_original_profile_preimage_mismatch");
    assert.equal(canonical, manifest.identity.profileSha256, "backup_original_profile_archive_binding_mismatch");
    return { originalProfile, recordPath: row.path, profileFileSha256: row.sha256, canonicalProfileSha256: canonical,
      manifestSha256: sha256(metadata), archiveSha256: input.archiveSha256, identity: manifest.identity,
      trust: "authenticated-archive-bytes-only" as const, producerAuthorityVerified: false as const };
  } finally {
    try { if (file) await file.close(); }
    finally {
      if (owned) {
        const current = await lstat(plaintext);
        assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 &&
          current.dev === owned.dev && current.ino === owned.ino, "backup_profile_plaintext_custody_changed");
        await unlink(plaintext); await syncDirectory(input.stagingDirectory);
      }
    }
  }
}
