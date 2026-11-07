import test from "node:test";
import assert from "node:assert/strict";
import {
  pinStudyPolicy,
  studyPolicyPinPlan,
  type PolicyPinPorts,
  type SavedPin,
} from "../harness/study-policy-pin.ts";
const plan = await studyPolicyPinPlan();
const instant = Date.parse("2026-11-07T10:00:00Z");
const bounds = {
  expectedSha256: plan.pin.sha256,
  notBefore: "2026-11-07T10:00:00Z",
  deadline: "2026-11-07T10:15:00Z",
};
function fixture() {
  let now = instant,
    adds = 0,
    reconciles = 0,
    secrets = 0,
    fail = false;
  let saved: SavedPin | undefined;
  const events: string[] = [];
  const ports: PolicyPinPorts = {
    now: () => now,
    read: async () => {
      events.push("read");
      return saved;
    },
    save: async (value) => {
      events.push("save:" + value.state);
      saved = structuredClone(value);
    },
    secret: async () => {
      secrets++;
      events.push("secret");
      return "local-simulated-token";
    },
    add: async (_pin, _bytes, _secret, received) => {
      adds++;
      events.push("add");
      await received({ status: 200, body: "public local CID receipt" });
      if (fail) throw Error("response lost after provider receipt");
    },
    reconcile: async () => {
      reconciles++;
      events.push("reconcile");
    },
  };
  return {
    ports,
    events,
    saved: () => saved,
    counts: () => ({ adds, reconciles, secrets }),
    now: (v: number) => {
      now = v;
    },
    fail: () => {
      fail = true;
    },
    seed: (v: unknown) => {
      ports.read = async () => v;
    },
  };
}
test("Study policy pin is fixed canonical public content with one add maximum", () => {
  assert.equal(
    plan.pin.sha256,
    "0xc5c4a83b87b25eff023ac610e9de8ea4e94fa8eee01c8c4a8413112e34e4e8e3",
  );
  assert.equal(plan.pin.byteLength, 297);
  assert.equal(plan.maximumAdds, 1);
});
test("wrong content hash, expired window and oversized window refuse before private or provider effects", async () => {
  for (const changed of [
    { ...bounds, expectedSha256: "0x" + "00".repeat(32) },
    { ...bounds, deadline: bounds.notBefore },
    { ...bounds, deadline: "2026-11-07T10:16:00Z" },
    { ...bounds, deadline: "2026-11-07T10:15:00" },
    { ...bounds, notBefore: "2026-11-07T14:00:00+04:00" },
  ]) {
    const f = fixture();
    await assert.rejects(pinStudyPolicy(changed, f.ports));
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  f.now(Date.parse(bounds.deadline));
  await assert.rejects(pinStudyPolicy(bounds, f.ports));
  assert.deepEqual(f.events, []);
});
test("durable preparation precedes add; completed retries only reconcile and retain original receipt", async () => {
  const f = fixture();
  await pinStudyPolicy(bounds, f.ports);
  assert.ok(f.events.indexOf("save:prepared") < f.events.indexOf("add"));
  assert.equal(f.saved()?.state, "retained");
  assert.deepEqual(f.saved()?.receipt, {
    status: 200,
    body: "public local CID receipt",
  });
  await pinStudyPolicy(bounds, f.ports);
  assert.deepEqual(f.counts(), { adds: 1, reconciles: 1, secrets: 2 });
  assert.deepEqual(f.saved()?.receipt, {
    status: 200,
    body: "public local CID receipt",
  });
});
test("lost provider response retains the original receipt and never adds on recovery", async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(pinStudyPolicy(bounds, f.ports), /response lost/);
  assert.equal(f.saved()?.state, "unknown");
  assert.deepEqual(f.saved()?.receipt, {
    status: 200,
    body: "public local CID receipt",
  });
  await pinStudyPolicy(bounds, f.ports);
  assert.deepEqual(f.counts(), { adds: 1, reconciles: 1, secrets: 2 });
  assert.deepEqual(f.saved()?.receipt, {
    status: 200,
    body: "public local CID receipt",
  });
});
test("malformed existing journal data refuses before credentials or provider calls", async () => {
  for (const invalid of [
    null,
    false,
    0,
    "prepared",
    [],
    {},
    {
      uri: plan.pin.uri,
      sha256: plan.pin.sha256,
      state: "prepared",
      unexpected: true,
    },
  ]) {
    const f = fixture();
    f.seed(invalid);
    await assert.rejects(pinStudyPolicy(bounds, f.ports), /journal_changed/);
    assert.deepEqual(f.counts(), { adds: 0, reconciles: 0, secrets: 0 });
  }
});
test("an unsigned prepared pin and changed journal both avoid another add", async () => {
  const f = fixture();
  f.seed({ uri: plan.pin.uri, sha256: plan.pin.sha256, state: "prepared" });
  await pinStudyPolicy(bounds, f.ports);
  assert.deepEqual(f.counts(), { adds: 0, reconciles: 1, secrets: 1 });
  const g = fixture();
  g.seed({ uri: plan.pin.uri, sha256: "changed", state: "unknown" });
  await assert.rejects(pinStudyPolicy(bounds, g.ports), /journal_changed/);
  assert.deepEqual(g.counts(), { adds: 0, reconciles: 0, secrets: 0 });
});
test("a clock crossing during credential retrieval cannot dispatch provider work", async () => {
  const f = fixture();
  f.ports.secret = async () => {
    f.now(Date.parse(bounds.deadline));
    return "local-simulated-token";
  };
  await assert.rejects(pinStudyPolicy(bounds, f.ports), /window_expired/);
  assert.equal(f.counts().adds, 0);
  assert.equal(f.saved(), undefined);
});
