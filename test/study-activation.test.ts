import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { hashJson } from "../packages/community/common.ts";
import { sha256File } from "../harness/megaeth/controller-inventory.ts";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import { studyActivationMain } from "../harness/megaeth/study-activation.ts";
import { activationFixture } from "./study-activation-fixture.ts";
const save = (f: Awaited<ReturnType<typeof activationFixture>>) =>
  writeFileSync(f.profilePath, JSON.stringify(f.profile));
test("actual CLI default is pure public preparation with one fixed revision3-to4 configure", async () => {
  const f = await activationFixture();
  f.ports.client = () => {
    throw Error("default created client");
  };
  f.ports.loadKey = () => {
    throw Error("default loaded key");
  };
  f.ports.loadPinSecret = async () => {
    throw Error("default loaded secret");
  };
  f.profile.readiness.record = join(f.directory, "missing-ready.json");
  f.profile.custody.record = join(f.directory, "missing-custody.json");
  f.profile.inventory[0]!.path = join(f.directory, "missing-inventory.json");
  save(f);
  const result = await f.run();
  assert.equal(result.mode, "plan");
  assert.ok("operation" in result);
  assert.equal(result.operation.to, f.profile.history[2].directory);
  assert.equal(result.operation.nonce, 30);
  assert.equal(result.manifest.configurationRevision, 4);
  assert.equal(result.manifest.learningRecords, f.profile.contract);
  assert.deepEqual(result.effects, {
    networkRequests: 0,
    keysRead: 0,
    stateWrites: 0,
    pinAdds: 0,
    transactions: 0,
  });
  assert.equal(existsSync(f.stateDirectory), false);
  assert.equal(existsSync(f.pinDirectory), false);
  assert.equal(
    f.state.keys + f.state.secrets + f.state.adds + f.state.sends.length,
    0,
  );
});
test("default and explicit modes refuse changed scope and unrelated execution flags before clients/secrets", async () => {
  for (const mutate of [
    (p: any) => (p.chainId = 1),
    (p: any) => (p.historyHashes[2] = "0x" + "1".repeat(64)),
    (p: any) => (p.manifestSha256 = "0x" + "2".repeat(64)),
    (p: any) => (p.pin.uri = "ipfs://changed"),
    (p: any) => (p.policies.study.effectivePeriod = "7"),
    (p: any) => (p.sourceHash = "0x" + "3".repeat(64)),
    (p: any) => (p.gas = "1500001"),
    (p: any) => (p.maximumTotalWei = "1"),
    (p: any) =>
      (p.deadline = new Date(Date.parse(p.notBefore) + 900001).toISOString()),
  ]) {
    const f = await activationFixture();
    mutate(f.profile);
    save(f);
    f.ports.client = () => {
      throw Error("must reject before client");
    };
    await assert.rejects(f.run());
    assert.equal(f.state.secrets + f.state.keys, 0);
  }
  const f = await activationFixture();
  await assert.rejects(
    f.run(["--key-file", "/never"]),
    /flags_without_execute/,
  );
  await assert.rejects(
    f.run(["--execute", "--expect-profile", "wrong", "--key-file", "/never"]),
    /explicit_profile/,
  );
});
test("actual observe performs read-only readiness/inventory/policy checks; future period6 is allowed during5", async () => {
  const f = await activationFixture();
  const result = await f.run(["--observe"]);
  assert.equal(result.mode, "observe");
  assert.ok("observation" in result);
  assert.equal(result.observation.currentPeriod, "5");
  assert.equal(result.observation.qualifyingPolicyActive, false);
  assert.equal(f.state.secrets + f.state.keys + f.state.adds, 0);
  assert.equal(existsSync(f.stateDirectory), false);
});
test("actual CLI pins once, journals before signing, configures once, and verifies full revision4 readback", async () => {
  const f = await activationFixture();
  const result = await f.execute();
  assert.equal(result.complete, true);
  assert.equal(result.state, "confirmed");
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.adds, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.active, true);
  f.state.now = Date.parse(f.profile.deadline) + 1000;
  f.state.price = 100000000n;
  const status = await f.run(["--status"]);
  assert.equal(status.complete, true);
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.adds, 1);
  assert.equal(f.state.sends.length, 1);
});
test("actual CLI requires each fresh independently reviewed release gate and raw evidence before managed secret", async () => {
  for (const kind of [
    "missing-check",
    "stale",
    "evidence-tamper",
    "changed-release",
    "wrong-migrations",
  ]) {
    const f = await activationFixture();
    const report = JSON.parse(readFileSync(f.readyPath, "utf8"));
    if (kind === "missing-check")
      report.checks.existingKaraokeV2ReadsPassed = false;
    if (kind === "stale")
      report.observedAt = new Date(
        Date.parse(f.profile.notBefore) - 1,
      ).toISOString();
    if (kind === "wrong-migrations") report.migrations = ["0009_study.sql"];
    if (kind === "changed-release")
      report.release.operatorModule = "0x" + "9".repeat(64);
    if (kind === "evidence-tamper")
      writeFileSync(f.evidence.v2Readback.path, "changed");
    writeFileSync(f.readyPath, JSON.stringify(report));
    f.profile.readiness.sha256 = sha256File(f.readyPath);
    save(f);
    await assert.rejects(
      f.execute(),
      /readiness|release_gate|evidence_changed/,
    );
    assert.equal(f.state.keys + f.state.secrets + f.state.adds, 0);
    assert.equal(existsSync(f.stateDirectory), false);
  }
});
test("changed V3 target, disabled grader, wrong policy and excessive fees stop before secret or signing", async () => {
  for (const change of [
    "code",
    "grader",
    "policy",
    "price",
    "gas",
    "balance",
    "dataFee",
  ] as const) {
    const f = await activationFixture();
    if (change === "code" || change === "grader" || change === "policy")
      f.state[change] = false;
    if (change === "price") f.state.price = 100n;
    if (change === "gas") f.state.gas = 2000000n;
    if (change === "balance") f.state.balance = 1n;
    if (change === "dataFee") f.state.dataFee = 101n;
    await assert.rejects(f.execute());
    assert.equal(f.state.sends.length, 0);
    if (["code", "grader", "policy", "price"].includes(change))
      assert.equal(f.state.secrets + f.state.keys, 0);
  }
});
test("lost pin response persists by content across renewed valid profiles and never adds twice", async () => {
  const f = await activationFixture();
  const original = hashJson(f.profile);
  f.state.lostPin = true;
  await assert.rejects(f.execute(), /lost pin/);
  assert.equal(f.state.adds, 1);
  assert.equal(f.state.keys, 0);
  const catalog = new ActivationJournal(
    join(f.stateDirectory, "dispatch-custody.sqlite"),
  );
  assert.equal(catalog.get("controller:profiles"), undefined);
  catalog.close();
  f.state.now += 1000;
  f.profile.notBefore = new Date(f.state.now - 500).toISOString();
  f.profile.deadline = new Date(f.state.now + 120000).toISOString();
  f.refresh();
  assert.notEqual(hashJson(f.profile), original);
  f.state.lostPin = false;
  const result = await f.execute();
  assert.equal(result.complete, true);
  assert.equal(f.state.adds, 1);
  assert.equal(f.state.keys, 1);
  assert.ok(f.state.reconciles >= 1);
});
test("lost response on a landed configure reconciles confirmed without another key, pin secret or send", async () => {
  const f = await activationFixture();
  f.state.lostSend = true;
  const first = await f.execute();
  assert.equal(first.state, "unknown");
  const secrets = f.state.secrets;
  f.ports.loadKey = () => {
    throw Error("duplicate key load");
  };
  f.ports.loadPinSecret = async () => {
    throw Error("duplicate secret load");
  };
  const recovered = await f.execute();
  assert.equal(recovered.complete, true);
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.adds, 1);
  assert.equal(f.state.secrets, secrets);
});
test("pending same raw is observed, while dropped unknown reuses exact bytes and same reserved charge", async () => {
  const f = await activationFixture();
  f.state.landed = false;
  const first = await f.execute();
  assert.equal(first.state, "unknown");
  const raw = f.state.sends[0],
    secrets = f.state.secrets;
  f.state.pending = true;
  const pending = await f.execute();
  assert.equal(pending.state, "pending");
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.secrets, secrets);
  f.state.pending = false;
  const dropped = await f.execute();
  assert.equal(dropped.state, "unknown");
  assert.deepEqual(f.state.sends, [raw, raw]);
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.adds, 1);
  f.state.pending = true;
  f.state.wrongPending = true;
  await assert.rejects(f.execute(), /pending_conflict/);
  assert.equal(f.state.sends.length, 2);
});
test("canonical revert consumes nonce and cannot be repeated; unrelated orphan refuses", async () => {
  const f = await activationFixture();
  f.state.receiptStatus = "reverted";
  const first = await f.execute();
  assert.equal(first.state, "reverted");
  const second = await f.execute();
  assert.equal(second.state, "reverted");
  assert.equal(f.state.sends.length, 1);
  const g = await activationFixture();
  mkdirSync(g.stateDirectory, { mode: 0o700 });
  const path = join(g.stateDirectory, "f".repeat(64) + ".sqlite");
  const orphan = new ActivationJournal(path);
  orphan.close();
  await assert.rejects(g.execute(), /namespace_orphan/);
  assert.equal(g.state.keys + g.state.adds, 0);
});

