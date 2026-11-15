import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSnapshot, sha256, type CohortIdentity } from "../deploy/linux/cohort-manifest.ts";
import { inspectSnapshotProfile, sealSnapshot } from "../deploy/linux/cohort-archive.ts";
import { profileDigest } from "../deploy/linux/profile-canonical.ts";
import { BackupProfileAuthorityJoinMissing, refuseUnboundRestoreInspection } from "../deploy/linux/backup-profile-authority.ts";

// Prepared real codec/filesystem cases. Public fixture key, no chain/provider,
// genuine-profile or authority/readiness acceptance. All cases remain UNRUN.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pirate-profile-inspection-"));
  const configuration = join(root, "configuration"), staging = join(root, "inspection");
  await mkdir(configuration, { mode: 0o700 }); await mkdir(staging, { mode: 0o700 });
  const originalProfile = { version: 1, fixture: "original archived JSON, not a production Linux profile", opaqueInstallation: "installation-original" };
  const body = Buffer.from(JSON.stringify(originalProfile) + "\n");
  await writeFile(join(configuration, "profile.json"), body, { mode: 0o600 });
  const identity: CohortIdentity = { deploymentId: "deployment-original", releaseSha256: "1".repeat(64), backendSha256: "2".repeat(64),
    profileSha256: profileDigest(originalProfile), origin: "https://fixture.invalid", communityId: "0x" + "3".repeat(64), writerFenceSha256: "4".repeat(64) };
  const key = Buffer.alloc(32, 0x5a); // Public local archive test fixture only.
  const snapshot = await captureSnapshot(identity, { configuration });
  const sealed = await sealSnapshot({ snapshot, key, output: join(root, "backup.pc1") });
  return { root, staging, originalProfile, identity, key, sealed,
    originalProfileRecord: { path: "configuration/profile.json", fileSha256: sha256(body), canonicalProfileSha256: identity.profileSha256 } };
}
test("authenticated inspection returns full original JSON without promoting producer authority", async () => {
  const f = await fixture();
  try {
    const value = await inspectSnapshotProfile({ archive: f.sealed.output, archiveSha256: f.sealed.archiveSha256, key: f.key,
      stagingDirectory: f.staging, expectedIdentity: f.identity, expectedRoles: ["configuration"], originalProfileRecord: f.originalProfileRecord });
    assert.deepEqual(value.originalProfile, f.originalProfile);
    assert.equal(value.trust, "authenticated-archive-bytes-only"); assert.equal(value.producerAuthorityVerified, false);
    assert.equal(value.canonicalProfileSha256, f.identity.profileSha256); assert.deepEqual(await readdir(f.staging), []);
  } finally { f.key.fill(0); await rm(f.root, { recursive: true, force: true }); }
});
test("wrong key, missing profile, wrong bytes or canonical preimage cannot produce a profile", async () => {
  const f = await fixture();
  try {
    const base = { archive: f.sealed.output, archiveSha256: f.sealed.archiveSha256, key: f.key,
      stagingDirectory: f.staging, expectedIdentity: f.identity, expectedRoles: ["configuration"], originalProfileRecord: f.originalProfileRecord };
    await assert.rejects(inspectSnapshotProfile({ ...base, key: Buffer.alloc(32, 0x01) }));
    for (const patch of [{ path: "configuration/missing.json" }, { fileSha256: "0".repeat(64) }, { canonicalProfileSha256: "0".repeat(64) }]) {
      await assert.rejects(inspectSnapshotProfile({ ...base, originalProfileRecord: { ...f.originalProfileRecord, ...patch } }));
      assert.deepEqual(await readdir(f.staging), []);
    }
  } finally { f.key.fill(0); await rm(f.root, { recursive: true, force: true }); }
});
test("a bare hash or authenticated candidate cannot substitute for the missing original/current authority join", () => {
  assert.throws(() => refuseUnboundRestoreInspection(), (error: unknown) => error instanceof BackupProfileAuthorityJoinMissing &&
    error.code === "backup_original_profile_authority_join_missing" && error.joins.some((join) => join.includes("RestoreInspection.profile")));
});
