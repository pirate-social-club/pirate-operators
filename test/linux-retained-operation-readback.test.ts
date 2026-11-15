import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOperation, hash, processIdentity } from "../deploy/linux/backend-state.ts";
import { readRetainedOperation } from "../deploy/linux/retained-operation-readback.ts";

// Prepared real-filesystem negatives only; no host-custody acceptance. UNRUN.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pirate-retained-operation-"));
  const original = join(root, "original"), observation = join(root, "observation");
  await mkdir(original, { mode: 0o700 }); await mkdir(observation, { mode: 0o700 });
  const frame = await processIdentity(process.pid); assert(frame);
  const body = { originalRequestRef: "opaque-original-request" }, installationId = "1".repeat(64), operationId = "operation-original";
  const originalLease = await acquireOperation(original, operationId, installationId, body, frame.pidNamespace);
  const observationLease = await acquireOperation(observation, operationId, installationId, { observationOf: original }, frame.pidNamespace);
  return { root, original, originalLease, input: { originalDirectory: original, operationId, installationId,
    expectedIntentDigest: hash(JSON.stringify(body)), observationLease } };
}
test("read-only reconciliation refuses a still-live original holder without replacing its identity", async () => {
  const f = await fixture();
  try {
    const path = join(f.original, "active-operation.json"), before = await readFile(path);
    await assert.rejects(readRetainedOperation(f.input), /lifetime_still_present/);
    assert.deepEqual(await readFile(path), before);
    assert.equal(f.input.operationId, f.input.observationLease.operationId);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("tampered original history fails before any claim of readback or release", async () => {
  const f = await fixture();
  try {
    const ref = await f.originalLease.record("phase-original", { source: "unit-fixture" });
    const path = join(f.original, ref.relativePath), row = JSON.parse(await readFile(path, "utf8"));
    row.previous = "0".repeat(64); await writeFile(path, JSON.stringify(row) + "\n", { mode: 0o600 });
    const before = await readFile(join(f.original, "active-operation.json"));
    await assert.rejects(readRetainedOperation(f.input), /history_chain_invalid/);
    assert.deepEqual(await readFile(join(f.original, "active-operation.json")), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("release cannot be satisfied by an absent or no-op authority callback", async () => {
  const f = await fixture();
  try {
    const path = join(f.original, "active-operation.json"), before = await readFile(path);
    await assert.rejects(f.originalLease.release(), /backend_release_authority_join_missing/);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