test("prepared catalog cannot hide a missing native journal and signed raw tampering refuses before secrets", async () => {
  const f = await activationFixture();
  f.state.landed = false;
  await f.execute();
  const path = join(f.stateDirectory, hashJson(f.profile).slice(2) + ".sqlite");
  renameSync(path, join(f.directory, "preserved-raw.sqlite"));
  const before = f.state.secrets;
  await assert.rejects(f.execute(), /ENOENT|prepared_journal/);
  assert.equal(f.state.secrets, before);
  assert.equal(f.state.keys, 1);
  const g = await activationFixture();
  g.state.landed = false;
  await g.execute();
  const j = new ActivationJournal(
    join(g.stateDirectory, hashJson(g.profile).slice(2) + ".sqlite"),
  );
  const row = j.get<any>("deployment");
  j.set("deployment", { ...row, gasPriceWei: "3" });
  j.close();
  await assert.rejects(g.execute(), /journal_transaction_changed/);
  assert.equal(g.state.keys, 1);
  assert.equal(g.state.sends.length, 1);
});
test("readiness changing during managed pin cannot reach signing or native allocation", async () => {
  const f = await activationFixture();
  f.ports.loadPinSecret = async () => {
    f.state.secrets++;
    writeFileSync(f.readyPath, "changed after admission");
    return "synthetic-token";
  };
  await assert.rejects(f.execute(), /readiness_changed/);
  assert.equal(f.state.keys, 0);
  assert.equal(f.state.sends.length, 0);
  const catalog = new ActivationJournal(
    join(f.stateDirectory, "dispatch-custody.sqlite"),
  );
  assert.equal(catalog.get("controller:profiles"), undefined);
  catalog.close();
});
