import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./study-operator-fixture.ts";
import {
  operatorProfile,
  operatorPlan,
} from "../harness/study-operator-profile.ts";
import { operatorEnvironment } from "../harness/study-operator-live.ts";
import { assertOperatorChildEnvironment } from "../harness/study-operator-execution.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";

test("the retained operator passes exactly the reviewed V4 selection to Alchemy; ambient V4 is refused", () => {
  const p = fixture();
  p.learningV4 = {
    schema: "pirate.learning-v4-release-selection/1",
    chainId: 6343,
    contract: "0x4444444444444444444444444444444444444444",
    codeHash: `0x${"4".repeat(64)}`,
    controller: p.selection.controller,
    publicationPolicy: learningV4PublicityPolicy,
    policyVersion: 4,
    communityOrigin: firstSong.origin,
  };
  const secrets = {
    password: "fixture-password",
    speech: "fixture-speech",
    operatorKey: `0x${"11".repeat(32)}` as const,
  };
  const env = operatorEnvironment(
    p,
    { PATH: "/fixture", HOME: "/fixture" },
    "fixture-token",
    secrets,
  );
  assert.equal(env.LEARNING_RESULTS_V4_CONTRACT, p.learningV4.contract);
  assert.equal(operatorPlan(p).changes.resultsV4, p.learningV4.contract);
  assert.throws(() =>
    assertOperatorChildEnvironment(
      p,
      { ...env, LEARNING_RESULTS_V4_CONTRACT: p.selection.resultsV2.contract },
      secrets.password,
    ),
  );
  const historical = structuredClone(p);
  delete historical.learningV4;
  assert.throws(() =>
    assertOperatorChildEnvironment(historical, env, secrets.password),
  );
  for (const field of ["contract", "controller", "origin"] as const) {
    const changed = structuredClone(p);
    if (field === "contract")
      changed.learningV4!.contract = p.selection.resultsV3.contract;
    if (field === "controller")
      changed.learningV4!.controller = p.learningV4.contract;
    if (field === "origin")
      changed.learningV4!.communityOrigin = "https://wrong.invalid";
    assert.throws(() => operatorProfile(changed));
  }
});
