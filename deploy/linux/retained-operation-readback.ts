import assert from "node:assert/strict";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hash, privateDirectory, privateFile, processIdentity, safeId, type OperationLease, type ProcessIdentity } from "./backend-state.ts";
import { requireLifetimeAbsent, requireObserverHostFrame } from "./writer-evidence.ts";

async function document(path: string) {
  const file = await privateFile(path, 1048576);
  try {
    const before = await file.stat({ bigint: true }), bytes = await file.readFile(), after = await file.stat({ bigint: true });
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "retained_operation_changed_during_readback");
    return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes), inode: before.ino.toString() };
  } finally { await file.close(); }
}

/** Read-only original operation readback. Its observation lease is held in a
 * separate private directory under the SAME original operation ID. No old
 * lease, history, deployment identity or maintenance guard is replaced. */
export async function readRetainedOperation(input: {
  originalDirectory: string; operationId: string; installationId: string; expectedIntentDigest: string;
  observationLease: OperationLease;
}) {
  const lease = input.observationLease; await lease.assertHeld();
  requireObserverHostFrame(lease.holder, await processIdentity(process.pid));
  assert(safeId(input.operationId) && lease.operationId === input.operationId && lease.installationId === input.installationId);
  assert(input.originalDirectory !== lease.directory, "reconciliation_requires_separate_observation_custody");
  await privateDirectory(input.originalDirectory);
  const originalDirectory = await lstat(input.originalDirectory), observationDirectory = await lstat(lease.directory);
  assert(originalDirectory.dev !== observationDirectory.dev || originalDirectory.ino !== observationDirectory.ino,
    "reconciliation_custody_directory_alias");
  const active = await document(join(input.originalDirectory, "active-operation.json"));
  assert(active.value.operationId === input.operationId && active.value.installationId === input.installationId &&
    active.value.intentDigest === input.expectedIntentDigest, "retained_operation_identity_mismatch");
  const fileId = hash(input.operationId), intent = await document(join(input.originalDirectory, "intent-" + fileId + ".json"));
  assert(intent.value.operationId === input.operationId && intent.value.installationId === input.installationId &&
    intent.value.intentDigest === input.expectedIntentDigest && hash(JSON.stringify(intent.value.intent)) === input.expectedIntentDigest,
    "retained_operation_intent_mismatch");
  const names = (await readdir(input.originalDirectory)).filter((name) => name.startsWith(fileId + "-") && name.endsWith(".json"));
  const records = await Promise.all(names.map(async (name) => ({ name, ...await document(join(input.originalDirectory, name)) })));
  records.sort((a, b) => a.value.sequence - b.value.sequence);
  let previous = intent.sha256;
  const known = new Map<string, ProcessIdentity>();
  known.set(active.value.holder.hostPid + ":" + active.value.holder.hostStartTicks, active.value.holder);
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!, row = record.value;
    assert(row.operationId === input.operationId && row.installationId === input.installationId && row.sequence === index + 1 &&
      row.previous === previous && safeId(row.phase), "retained_operation_history_chain_invalid");
    assert(record.name === fileId + "-" + String(row.sequence).padStart(4, "0") + "-" + hash(row.phase).slice(0, 16) + ".json");
    previous = record.sha256;
    if (row.facts?.owned) {
      const owner = row.facts.owned as ProcessIdentity, key = owner.hostPid + ":" + owner.hostStartTicks;
      const old = known.get(key); if (old) assert.deepEqual(old, owner, "retained_owner_identity_changed_uncertain");
      known.set(key, owner);
    }
  }
  const first = [], second = [];
  for (const owner of known.values()) first.push(requireLifetimeAbsent(owner, await processIdentity(owner.hostPid)));
  requireObserverHostFrame(lease.holder, await processIdentity(process.pid));
  for (const owner of known.values()) second.push(requireLifetimeAbsent(owner, await processIdentity(owner.hostPid)));
  const final = await document(join(input.originalDirectory, "active-operation.json"));
  assert(final.sha256 === active.sha256 && final.inode === active.inode, "retained_operation_changed_after_readback");
  const finalNames = (await readdir(input.originalDirectory)).filter((name) => name.startsWith(fileId + "-") && name.endsWith(".json")).sort();
  assert.deepEqual(finalNames, [...names].sort(), "retained_operation_history_pathset_changed");
  for (const record of records) assert.equal((await document(join(input.originalDirectory, record.name))).sha256, record.sha256,
    "retained_operation_history_bytes_changed");
  const facts = { originalOperationId: input.operationId, installationId: input.installationId, originalIntentDigest: input.expectedIntentDigest,
    originalLeaseSha256: active.sha256, originalIntentSha256: intent.sha256, historyTipSha256: previous,
    records: records.map((row) => ({ path: row.name, sha256: row.sha256 })), first, second,
    scope: "recorded-process-and-filesystem-readback-only", originalLeaseRemoved: false, startupFencesRemoved: false,
    independentHostUnion: "REQUIRED", actualResourcesAndDomains: "REQUIRED", ready: false };
  const evidence = await lease.record("original-operation-readback", facts);
  return { facts, evidence };
}
