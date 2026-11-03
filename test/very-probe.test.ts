import { test } from "node:test";
import assert from "node:assert/strict";
import { Probe, TTL_MS } from "../harness/very/probe.ts";
import { encrypt, hostedProvider } from "../packages/very/transport.ts";
import { deferred, fakeProvider, proofFixture } from "./very-fixture.ts";

test("initialized bridge polling preserves the QR and key until verified completion", async () => {
  let launch!: { scope: string; binding: string; key: Buffer };
  let polls = 0;
  let verifications = 0;
  let now = 0;
  const hosted = hostedProvider(async (url) => {
    if (String(url).endsWith("/sessions"))
      return Response.json({ sessionId: "fixture-session" });
    if (String(url).includes("/session/")) {
      polls++;
      if (polls <= 3) return Response.json({ status: "initialized" });
      if (polls === 4) return Response.json({ status: "received" });
      return Response.json({
        status: "completed",
        response: encrypt(
          proofFixture(launch.scope, launch.binding),
          launch.key,
        ),
      });
    }
    verifications++;
    return Response.json({ status: "valid" });
  });
  const probe = new Probe(
    {
      ...hosted,
      async open(appId, scope, binding, key) {
        launch = { scope, binding, key };
        return hosted.open(appId, scope, binding, key);
      },
    },
    "fixture-app",
    "fixture",
    () => now,
  );
  await probe.start();
  const originalQr = probe.view().launch;
  assert.ok(originalQr);
  for (let i = 0; i < 4; i++) {
    now += 3000;
    await probe.poll();
    assert.equal(probe.view().state, "waiting");
    assert.equal(probe.view().launch, originalQr);
    assert.ok(launch.key.some((byte) => byte !== 0));
    assert.equal(probe.report().observations.length, 0);
  }
  assert.equal(verifications, 0);
  await probe.poll();
  assert.equal(verifications, 1);
  assert.equal(probe.report().observations.length, 1);
  assert.equal(probe.view().launch, null);
  assert.ok(launch.key.every((byte) => byte === 0));
});

test("four verified observations compare subjects and redact persistent output", async () => {
  const fake = fakeProvider();
  const probe = new Probe(fake.provider, "private-local-app-id", "fixture");
  for (let i = 0; i < 4; i++) {
    await probe.start();
    assert.equal(probe.view().state, "waiting");
    assert.match(probe.view().launch!, /^veros:\/\/verify\?/);
    await probe.poll();
    assert.ok(fake.requests[i].key.every((byte) => byte === 0));
  }
  assert.equal(fake.verifies, 4);
  assert.equal(new Set(fake.requests.map((r) => r.binding)).size, 4);
  assert.equal(probe.view().launch, null);
  assert.deepEqual(probe.report().comparisons, {
    repeatStable: true,
    changedBindingStable: true,
    changedScopeSeparated: true,
  });
  assert.equal(probe.report().mode, "fixture");
  const output = JSON.stringify(probe.report());
  for (const privateValue of [
    "12345",
    "67890",
    "private-local-app-id",
    "fixture-1",
    ...fake.requests.map((r) => r.binding),
  ])
    assert.ok(!output.includes(privateValue));
  await probe.start();
  assert.equal(fake.requests.length, 4);
  probe.reset();
  assert.equal(probe.report().complete, false);
  assert.deepEqual(probe.report().observations, []);
});

test("inconsistent subjects are reported as negative evidence, not coerced to success", async () => {
  const fake = fakeProvider();
  fake.provider.poll = async () => {
    const r = fake.requests.at(-1)!;
    return proofFixture(
      r.scope,
      r.binding,
      fake.requests.length === 2 ? "999" : "12345",
    );
  };
  const probe = new Probe(fake.provider, "app", "fixture");
  for (let i = 0; i < 4; i++) {
    await probe.start();
    await probe.poll();
  }
  assert.deepEqual(probe.report().comparisons, {
    repeatStable: false,
    changedBindingStable: true,
    changedScopeSeparated: false,
  });
});

test("mismatched proof never reaches verifier; rejected verification records nothing", async () => {
  const fake = fakeProvider();
  const probe = new Probe(fake.provider, "app", "fixture");
  fake.provider.poll = async () => proofFixture("1000001", "wrong-binding");
  await probe.start();
  await probe.poll();
  assert.equal(fake.verifies, 0);
  assert.equal(probe.view().state, "failed");
  assert.match(
    probe.view().error!,
    /proof shape or request binding \(invalid_field\)/,
  );
  fake.provider.poll = async () => {
    const r = fake.requests.at(-1)!;
    return proofFixture(r.scope, r.binding);
  };
  fake.provider.verify = async () => {
    throw new Error("secret-provider-body");
  };
  await probe.start();
  await probe.poll();
  assert.deepEqual(probe.report().observations, []);
  assert.match(
    probe.view().error!,
    /hosted verification \(unexpected_failure\)/,
  );
  assert.ok(!JSON.stringify(probe.view()).includes("secret-provider-body"));
});

test("expiry is strict at the boundary and after an in-flight verifier response", async () => {
  for (const offset of [-1, 0, 1]) {
    let now = 0;
    const fake = fakeProvider();
    const probe = new Probe(fake.provider, "app", "fixture", () => now);
    await probe.start();
    now = TTL_MS + offset;
    await probe.poll();
    assert.equal(probe.report().observations.length, offset < 0 ? 1 : 0);
    assert.equal(fake.verifies, offset < 0 ? 1 : 0);
  }
  let now = 0;
  const fake = fakeProvider();
  const pending = deferred<void>();
  const entered = deferred<void>();
  fake.provider.verify = async () => {
    entered.resolve();
    await pending.promise;
  };
  const probe = new Probe(fake.provider, "app", "fixture", () => now);
  await probe.start();
  const work = probe.poll();
  await entered.promise;
  now = TTL_MS;
  pending.resolve();
  await work;
  assert.equal(probe.view().state, "expired");
  assert.equal(probe.report().observations.length, 0);
});

test("concurrent starts and polls are single-flight; reset discards late results", async () => {
  const fake = fakeProvider();
  const pending = deferred<void>();
  const entered = deferred<void>();
  fake.provider.verify = async () => {
    entered.resolve();
    await pending.promise;
  };
  const probe = new Probe(fake.provider, "app", "fixture");
  await Promise.all([probe.start(), probe.start()]);
  assert.equal(fake.requests.length, 1);
  const work = probe.poll();
  await entered.promise;
  await probe.poll();
  probe.reset();
  assert.ok(fake.requests[0].key.every((b) => b === 0));
  await probe.start();
  pending.resolve();
  await work;
  assert.equal(probe.view().state, "waiting");
  assert.equal(probe.report().observations.length, 0);
  probe.reset();
});

test("reset during bridge creation discards a late session", async () => {
  const fake = fakeProvider();
  const pending = deferred<{ id: string }>();
  fake.provider.open = async () => pending.promise;
  const probe = new Probe(fake.provider, "app", "fixture");
  const work = probe.start();
  probe.reset();
  pending.resolve({ id: "late" });
  await work;
  assert.equal(probe.view().state, "ready");
  assert.equal(probe.view().launch, null);
});
