// UNRUN: real controller/filesystem journal, controlled external adapters.
import test from "node:test";
import assert from "node:assert/strict";
import {
  linuxFixture,
  fixtureCiphertext,
  fixtureProfile,
  fixtureDraft,
  deferred,
} from "./community-wizard-linux-fixture.ts";
async function configured(t: { after(fn: () => Promise<void>): void }) {
  const f = await linuxFixture();
  t.after(f.dispose);
  await f.configure();
  return f;
}
test("concurrent duplicate approvals CAS one original intent and invoke the native operator once", async (t) => {
  const f = await configured(t);
  const plan = await f.review();
  await Promise.all([f.deploy(plan), f.deploy(plan)]);
  await f.setup.settled();
  assert.equal(f.facts.nativeIntents.length, 1);
  assert.equal(f.setup.snapshot().history.length, 0);
  assert.equal(f.setup.snapshot().operation?.state, "succeeded");
});
test("unchanged pending receipts deduplicate across repeated readbacks and restart without blocking terminal recovery", async (t) => {
  const f = await configured(t);
  f.backend.observeResult = async ({ operation }) => ({
    state: "pending",
    custody: "held",
    revision: 1,
    receiptRef: "receipt:unchanged",
    correction: "No progress",
  });
  await f.review();
  await f.deploy();
  await f.setup.settled();
  const before = f.setup.snapshot().operation!;
  for (let i = 0; i < 64; i++) await f.setup.reconcile();
  assert.equal(f.setup.snapshot().operation!.results.length, 1);
  const resumed = await f.open();
  for (let i = 0; i < 16; i++) await resumed.reconcile();
  assert.equal(resumed.snapshot().operation!.results.length, 1);
  assert.equal(resumed.snapshot().operation!.id, before.id);
  f.backend.observeResult = async ({ operation }) => f.success(operation, 2);
  await resumed.reconcile();
  assert.equal(resumed.snapshot().operation!.state, "succeeded");
  assert.equal(resumed.snapshot().operation!.results.length, 1);
  assert.equal(f.facts.nativeIntents.length, 1);
});
test("ciphertext streaming has its own bounded deadline rather than the short metadata deadline", async (t) => {
  const f = await linuxFixture({ timeoutMs: 10, uploadTimeoutMs: 500 });
  t.after(f.dispose);
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: { kind: "local-linux" },
  });
  await f.setup.stageBackup(
    (async function* () {
      yield fixtureCiphertext.subarray(0, 3);
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield fixtureCiphertext.subarray(3);
    })(),
    fixtureCiphertext.length,
  );
  assert.ok(f.setup.snapshot().backupId);
  assert.equal(f.setup.snapshot().uploadRequest, null);
});
test("a complete outcome missing captured resource readbacks cannot promote the application to deployed", async (t) => {
  const f = await configured(t);
  f.backend.operator.deploy = async (intent) => ({
    ...f.result(intent.operationId),
    resources: [],
  });
  await f.review();
  await f.deploy();
  await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.state, "unknown");
  assert.equal(f.setup.snapshot().operation?.custody, "held");
});

test("concurrent fresh uploads cannot replace the first durable request while capability reads are delayed", async (t) => {
  const f = await linuxFixture();
  t.after(f.dispose);
  await f.setup.destination({
    revision: 0,
    mode: "restore",
    target: { kind: "local-linux" },
  });
  const both = deferred<void>();
  let readers = 0,
    uploads = 0;
  const capabilities = f.backend.capabilities,
    stage = f.backend.stageBackup;
  f.backend.capabilities = async () => {
    if (++readers === 2) both.resolve();
    await both.promise;
    return capabilities();
  };
  f.backend.stageBackup = async (input) => {
    uploads++;
    return stage(input);
  };
  const send = () =>
    f.setup.stageBackup(
      (async function* () {
        yield fixtureCiphertext;
      })(),
      fixtureCiphertext.length,
    );
  const results = await Promise.allSettled([send(), send()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(uploads, 1);
  assert.ok(f.setup.snapshot().backupId);
});
test("a previously attempted import cannot replace its captured identity with another discovered installation", async (t) => {
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
  await f.setup.importProfile({
    revision: f.setup.snapshot().revision,
    profile: installed,
  });
  await f.setup.namespace();
  await f.review();
  await f.deploy();
  await f.setup.settled();
  const original = structuredClone(f.setup.snapshot().operation);
  const foreign = fixtureProfile(fixtureDraft("other-community"));
  f.facts.existing.push(foreign);
  await f.setup.inspect();
  await assert.rejects(
    f.setup.importProfile({
      revision: f.setup.snapshot().revision,
      profile: foreign,
    }),
    /retains its captured community/,
  );
  assert.deepEqual(f.setup.snapshot().identity, installed.identity);
  assert.deepEqual(f.setup.snapshot().operation, original);
  assert.equal(f.facts.nativeIntents.length, 1);
});

test("pending or unavailable namespace results retain no invented authority identity or scope and cannot prepare an apply", async (t) => {
  const f = await configured(t);
  f.facts.authority = "pending";
  await f.setup.namespace();
  assert.deepEqual(f.setup.snapshot().namespace, {
    tld: "fixture",
    status: "pending",
    correction: "Wait for current authority reconciliation.",
  });
  await assert.rejects(
    f.setup.review(),
    /Inspect a supported host|namespace|controlled-TLD/,
  );
  assert.equal(f.facts.nativeIntents.length, 0);
  f.facts.authority = "unavailable";
  await f.setup.namespace();
  assert.equal(f.setup.snapshot().namespace?.status, "unavailable");
  assert.equal("authorityRef" in f.setup.snapshot().namespace!, false);
});
