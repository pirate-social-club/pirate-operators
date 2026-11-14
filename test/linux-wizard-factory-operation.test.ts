// Parser/operation contract regressions only. No fixture adapter is started;
// these cases do not qualify a Linux host, authority, health or recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { retainLinuxOperation } from "../deploy/linux/wizard-backend.ts";
import { digestJson } from "../apps/community-wizard/server/linux-journal.ts";
import { planFrom } from "../apps/community-wizard/server/linux-boundaries.ts";
import { fixtureDraft, fixtureProfile } from "./linux-shared-native-profile-fixture.ts";
import type { LinuxOperation, LinuxPlan } from "../apps/community-wizard/server/linux-contracts.ts";

function operation(kind: LinuxOperation["kind"], action: LinuxPlan["action"]): LinuxOperation {
  const draft = { ...fixtureDraft(), mode: kind }, profile = fixtureProfile(draft);
  const body: Omit<LinuxPlan, "digest"> = {
    id: "plan:factory-regression", profileDigest: digestJson(profile), expiresAt: 2_000_000_060_000,
    backend: {
      target: { endpointRef: "local:fixture", endpointIdentityDigest: "1".repeat(64),
        stateNamespace: "state:fixture", deploymentId: profile.identity.deploymentId },
      release: { sourceHead: "a".repeat(40), sourceTree: "b".repeat(40),
        manifest: { relativePath: "release/manifest.json", sha256: "2".repeat(64) },
        selectedProfileDigest: digestJson(profile), requiredServices: ["application", "accounts", "media", "jobs"] },
    },
    profile, operatorPolicy:null, targetInspectionId: "inspection:fixture", targetFingerprint: "host:fixture",
    namespaceProofId: "namespace:fixture", action, changes: [], warnings: [], requirements: [],
    restoreInspectionId: kind === "restore" ? "restore:fixture" : null,
    restoreManifestDigest: kind === "restore" ? "0x" + "3".repeat(64) : null,
    restoreCiphertextDigest: kind === "restore" ? "0x" + "4".repeat(64) : null,
    predecessorOperationId: action === "upgrade" ? "operation:original" : null,
    sessionPolicy: "revoke-existing",
  };
  const plan = planFrom({ ...body, digest: digestJson(body) });
  return { id: "operation:current", kind, draftRevision: 2, plan, startedAt: 2_000_000_000_000 };
}
function rehash(plan: LinuxPlan): LinuxPlan {
  const { digest: _previous, ...body } = plan;
  return { ...body, digest: digestJson(body) };
}

test("real W6 canonical raw plan/profile digests pass the factory operation boundary", () => {
  const value = operation("create", "create"), before = structuredClone(value);
  assert.equal(value.plan.digest.length, 64); assert.equal(value.plan.profileDigest.length, 64);
  assert.equal(value.plan.profile.runtime.sourceDigest.length, 66);
  const retained = retainLinuxOperation(value);
  assert.deepEqual(retained, value); assert.deepEqual(value, before);
  retained.plan.profile.identity.resources.database = "db:changed-copy";
  assert.deepEqual(value, before);
});

test("prefixed plan/profile digests and an unbound profile change are refused", () => {
  for (const field of ["digest", "profileDigest"] as const) {
    const value = operation("create", "create"); value.plan[field] = "0x" + value.plan[field];
    assert.throws(() => retainLinuxOperation(value));
  }
  const changed = operation("create", "create");
  changed.plan.profile.identity.resources.database = "db:changed";
  changed.plan = rehash(changed.plan); // Full plan rehash does not repair stale profileDigest.
  assert.throws(() => retainLinuxOperation(changed));
});

test("admitted create/import upgrade plans keep original kind predecessor and resources", () => {
  for (const kind of ["create", "import"] as const) {
    const value = operation(kind, "upgrade"), before = structuredClone(value);
    const retained = retainLinuxOperation(value);
    assert.equal(retained.kind, kind); assert.equal(retained.plan.action, "upgrade");
    assert.equal(retained.plan.predecessorOperationId, "operation:original");
    assert.deepEqual(retained.plan.profile.identity, before.plan.profile.identity);
    assert.deepEqual(value, before);
  }
});

test("create upgrades cannot omit their original predecessor operation", () => {
  const value = operation("create", "upgrade"); value.plan.predecessorOperationId = null;
  value.plan = rehash(value.plan); const before = structuredClone(value);
  assert.throws(() => retainLinuxOperation(value), /upgrade_predecessor_required/);
  assert.deepEqual(value, before);
});

test("initial import may carry a reviewed upgrade without inventing a predecessor operation", () => {
  const value = operation("import", "upgrade"); value.plan.predecessorOperationId = null;
  value.plan = rehash(value.plan);
  assert.equal(retainLinuxOperation(value).plan.predecessorOperationId, null);
});

test("restore upgrades and unrelated create/import action substitutions are refused", () => {
  for (const [kind, action] of [["restore", "upgrade"], ["restore", "create"],
    ["create", "adopt"], ["import", "create"]] as const) {
    assert.throws(() => retainLinuxOperation(operation(kind, action)), /linux_backend_operation_action_mismatch/);
  }
});

test("runtime/artifact digests retain their prefixed contract despite raw plan hashes", () => {
  for (const field of ["sourceDigest", "artifactDigest"] as const) {
    const value = operation("create", "create");
    value.plan.profile.runtime[field] = value.plan.profile.runtime[field].slice(2);
    value.plan.profileDigest = digestJson(value.plan.profile); value.plan = rehash(value.plan);
    assert.throws(() => retainLinuxOperation(value));
  }
});
