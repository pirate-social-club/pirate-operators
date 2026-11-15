import assert from "node:assert/strict";
import test from "node:test";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireOperation, processIdentity, sameProcess, type ProcessIdentity } from "../deploy/linux/backend-state.ts";
import { containerProcessEvidence, requireLifetimeAbsent, requireObserverHostFrame, sameLifetime } from "../deploy/linux/writer-evidence.ts";
import { commitCiphertextDownload } from "../deploy/linux/download-commit.ts";

// Prepared contract negatives, not Docker/host/durability acceptance. ALL UNRUN.
const host: ProcessIdentity = { hostPid: 100, hostStartTicks: "200", hostGroup: 100, hostSession: 100,
  uid: 1000, pidNamespace: "pid:[1836]", networkNamespace: "net:[1833]" };

test("live same-lifetime writers with changed identity remain uncertainty", () => {
  for (const changed of [{ hostGroup: 101 }, { hostSession: 101 }, { uid: 1001 },
    { networkNamespace: "net:[9999]" }, { pidNamespace: "pid:[9998]" }]) {
    const observed = { ...host, ...changed };
    assert(sameLifetime(host, observed)); assert(!sameProcess(host, observed));
    assert.throws(() => requireLifetimeAbsent(host, observed), /identity_changed_uncertain/);
  }
  assert.throws(() => requireLifetimeAbsent(host, host), /lifetime_still_present/);
});
test("only observed absence or PID reuse proves the original lifetime gone", () => {
  assert.equal(requireLifetimeAbsent(host, null).disposition, "absent-at-observation");
  assert.equal(requireLifetimeAbsent(host, { ...host, hostStartTicks: "201" }).disposition, "original-lifetime-gone-pid-reused");
  assert.throws(() => requireLifetimeAbsent(host, { ...host, hostPid: 101 }), /wrong_pid_observation/);
  assert.throws(() => requireLifetimeAbsent(host, { ...host, hostStartTicks: "" }), /invalid_uncertain/);
});
test("host observer and normal private container namespace are validated separately", () => {
  assert.deepEqual(requireObserverHostFrame(host, host), host);
  assert.throws(() => requireObserverHostFrame(host, { ...host, pidNamespace: "pid:[9998]" }), /observer_host_frame_changed/);
  const container = { ...host, hostPid: 501, hostStartTicks: "700", hostGroup: 501, hostSession: 501,
    pidNamespace: "pid:[9001]", networkNamespace: "net:[9002]" };
  const evidence = containerProcessEvidence(host, "container-original", 501, container);
  assert.equal(evidence.observerHostFrame.pidNamespace, host.pidNamespace);
  assert.equal(evidence.containerProcess.pidNamespace, "pid:[9001]");
  assert.notEqual(evidence.containerProcess.pidNamespace, evidence.observerHostFrame.pidNamespace);
  assert.throws(() => containerProcessEvidence(host, "container-original", 502, container), /container_pid_unobservable/);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pirate-download-commit-")), operation = join(root, "operation"), destination = join(root, "destination");
  await mkdir(operation, { mode: 0o700 }); await mkdir(destination, { mode: 0o700 });
  const actual = await processIdentity(process.pid); assert(actual);
  const lease = await acquireOperation(operation, "original-operation", "1".repeat(64), { scope: "unit-filesystem" }, actual.pidNamespace);
  const path = join(destination, "download.pc1"), file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await file.writeFile("synthetic ciphertext bytes");
  return { root, operation, destination, path, file, lease };
}
async function completionRecords(directory: string) {
  const rows = [];
  for (const name of await readdir(directory)) if (name.endsWith(".json")) rows.push(JSON.parse(await readFile(join(directory, name), "utf8")));
  return rows.filter((row) => row.phase === "download-complete-readback");
}
test("distinct destination directory commits before completion is recorded", async () => {
  const f = await fixture();
  try {
    assert.notEqual(f.operation, f.destination);
    await commitCiphertextDownload({ file: f.file, destination: f.path, destinationDirectory: f.destination,
      key: "original-key", bytes: 26, archiveSha256: "a".repeat(64), lease: f.lease });
    const rows = await completionRecords(f.operation); assert.equal(rows.length, 1);
    assert.equal(rows[0].facts.destinationDirectory, f.destination);
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("a real destination directory loss after file sync cannot persist completion", async () => {
  const f = await fixture();
  try {
    const original = f.file.sync.bind(f.file);
    // Deterministic filesystem race: the real file is synced, then its actual
    // parent is moved. A completion-only journal sync would wrongly succeed.
    Object.defineProperty(f.file, "sync", { value: async () => { await original(); await rename(f.destination, join(f.root, "moved")); } });
    await assert.rejects(commitCiphertextDownload({ file: f.file, destination: f.path, destinationDirectory: f.destination,
      key: "original-key", bytes: 26, archiveSha256: "a".repeat(64), lease: f.lease }), { code: "ENOENT" });
    assert.equal((await completionRecords(f.operation)).length, 0);
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
test("renaming and replacing the original destination parent never records completion", async () => {
  const f = await fixture();
  try {
    const original = f.file.sync.bind(f.file);
    Object.defineProperty(f.file, "sync", { value: async () => {
      await original(); await rename(f.destination, join(f.root, "moved-original"));
      await mkdir(f.destination, {mode: 0o700});
      const replacement = await open(f.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await replacement.writeFile("synthetic ciphertext bytes"); await replacement.sync(); } finally { await replacement.close(); }
    } });
    await assert.rejects(commitCiphertextDownload({ file: f.file, destination: f.path, destinationDirectory: f.destination,
      key: "original-key", bytes: 26, archiveSha256: "a".repeat(64), lease: f.lease }), /download_parent_identity_changed/);
    assert.equal((await completionRecords(f.operation)).length, 0);
    assert.equal(await readFile(join(f.root, "moved-original", "download.pc1"), "utf8"), "synthetic ciphertext bytes");
  } finally { await f.file.close(); await rm(f.root, {recursive: true, force: true}); }
});
