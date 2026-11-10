import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeFunctionData } from "viem";
import { canonical } from "../packages/community/common.ts";
import { configureAbi } from "../harness/megaeth/curated-configuration-plan.ts";
import { studyActivationPlan } from "../harness/megaeth/study-activation-plan.ts";
import { studyActivationSourceHash } from "../harness/megaeth/study-activation-source.ts";
import { activationFixture } from "./study-activation-fixture.ts";
import { sha256File } from "../harness/megaeth/controller-inventory.ts";

test("V4 activation plans only revision five to six and preserves owner publishing and every other setting", async () => {
  const f = await activationFixture(4);
  const plan = await studyActivationPlan(
    f.profile,
    f.artifact,
    studyActivationSourceHash(),
  );
  assert.equal(plan.before.configurationRevision, 5);
  assert.equal(plan.manifest.configurationRevision, 6);
  assert.equal(
    canonical({
      ...plan.manifest,
      configurationRevision: 5,
      learningRecords: plan.before.learningRecords,
    }),
    canonical(plan.before),
  );
  const call = decodeFunctionData({
    abi: configureAbi,
    data: plan.operation.data,
  });
  assert.equal(call.args![1], 5n);
  f.ports.client = () => {
    throw Error("default must stay offline");
  };
  const result = await f.run();
  assert.equal(result.mode, "plan");
  assert.equal(f.state.keys + f.state.secrets + f.state.sends.length, 0);
});

test("V4 activation uses the retained controller journal, one pin and one configure; repeat observes without signing", async () => {
  const f = await activationFixture(4);
  assert.equal((await f.run(["--observe"])).mode, "observe");
  assert.equal(f.state.keys + f.state.secrets + f.state.adds, 0);
  assert.equal((await f.execute()).state, "confirmed");
  assert.equal((await f.execute()).complete, true);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.keys, 1);
  assert.equal(f.state.adds, 1);
});

test("V4 activation refuses origin, predecessor, old artifact and missing V4 readiness before secret or signer", async () => {
  for (const field of [
    "origin",
    "predecessor",
    "artifact",
    "readiness",
  ] as const) {
    const f = await activationFixture(4);
    if (field === "origin") f.profile.communityOrigin = "https://wrong.invalid";
    if (field === "predecessor") {
      f.profile.predecessor!.codeHash = `0x${"a".repeat(64)}`;
      f.refresh();
    }
    if (field === "artifact")
      f.ports.artifact = (await activationFixture()).artifact;
    if (field === "readiness") {
      const report = JSON.parse(readFileSync(f.readyPath, "utf8"));
      delete report.checks.policyWordingApproved;
      writeFileSync(f.readyPath, JSON.stringify(report), { mode: 0o600 });
      f.profile.readiness.sha256 = sha256File(f.readyPath);
    }
    writeFileSync(f.profilePath, JSON.stringify(f.profile));
    await assert.rejects(f.execute());
    assert.equal(f.state.keys + f.state.secrets + f.state.sends.length, 0);
  }
});
