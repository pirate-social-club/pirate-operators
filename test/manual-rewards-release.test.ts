import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hashJson } from "../packages/community/common.ts";
import { learningCommunityProfile } from "../harness/learning-community-profile.ts";
import { studyReleaseSelection } from "../harness/study-release-profile.ts";
import { selectionFixture } from "./fixtures/study-release.ts";
import { rewardHash, rewardTestProfile } from "./manual-rewards-fixture.ts";
import {
  assertRewardsApplicationUpgrade,
  rewardsReleaseSelection,
} from "../harness/rewards-release-profile.ts";
import { assertStudyApplicationUpgrade } from "../harness/study-application-upgrade.ts";
import { applicationRewardsBindings } from "../apps/community-wizard/infra/rewards-bindings.ts";

test("rewards successor preserves the accepted Study deployment and appends only its own migration", async () => {
  const previous = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.application-plan-v15.json",
      "utf8",
    ),
  ).profile;
  previous.learning = await learningCommunityProfile(
    studyReleaseSelection(selectionFixture()),
  );
  previous.acceptance = previous.learning.acceptance;
  previous.migrations = [
    ...previous.migrations,
    "0009_study.sql",
    "0010_study_retention.sql",
  ];
  const source = {
    schema: "pirate.reward-result-source/1",
    contract: previous.learning.studyContract,
    codeHash: previous.learning.studyCodeHash,
    fromBlock: "1",
    grader: rewardTestProfile.operatorWallet,
    karaokePolicy: rewardHash(910),
    studyPolicy: rewardHash(911),
  };
  const rewards = rewardsReleaseSelection({
    schema: "pirate.rewards-release-selection/1",
    profile: {
      ...rewardTestProfile,
      mode: "live-testnet",
      operatorWallet: rewardTestProfile.payoutWallet,
      resultSourceHash: hashJson(source),
    },
    source,
  });
  const next = {
    ...structuredClone(previous),
    rewards,
    migrations: [...previous.migrations, "0011_manual_rewards.sql"],
  };
  assert.doesNotThrow(() => assertRewardsApplicationUpgrade(previous, next));
  assert.doesNotThrow(() =>
    assertRewardsApplicationUpgrade(next, structuredClone(next)),
  );
  assert.throws(
    () => assertStudyApplicationUpgrade(previous, next),
    /study_upgrade_/,
  );
  for (const mutate of [
    (p: any) => (p.resources = []),
    (p: any) => p.bounds.providerRequests++,
    (p: any) => (p.learning.studyContract = rewardTestProfile.token),
    (p: any) => p.migrations.push("0012_unknown.sql"),
    (p: any) => delete p.rewards,
  ]) {
    const altered = structuredClone(next);
    mutate(altered);
    assert.throws(() => assertRewardsApplicationUpgrade(previous, altered));
  }
  const rehearsal = structuredClone(next);
  rehearsal.rewards.profile.rehearsal = {
    schema: "pirate.reward-rehearsal/1",
    offerId: "rehearsal_001",
    prizeUsdcAtomic: "30000",
  };
  const declared = rewardsReleaseSelection(rehearsal.rewards);
  assert.equal(declared.profile.rehearsal?.prizeUsdcAtomic, "30000");
  assert.doesNotThrow(() =>
    assertRewardsApplicationUpgrade(previous, rehearsal),
  );
  assert.doesNotThrow(() =>
    assertRewardsApplicationUpgrade(rehearsal, structuredClone(rehearsal)),
  );
  const changedPrize = structuredClone(rehearsal);
  changedPrize.rewards.profile.rehearsal!.prizeUsdcAtomic = "40000";
  assert.throws(
    () => assertRewardsApplicationUpgrade(rehearsal, changedPrize),
    /reward_release_program_changed/,
  );
  assert.throws(
    () => assertRewardsApplicationUpgrade(rehearsal, next),
    /reward_release_program_changed/,
  );
  // One rehearsal rollover: the current rehearsal is retired with its terms and
  // a new one is named. Nothing else may change, and it never runs backwards.
  const rollover = structuredClone(rehearsal);
  rollover.rewards.profile.rehearsalHistory = [
    rehearsal.rewards.profile.rehearsal!,
  ];
  rollover.rewards.profile.rehearsal = {
    schema: "pirate.reward-rehearsal/1",
    offerId: "rehearsal_002",
    prizeUsdcAtomic: "30000",
  };
  assert.doesNotThrow(() =>
    assertRewardsApplicationUpgrade(rehearsal, rollover),
  );
  const second = structuredClone(rollover);
  second.rewards.profile.rehearsalHistory!.push(
    rollover.rewards.profile.rehearsal!,
  );
  second.rewards.profile.rehearsal!.offerId = "rehearsal_003";
  assert.doesNotThrow(() => assertRewardsApplicationUpgrade(rollover, second));
  for (const [from, to] of [
    [rollover, rehearsal],
    [rehearsal, second],
    [next, rollover],
  ])
    assert.throws(
      () => assertRewardsApplicationUpgrade(from, to),
      /reward_release_program_changed/,
    );
  for (const mutate of [
    (p: any) =>
      (p.rewards.profile.rehearsalHistory[0].prizeUsdcAtomic = "40000"),
    (p: any) => (p.rewards.profile.veryAppId = "another_program"),
    (p: any) => (p.rewards.source.codeHash = rewardTestProfile.programId),
  ]) {
    const altered = structuredClone(rollover);
    mutate(altered);
    assert.throws(() => assertRewardsApplicationUpgrade(rehearsal, altered));
  }
  const changed = structuredClone(next);
  changed.rewards.profile.veryAppId = "another_program";
  assert.throws(
    () => assertRewardsApplicationUpgrade(next, changed),
    /reward_release_program_changed/,
  );
  const env = {
    REWARDS_PROFILE_JSON: JSON.stringify(rewards.profile),
    REWARDS_RESULT_SOURCE_JSON: JSON.stringify(rewards.source),
  };
  assert.deepEqual(applicationRewardsBindings({}), {});
  assert.deepEqual(applicationRewardsBindings(env), env);
  assert.throws(
    () =>
      applicationRewardsBindings({
        REWARDS_PROFILE_JSON: env.REWARDS_PROFILE_JSON,
      }),
    /reward_release_binding_missing/,
  );
  assert.throws(
    () =>
      applicationRewardsBindings({
        ...env,
        REWARDS_PROFILE_JSON: JSON.stringify({
          ...rewards.profile,
          mode: "simulated",
        }),
      }),
    /reward_release_binding_invalid/,
  );
});
