// UNRUN source: actual wizard controller + private filesystem journal, controlled
// backend/naming ports. This is not Linux/provider/encryption acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  linuxFixture,
  fixtureDraft,
  fixtureProfile,
  fixtureCiphertext,
  fixtureKey,
  deferred,
} from "./community-wizard-linux-fixture.ts";
import {
  LinuxInputError,
  linuxDraftFrom,
  linuxProfileFrom,
} from "../packages/community-setup/shared-linux-profile.ts";
import type {
  LinuxObservation,
  LinuxOperationResult,
} from "../apps/community-wizard/server/linux-contracts.ts";
async function configured(
  t: { after(fn: () => Promise<void>): void },
  learning = false,
) {
  const f = await linuxFixture();
  t.after(f.dispose);
  const draft = structuredClone(f.draft);
  if (learning) {
    draft.features.learning = true;
    draft.services.learningProfile = "learning:verified";
  }
  await f.configure(draft);
  return f;
}
test("create persists both exact reviewed operation and bound native intent before a single full-app deployment", async (t) => {
  const f = await configured(t),
    original = f.backend.operator.deploy;
  f.backend.operator.deploy = async (intent, signal) => {
    const saved = JSON.parse(await f.disk());
    assert.equal(saved.operation.id, intent.operationId);
    assert.deepEqual(saved.operation.intent, { kind: "deploy", intent });
    assert.equal(saved.operation.plan.digest, intent.planDigest);
    return original(intent, signal);
  };
  const plan = await f.review();
  await f.deploy(plan);
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
  assert.equal(f.facts.executes.length, 1);
  await f.deploy(plan);
  assert.equal(
    f.facts.executes.length,
    1,
    "lost HTTP acknowledgement must not send a second operation",
  );
  assert.equal(
    (await stat(join(f.directory, "linux-setup-v2.json"))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(f.setup.snapshot().identity, plan.profile.identity);
});
test("saved Learning credentials are not readiness; verified Learning deploys with the same application operation", async (t) => {
  const f = await configured(t, true),
    secret = "fixture-community-speech-secret-never-real";
  await f.setup.saveCredentials({
    revision: f.setup.snapshot().revision,
    values: { ELEVENLABS_API_KEY: secret },
  });
  await f.review();
  await assert.rejects(f.deploy(), /Saved credentials are not readiness/);
  assert.equal(f.facts.executes.length, 0);
  await f.setup.verifyCredentials();
  const plan = await f.review();
  await f.deploy(plan);
  await f.setup.settled();
  assert.equal(f.facts.executes.length, 1);
  assert.ok(f.facts.executes[0]!.plan.profile.identity.resources.learning);
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
  assert.ok(!(await f.disk()).includes(secret));
  assert.ok(!JSON.stringify(f.setup.snapshot()).includes(secret));
});
test("lost credential acknowledgement retains a body-free request and reconciles before replacement", async (t) => {
  const f = await configured(t, true);
  f.facts.lostSave = true;
  await assert.rejects(
    f.setup.saveCredentials({
      revision: f.setup.snapshot().revision,
      values: { ELEVENLABS_API_KEY: "fixture-private-body" },
    }),
    /credential write may have completed/,
  );
  const id = f.setup.snapshot().secretRequest!.id;
  assert.ok(!(await f.disk()).includes("fixture-private-body"));
  await assert.rejects(
    f.setup.configure({
      revision: f.setup.snapshot().revision,
      draft: { ...f.draft, name: "Corrected" },
    }),
    /Reconcile/,
  );
  const resumed = await f.open();
  assert.equal(resumed.snapshot().secretRequest!.id, id);
  await resumed.reconcileCredentials();
  assert.equal(resumed.snapshot().secretRequest, null);
  assert.equal(resumed.snapshot().requirements[0]!.state, "saved");
});
test("unknown native execution survives restart and never resends; exact typed readback reconciles original bytes", async (t) => {
  const f = await configured(t);
  const entered = deferred<void>();
  let sends = 0;
  f.backend.operator.deploy = async () => {
    sends++;
    entered.resolve();
    return new Promise<LinuxOperationResult>(() => {});
  };
  const plan = await f.review();
  await f.deploy(plan);
  await entered.promise;
  const original = f.setup.snapshot().operation!;
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.state, "unknown");
  assert.equal(f.setup.snapshot().operation?.custody, "held");
  const resumed = await f.open();
  await assert.rejects(
    resumed.configure({
      revision: resumed.snapshot().revision,
      draft: { ...f.draft, name: "Corrected" },
    }),
    /Reconcile/,
  );
  await resumed.deploy({
    revision: resumed.snapshot().revision,
    planDigest: plan.digest,
    targetFingerprint: plan.targetFingerprint,
    approved: true,
  });
  assert.equal(sends, 1);
  await resumed.reconcile();
  assert.equal(resumed.snapshot().operation?.state, "succeeded");
  assert.deepEqual(f.facts.reconciles[0], {
    id: original.id,
    kind: original.kind,
    draftRevision: original.draftRevision,
    plan: original.plan,
    startedAt: original.startedAt,
  });
});
test("cleared custody permits correction and review while ambiguous resources still block apply", async (t) => {
  const f = await configured(t);
  f.backend.observeResult = async ({ operation }) => ({
    state: "unknown",
    custody: "cleared",
    revision: ++f.facts.revision,
    receiptRef: `receipt:${operation.id}`,
    correction: "Controlled process clearance; effects remain unknown",
  });
  await f.review();
  await f.deploy();
  await f.setup.settled();
  const original = f.setup.snapshot().operation!;
  await f.setup.configure({
    revision: f.setup.snapshot().revision,
    draft: { ...f.draft, name: "Corrected community" },
  });
  await f.setup.inspect();
  await f.setup.namespace();
  const next = await f.review();
  assert.equal(next.predecessorOperationId, original.id);
  await assert.rejects(
    f.deploy(next),
    /Unknown original effects still block apply/,
  );
  assert.equal(f.facts.executes.length, 1);
  assert.deepEqual(f.setup.snapshot().operation!.intent, original.intent);
});
test("reconciled failure allows settings correction and a descendant plan on unchanged identities", async (t) => {
  const f = await configured(t),
    observe = f.backend.observeResult;
  f.backend.observeResult = async ({ operation }) => ({
    state: "failed",
    custody: "cleared",
    revision: ++f.facts.revision,
    receiptRef: `receipt:${operation.id}`,
    identity: operation.plan.profile.identity,
    effects: "retained",
    correction: "Fixture reconciled failure",
  });
  await f.review();
  await f.deploy();
  await f.setup.settled();
  const first = f.setup.snapshot().operation!;
  assert.equal(first.state, "failed");
  await f.setup.configure({
    revision: f.setup.snapshot().revision,
    draft: { ...f.draft, name: "Corrected community" },
  });
  const next = await f.review();
  assert.deepEqual(next.profile.identity, first.plan.profile.identity);
  assert.equal(next.predecessorOperationId, first.id);
  assert.equal(next.action, "upgrade");
  f.backend.observeResult = observe;
  await f.deploy(next);
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
  assert.deepEqual(
    f.setup.snapshot().history[0],
    first,
    "old failed intent and receipt must remain unchanged",
  );
});
test("stale readbacks cannot replace a newer terminal observation", async (t) => {
  const f = await configured(t);
  let phase = 0;
  const old = deferred<LinuxObservation>();
  f.backend.observeResult = async ({ operation }) =>
    phase === 0
      ? {
          state: "pending",
          custody: "held",
          revision: 1,
          receiptRef: `receipt:${operation.id}`,
          correction: "Fixture pending",
        }
      : phase === 1
        ? old.promise
        : f.success(operation, 3);
  await f.review();
  await f.deploy();
  await f.setup.settled();
  phase = 1;
  const delayed = f.setup.reconcile();
  await new Promise((r) => setTimeout(r, 5));
  phase = 2;
  await f.setup.reconcile();
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
  old.resolve({
    state: "pending",
    custody: "held",
    revision: 2,
    receiptRef: "receipt:old",
    correction: "Old pending read",
  });
  await delayed;
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
  assert.equal(f.setup.snapshot().operation?.observationRevision, 3);
});
test("hosting origin never proves namespace rights; fresh pending authority stops launch", async (t) => {
  const f = await configured(t);
  await f.review();
  f.facts.authority = "pending";
  await assert.rejects(
    f.deploy(),
    /Namespace authority changed or remains pending/,
  );
  assert.equal(f.facts.nativeIntents.length, 0);
  const profile=fixtureProfile(f.draft);
  profile.namespace.authorityKind="registry_admin" as typeof profile.namespace.authorityKind;
  assert.throws(()=>linuxProfileFrom(profile),/external HNS control|namespace_role/);

});
test("source and wrong-target intent cannot yield deployed", async (t) => {
  const f = await configured(t);
  const plan = await f.review();
  f.capabilities.sourceDigest = "0x" + "ef".repeat(32);
  await assert.rejects(f.deploy(plan), /Approve the current plan/);
  assert.equal(f.facts.nativeIntents.length, 0);
  f.capabilities.sourceDigest = plan.profile.runtime.sourceDigest;
  const bind = f.backend.bindOperation;
  f.backend.bindOperation = async (operation) => {
    const bound = await bind(operation);
    if (bound.kind === "deploy")
      return {
        ...bound,
        intent: {
          ...bound.intent,
          target: {
            ...bound.intent.target,
            deploymentId: "foreign:deployment",
          },
        },
      };
    return bound;
  };
  await f.deploy(plan);
  await f.setup.settled();
  assert.equal(f.facts.nativeIntents.length, 0);
  assert.equal(f.setup.snapshot().operation?.state, "unknown");
});
test("import inherits only the exact installation discovered on the selected host", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  const installed = fixtureProfile(f.draft);
  f.facts.existing = [installed];
  await f.setup.destination({
    revision: 0,
    mode: "import",
    target: { kind: "local-linux" },
  });
  await f.setup.inspect();
  const foreign = fixtureProfile(fixtureDraft("another-community"));
  await assert.rejects(
    f.setup.importProfile({
      revision: f.setup.snapshot().revision,
      profile: foreign,
    }),
    /did not return this exact profile/,
  );
  await f.setup.importProfile({
    revision: f.setup.snapshot().revision,
    profile: installed,
  });
  assert.equal(f.setup.snapshot().draft?.name, installed.settings.name);
  await f.setup.namespace();
  await f.review();
  await f.deploy();
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.plan.action, "adopt");
  assert.deepEqual(f.setup.snapshot().identity, installed.identity);
});
test("restore starts with destination only, binds ciphertext/key/identity/policy and uses the real restore method", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: {
      kind: "ssh-linux",
      host: "second-host.example",
      user: "operator",
      port: 22,
      connectionRef: "ssh:owned",
    },
  });
  assert.equal(f.setup.snapshot().draft, null);
  await f.setup.inspect();
  await f.setup.stageBackup(
    (async function* () {
      yield fixtureCiphertext;
    })(),
    fixtureCiphertext.length,
  );
  await assert.rejects(
    f.setup.inspectBackup({ recoveryKey: "wrong-fixture-key" }),
    /could not be authenticated/,
  );
  assert.equal(f.setup.snapshot().restore, null);
  assert.ok(!(await f.disk()).includes("wrong-fixture-key"));
  await f.setup.inspectBackup({ recoveryKey: fixtureKey });
  assert.ok(!(await f.disk()).includes(fixtureKey));
  assert.equal(f.setup.snapshot().draft?.target.kind, "ssh-linux");
  assert.deepEqual(
    f.setup.snapshot().identity,
    f.facts.restoreProfile.identity,
  );
  await f.setup.namespace();
  const plan = await f.review();
  await f.deploy(plan);
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.intent?.kind, "restore");
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
  assert.equal(plan.sessionPolicy, "revoke-existing");
});
test("partial or changed encrypted uploads retain their original request instead of claiming a supported backup", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: { kind: "local-linux" },
  });
  await assert.rejects(
    f.setup.stageBackup(
      (async function* () {
        yield fixtureCiphertext.subarray(0, 3);
      })(),
      fixtureCiphertext.length,
    ),
    /interrupted/,
  );
  assert.ok(f.setup.snapshot().uploadRequest);
  assert.equal(f.setup.snapshot().backupId, null);
  await assert.rejects(
    f.setup.destination({
      revision: f.setup.snapshot().revision,
      mode: "create",
      target: { kind: "local-linux" },
    }),
    /Reconcile/,
  );
  await f.setup.stageBackup(
    (async function* () {
      yield fixtureCiphertext;
    })(),
    fixtureCiphertext.length,
  );
  assert.equal(f.setup.snapshot().uploadRequest, null);
  assert.ok(f.setup.snapshot().backupDigest);
});
test("missing restore capability and malformed private journal fail closed", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  f.capabilities.operations = ["create"];
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: { kind: "local-linux" },
  });
  await assert.rejects(
    f.setup.stageBackup(
      (async function* () {
        yield fixtureCiphertext;
      })(),
      fixtureCiphertext.length,
    ),
    /supported encrypted backup/,
  );
  const path = join(f.directory, "linux-setup-v2.json"),
    saved = JSON.parse(await readFile(path, "utf8"));
  saved.version = 99;
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  await assert.rejects(
    f.open(),
    /unsupported setup journal|could not be read safely|unsupported/,
  );
});
test("two private community journals cannot acquire each other's resource identity", async (t) => {
  const a = await linuxFixture({ slug: "community-one" }),
    b = await linuxFixture({ slug: "community-two" });
  t.after(a.dispose);
  t.after(b.dispose);
  await a.configure();
  await b.configure();
  const pa = await a.review(),
    pb = await b.review();
  assert.notEqual(
    pa.profile.identity.communityId,
    pb.profile.identity.communityId,
  );
  assert.notEqual(pa.digest, pb.digest);
  await assert.rejects(
    b.setup.deploy({
      revision: b.setup.snapshot().revision,
      planDigest: pa.digest,
      targetFingerprint: pa.targetFingerprint,
      approved: true,
    }),
    /Approve the current plan/,
  );
  assert.equal(b.facts.nativeIntents.length, 0);
});
test("completed text and an empty process list cannot clear uncertain custody or promote a partial foundation", async (t) => {
  const f = await configured(t);
  f.backend.operator.deploy = async (intent) => ({
    ...f.result(intent.operationId),
    outcome: "custody-uncertain",
    unrunPhases: ["login", "media"],
    ownedProcesses: [],
  });
  f.backend.observeResult = async ({ operation }) => f.success(operation);
  await f.review();
  await f.deploy();
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.state, "unknown");
  assert.equal(f.setup.snapshot().operation?.custody, "held");
  assert.equal(
    f.setup.snapshot().operation?.results[0]?.outcome,
    "custody-uncertain",
  );
  await assert.rejects(
    f.setup.configure({
      revision: f.setup.snapshot().revision,
      draft: { ...f.draft, name: "Changed" },
    }),
    /Reconcile/,
  );
});
test("a changed same-size ciphertext cannot reuse a lost upload acknowledgement", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: { kind: "local-linux" },
  });
  f.facts.lostUpload = true;
  await assert.rejects(
    f.setup.stageBackup(
      (async function* () {
        yield fixtureCiphertext;
      })(),
      fixtureCiphertext.length,
    ),
  );
  const original = f.setup.snapshot().uploadRequest;
  assert.ok(original);
  f.facts.lostUpload = false;
  const changed = Buffer.from(fixtureCiphertext);
  changed[0] ^= 1;
  await assert.rejects(
    f.setup.stageBackup(
      (async function* () {
        yield changed;
      })(),
      changed.length,
    ),
    /immutable upload identity/,
  );
  assert.deepEqual(f.setup.snapshot().uploadRequest, original);
  assert.equal(f.setup.snapshot().backupId, null);
  await f.setup.stageBackup(
    (async function* () {
      yield fixtureCiphertext;
    })(),
    fixtureCiphertext.length,
  );
  assert.ok(f.setup.snapshot().backupId);
});
