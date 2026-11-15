// Byte-format tests only. These do not fake or qualify any stopped services,
// native database, Docker lifecycle, complete profile or second-machine restore.
import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureSnapshot, sha256, validateManifest, type CohortIdentity, type Snapshot } from "../deploy/linux/cohort-manifest.ts";
import { restoreSnapshot, sealSnapshot } from "../deploy/linux/cohort-archive.ts";

const identity: CohortIdentity = {
  deploymentId: "fixture-community", releaseSha256: "1".repeat(64), backendSha256: "2".repeat(64),
  profileSha256: "3".repeat(64), origin: "https://community.test", communityId: "0x" + "4".repeat(64),
  writerFenceSha256: "5".repeat(64), // An unverified fixture reference, never backend evidence.
};
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pirate-cold-cohort-")));
  const source = join(directory, "source"), stagingDirectory = join(directory, "staging");
  await mkdir(source, { mode: 0o700 }); await mkdir(stagingDirectory, { mode: 0o700 });
  await mkdir(join(source, "d1"), { mode: 0o700 }); await mkdir(join(source, "empty"), { mode: 0o700 });
  await writeFile(join(source, "d1/state.bin"), Buffer.from([0, 1, 2, 0xff, 0, 0x7f]), { mode: 0o600 });
  await writeFile(join(source, "private.txt"), "PRIVATE_FIXTURE_BYTES_FOR_CODEC_ONLY", { mode: 0o600 });
  const roots = { "application-state": source };
  const snapshot = await captureSnapshot(identity, roots);
  const key = Buffer.alloc(32, 7); // Public test-only key, unrelated to any account.
  const output = join(directory, "archive.bin"), target = join(directory, "restored");
  return { directory, source, snapshot, key, output, target, stagingDirectory,
    async seal() { return sealSnapshot({ snapshot, key, output }); },
    async restore(archiveSha256: string, changes: Partial<Parameters<typeof restoreSnapshot>[0]> = {}) {
      return restoreSnapshot({ archive: output, archiveSha256, key, expectedIdentity: identity,
        expectedRoles: snapshot.manifest.roles, target, stagingDirectory, ...changes });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function using(body: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await body(f); } finally { f.key.fill(0); await rm(f.directory, { recursive: true, force: true }); }
}

test("cold codec restores exact binary bytes and empty directories, with state fenced", async () => using(async (f) => {
  const keyBefore = Buffer.from(f.key), sealed = await f.seal();
  const ciphertext = await readFile(f.output);
  assert(!ciphertext.includes(Buffer.from("PRIVATE_FIXTURE_BYTES_FOR_CODEC_ONLY")));
  const restored = await f.restore(sealed.archiveSha256);
  assert.equal(restored.state, "restored-fenced");
  assert.deepEqual(await readFile(join(f.target, "application-state/d1/state.bin")), await readFile(join(f.source, "d1/state.bin")));
  assert.equal(await readFile(join(f.target, "application-state/private.txt"), "utf8"), "PRIVATE_FIXTURE_BYTES_FOR_CODEC_ONLY");
  assert.deepEqual(await readdir(join(f.target, "application-state/empty")), []);
  assert.equal((await stat(join(f.target, "application-state/private.txt"))).mode & 0o777, 0o600);
  assert.equal((await stat(f.target)).mode & 0o777, 0o700);
  const fence = JSON.parse(await readFile(join(f.target, "application-state/restore-fence.json"), "utf8"));
  assert.equal(fence.archiveSha256, sealed.archiveSha256);
  assert.deepEqual(f.key, keyBefore);
  assert.deepEqual(await readdir(f.stagingDirectory), []);
}));

test("publishing and restore refuse existing destinations without overwriting", async () => using(async (f) => {
  const sealed = await f.seal(), original = await readFile(f.output);
  await assert.rejects(f.seal(), { code: "EEXIST" });
  assert.deepEqual(await readFile(f.output), original);
  await mkdir(f.target, { mode: 0o700 }); await writeFile(join(f.target, "sentinel"), "keep", { mode: 0o600 });
  await assert.rejects(f.restore(sealed.archiveSha256), { code: "EEXIST" });
  assert.equal(await readFile(join(f.target, "sentinel"), "utf8"), "keep");
}));

test("wrong keys corrupt ciphertext and truncation fail before target creation", async () => using(async (f) => {
  const sealed = await f.seal(), original = await readFile(f.output);
  await assert.rejects(f.restore(sealed.archiveSha256, { key: Buffer.alloc(32, 8) }));
  await assert.rejects(access(f.target), { code: "ENOENT" });
  for (const body of [Buffer.from(original), original.subarray(0, original.length - 9)]) {
    if (body.length === original.length) body[64] = body[64]! ^ 1;
    await writeFile(f.output, body);
    await assert.rejects(f.restore(sha256(body)));
    await assert.rejects(access(f.target), { code: "ENOENT" });
    assert.deepEqual(await readdir(f.stagingDirectory), []);
  }
}));

test("wrong archive identity or selected role inventory cannot restore", async () => using(async (f) => {
  const sealed = await f.seal();
  await assert.rejects(f.restore(sealed.archiveSha256, { expectedIdentity: { ...identity, communityId: "0x" + "6".repeat(64) } }), /cohort_identity_mismatch/);
  await assert.rejects(f.restore(sealed.archiveSha256, { expectedRoles: ["other-state"] }), /cohort_roles_mismatch/);
  await assert.rejects(access(f.target), { code: "ENOENT" });
}));

test("changed source invalidates a captured snapshot rather than creating an archive", async () => using(async (f) => {
  await writeFile(join(f.source, "private.txt"), "changed");
  await assert.rejects(f.seal());
  await assert.rejects(access(f.output), { code: "ENOENT" });
}));

test("source symlinks hardlinks and aliased roots are refused", async () => using(async (f) => {
  await assert.rejects(captureSnapshot(identity, { one: f.source, two: f.source }), /cohort_root_alias/);
  await symlink(join(f.source, "private.txt"), join(f.source, "symbolic"));
  await assert.rejects(captureSnapshot(identity, { "application-state": f.source }));
  await rm(join(f.source, "symbolic"));
  await link(join(f.source, "private.txt"), join(f.source, "hard"));
  await assert.rejects(captureSnapshot(identity, { "application-state": f.source }));
  await chmod(f.source, 0o755);
  await assert.rejects(captureSnapshot(identity, { "application-state": f.source }), /cohort_directory_not_private/);
}));

// Deliberately authenticated malicious fixture: tests extraction validation
// even when an attacker can construct an envelope. No service is simulated.
async function malicious(f: Fixture, snapshot: Snapshot, suffix = Buffer.alloc(0)) {
  const outer = Buffer.from("PIRATE-ENCRYPTED-COHORT-1\n"), inner = Buffer.from("PIRATE-COLD-COHORT-1\n");
  const metadata = Buffer.from(JSON.stringify(snapshot.manifest)), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
  const bodies = await Promise.all(f.snapshot.manifest.files.map((row) => readFile(join(f.source, ...row.path.split("/").slice(1)))));
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", f.key, nonce); cipher.setAAD(outer);
  const body = Buffer.concat([outer, nonce, cipher.update(Buffer.concat([inner, length, metadata, ...bodies, suffix])), cipher.final(), cipher.getAuthTag()]);
  await writeFile(f.output, body, { mode: 0o600 }); return sha256(body);
}

test("authenticated traversal payload hash mismatch and trailing data are refused", async () => using(async (f) => {
  for (const path of ["application-state/../escape", "/absolute", "application-state/name\n", "application-state/a\\b"]) {
    const snapshot = structuredClone(f.snapshot); snapshot.manifest.files[0]!.path = path;
    await assert.rejects(f.restore(await malicious(f, snapshot)));
    await assert.rejects(access(f.target), { code: "ENOENT" });
  }
  const wrongHash = structuredClone(f.snapshot); wrongHash.manifest.files[0]!.sha256 = "0".repeat(64);
  await assert.rejects(f.restore(await malicious(f, wrongHash)), /cohort_payload_hash_invalid/);
  await assert.rejects(f.restore(await malicious(f, f.snapshot, Buffer.from("extra"))), /cohort_payload_size_invalid/);
  await assert.rejects(access(f.target), { code: "ENOENT" });
}));

test("manifest validation refuses additional fields and missing parent directories", async () => using(async (f) => {
  assert.throws(() => validateManifest({ ...f.snapshot.manifest, ready: true }), /cohort_fields_invalid/);
  const changed = structuredClone(f.snapshot.manifest); changed.directories = changed.roles;
  assert.throws(() => validateManifest(changed), /cohort_parent_missing/);
  const fenced = structuredClone(f.snapshot.manifest);
  fenced.files.push({ path: "application-state/restore-fence.json", bytes: 0, sha256: sha256(Buffer.alloc(0)) });
  fenced.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.throws(() => validateManifest(fenced), /cohort_unreconciled_restore/);
}));
