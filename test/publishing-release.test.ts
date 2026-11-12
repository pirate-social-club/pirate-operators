// Owner publishing deployment profiles and successor gates. Public data only;
// nothing here deploys, binds credentials or publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import { communityMigrations } from "../harness/package-migrations.ts";
import { reviewedPredecessor } from "../harness/reviewed-update.ts";
import { durableJson, digest } from "../harness/private-json.ts";
import {
  ownerMigrationRecords,
  applyOwnerMigrationRecords,
  ownerMigrationLedger,
  migrationSha,
} from "./owner-publishing-migration-fixture.ts";
import { privateKeyToAccount } from "viem/accounts";
import { hashJson } from "../packages/community/common.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../packages/community/owner-policy.ts";
import {
  ownerGrantDigest,
  validateOwnerGrant,
  reserveOwnerBudget,
} from "../packages/release/owner-grant.ts";
import { learningCommunityProfile } from "../harness/learning-community-profile.ts";
import { studyReleaseSelection } from "../harness/study-release-profile.ts";
import { selectionFixture } from "./fixtures/study-release.ts";
import { rewardHash, rewardTestProfile } from "./manual-rewards-fixture.ts";
import {
  assertRewardsApplicationUpgrade,
  assertRewardsFollowLearningV4,
  rewardsReleaseSelection,
} from "../harness/rewards-release-profile.ts";
import {
  assertPublishingApplicationUpgrade,
  assertPublishingManagedUpgrade,
  communityPublishingProfile,
  managedPublishingProfile,
  publishingReleaseSelection,
} from "../harness/publishing-release-profile.ts";
import {
  assertLearningV4ApplicationUpgrade,
  learningV4ReleaseSelection,
} from "../harness/learning-v4-release-profile.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { applicationPublishingBindings } from "../apps/community-wizard/infra/publishing-bindings.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { managedUpdate } from "../harness/managed-update-pin.ts";
import { publishedStateRepairPath } from "../harness/published-state.ts";

// Public local fixture key. Never fund or deploy it.
const controller = privateKeyToAccount(`0x${"61".repeat(32)}`),
  owner = "0x" + "ab".repeat(20),
  policy = {
    version: UNREGISTERED_OWNER_POLICY_VERSION,
    sha256: UNREGISTERED_OWNER_POLICY_HASH,
  };

async function selection(
  window = { validFrom: 2000000000, expiresAt: 2000086400 },
  overrides: Record<string, unknown> = {},
) {
  const draft = {
    schema: "pirate.owner-publishing-grant/1" as const,
    sha256: "0x" + "00".repeat(32),
    communityId: firstSong.directoryProfile.communityId,
    communityOrigin: firstSong.origin,
    ownerWallet: owner,
    policy,
    destination: {
      chainId: 6343,
      postsContract: firstSong.posts.address,
      publisher: "0x14b90a55657d9695a727254eaec5e0e32d20d602",
    },
    ...window,
    limits: {
      songs: 3,
      pinAdds: 15,
      pinBytes: "67108864",
      recognitionRequests: 12,
      postFeeWei: "90000000000000",
    },
    ...overrides,
  };
  const ownerGrant = validateOwnerGrant({
    ...draft,
    sha256: ownerGrantDigest(draft),
  });
  const authorization = {
    schema: "pirate.owner-publishing-authorization/1" as const,
    communityId: ownerGrant.communityId,
    ownerWallet: ownerGrant.ownerWallet,
    policy,
    ...window,
  };
  return publishingReleaseSelection({
    schema: "pirate.owner-publishing-release-selection/1",
    ownerGrant,
    ownerAuthorization: {
      authorization,
      signature: await controller.signMessage({
        message: { raw: hashJson(authorization) as `0x${string}` },
      }),
    },
  });
}

/** The deployed Study and rewards application profile, as the rewards test builds it. */
async function rewardsApplication() {
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
    "0011_manual_rewards.sql",
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
  previous.rewards = rewardsReleaseSelection({
    schema: "pirate.rewards-release-selection/1",
    profile: {
      ...rewardTestProfile,
      mode: "live-testnet",
      operatorWallet: rewardTestProfile.payoutWallet,
      resultSourceHash: hashJson(source),
    },
    source,
  });
  return previous as Record<string, any>;
}

test("the publishing selection binds the grant and authorization to one owner scope and is canonical", async () => {
  const valid = await selection();
  assert.equal(valid.ownerGrant.ownerWallet, owner);
  const other = structuredClone(valid) as any;
  other.ownerAuthorization.authorization.ownerWallet = "0x" + "cd".repeat(20);
  assert.throws(
    () => publishingReleaseSelection(other),
    /owner_publishing_release_scope_mismatch/,
  );
  const extra = { ...structuredClone(valid), activate: true };
  assert.throws(() => publishingReleaseSelection(extra), /invalid_fields/);
  const upper = structuredClone(valid) as any;
  upper.ownerGrant.ownerWallet = owner.toUpperCase().replace("0X", "0x");
  assert.throws(() => publishingReleaseSelection(upper));
});

test("the community publishing successor appends only 0012, adds the owner selection and drops registration, keeping Study and rewards", async () => {
  const previous = await rewardsApplication(),
    chosen = await selection();
  const next = communityPublishingProfile(
    {
      ...structuredClone(previous),
      migrations: [...previous.migrations, "0012_owner_budget_windows.sql"],
      managedProfileHash: "0x" + "5".repeat(64),
    },
    chosen,
  ) as Record<string, any>;
  assert.equal("releaseGrant" in next, false);
  assert.equal("creatorProfileHash" in next, false);
  assert.equal("registrationTransactions" in next.bounds, false);
  assert.equal("maximumRegistrationFee" in next.bounds, false);
  assert.equal(next.bounds.publicationTransactions, 1);
  assert.doesNotThrow(() => assertPublishingApplicationUpgrade(previous, next));
  // The rewards gate alone still refuses 0012, which is why this gate exists.
  assert.throws(() => assertRewardsApplicationUpgrade(previous, next));
  for (const [name, mutate] of [
    ["resources", (p: any) => (p.resources = [])],
    ["provider bound", (p: any) => p.bounds.providerRequests++],
    [
      "registration bound kept",
      (p: any) => (p.bounds.registrationTransactions = 1),
    ],
    [
      "release grant kept",
      (p: any) => (p.releaseGrant = previous.releaseGrant),
    ],
    [
      "creator kept",
      (p: any) => (p.creatorProfileHash = previous.creatorProfileHash),
    ],
    ["Study", (p: any) => (p.learning.studyContract = rewardTestProfile.token)],
    ["rewards", (p: any) => (p.rewards.profile.decimals = 18)],
    ["no rewards", (p: any) => delete p.rewards],
    ["extra migration", (p: any) => p.migrations.push("0013_unknown.sql")],
    ["missing 0012", (p: any) => p.migrations.pop()],
    ["no selection", (p: any) => delete p.ownerPublishing],
    ["publisher", (p: any) => (p.publisher = "0x" + "77".repeat(20))],
  ] as const) {
    const altered = structuredClone(next);
    mutate(altered);
    assert.throws(
      () => assertPublishingApplicationUpgrade(previous, altered),
      Error,
      name,
    );
  }
  // A Study-only predecessor (no rewards) cannot jump to publishing.
  const studyOnly = structuredClone(previous);
  delete studyOnly.rewards;
  studyOnly.migrations.pop();
  assert.throws(
    () => assertPublishingApplicationUpgrade(studyOnly, next),
    /owner_publishing_rewards_required/,
  );
  // A later publishing profile may carry a replacement grant for the same
  // owner scope, with no migration change.
  const replaced = communityPublishingProfile(
    structuredClone(next),
    await selection({ validFrom: 2000086400, expiresAt: 2000172800 }),
  );
  assert.doesNotThrow(() => assertPublishingApplicationUpgrade(next, replaced));
  // Another owner wallet or destination is not a replacement.
  for (const overrides of [
    { ownerWallet: "0x" + "cd".repeat(20) },
    {
      destination: {
        chainId: 6343,
        postsContract: firstSong.posts.address,
        publisher: "0x" + "77".repeat(20),
      },
    },
  ]) {
    const changed = communityPublishingProfile(
      structuredClone(next),
      await selection(undefined, overrides),
    );
    assert.throws(
      () => assertPublishingApplicationUpgrade(next, changed),
      /owner_publishing_scope_changed/,
    );
  }
});

test("the V4 application successor appends only 0013 after the deployed 0012 and adds the V4 selection", async () => {
  const rewards = await rewardsApplication();
  // The deployed publishing application, as the publishing gate admits it.
  const previous = communityPublishingProfile(
    {
      ...structuredClone(rewards),
      migrations: [...rewards.migrations, "0012_owner_budget_windows.sql"],
      managedProfileHash: "0x" + "5".repeat(64),
    },
    await selection(),
  ) as Record<string, any>;
  assert.doesNotThrow(() => assertPublishingApplicationUpgrade(rewards, previous));
  const v4 = learningV4ReleaseSelection({
    schema: "pirate.learning-v4-release-selection/1",
    chainId: 6343,
    contract: "0x" + "c4".repeat(20),
    codeHash: "0x" + "4c".repeat(32),
    controller: "0x" + "c7".repeat(20),
    publicationPolicy: learningV4PublicityPolicy,
    policyVersion: 4,
    communityOrigin: previous.origin,
  });
  const next = {
    ...structuredClone(previous),
    migrations: [...previous.migrations, "0013_learning_authorization.sql"],
    learningV4: v4,
  } as Record<string, any>;
  assert.doesNotThrow(() => assertLearningV4ApplicationUpgrade(previous, next));
  // The publishing gate alone refuses 0013, which is why this gate exists.
  assert.throws(
    () => assertPublishingApplicationUpgrade(previous, next),
    /owner_publishing_migrations_changed/,
  );
  // A later V4 profile with the same selection and migrations is admitted.
  assert.doesNotThrow(() =>
    assertLearningV4ApplicationUpgrade(next, structuredClone(next)),
  );
  for (const [name, mutate, code] of [
    ["no selection", (p: any) => delete p.learningV4, /invalid/],
    [
      "another policy",
      (p: any) => (p.learningV4.publicationPolicy = "0x" + "11".repeat(32)),
      /learning_v4_release_selection_invalid/,
    ],
    [
      "uppercase contract",
      (p: any) => (p.learningV4.contract = "0x" + "C4".repeat(20)),
      /learning_v4_release_selection_invalid/,
    ],
    [
      "another community origin",
      (p: any) => (p.learningV4.communityOrigin = "https://phish.example"),
      /learning_v4_origin_changed/,
    ],
    [
      "non-canonical community origin",
      (p: any) => (p.learningV4.communityOrigin = p.origin + "/"),
      /learning_v4_release_selection_invalid/,
    ],
    [
      "no community origin",
      (p: any) => delete p.learningV4.communityOrigin,
      /invalid/,
    ],
    [
      "V3 contract reused",
      (p: any) => (p.learningV4.contract = p.learning.studyContract),
      /learning_v4_contract_reused/,
    ],
    [
      "missing 0013",
      (p: any) => p.migrations.pop(),
      /learning_v4_migrations_changed/,
    ],
    [
      "0013 before 0012",
      (p: any) =>
        (p.migrations = [
          ...previous.migrations.slice(0, -1),
          "0013_learning_authorization.sql",
          "0012_owner_budget_windows.sql",
        ]),
      /learning_v4_migrations_changed/,
    ],
    [
      "extra migration",
      (p: any) => p.migrations.push("0014_unknown.sql"),
      /learning_v4_migrations_changed/,
    ],
    [
      "other migration changed",
      (p: any) => (p.migrations[0] = "0001_other.sql"),
      /learning_v4_migrations_changed/,
    ],
    [
      "duplicate migration",
      (p: any) => p.migrations.push("0013_learning_authorization.sql"),
      /learning_v4_migrations_invalid/,
    ],
    [
      "no owner publishing",
      (p: any) => delete p.ownerPublishing,
      /learning_v4_publishing_required/,
    ],
    [
      "rewards",
      (p: any) => (p.rewards.profile.decimals = 18),
      /reward_release_|invalid/,
    ],
    [
      "Study",
      (p: any) => (p.learning.studyCodeHash = "0x" + "77".repeat(32)),
      /reward_release_study_source_changed|study_upgrade_/,
    ],
    [
      "publisher",
      (p: any) => (p.publisher = "0x" + "77".repeat(20)),
      /study_upgrade_unrelated_intent_changed/,
    ],
  ] as const) {
    const altered = structuredClone(next);
    mutate(altered);
    assert.throws(
      () => assertLearningV4ApplicationUpgrade(previous, altered),
      code,
      name,
    );
  }
  // A predecessor without owner publishing cannot jump to V4.
  const rewardsNext = {
    ...structuredClone(rewards),
    migrations: [...rewards.migrations, "0013_learning_authorization.sql"],
    learningV4: v4,
  };
  assert.throws(
    () => assertLearningV4ApplicationUpgrade(rewards, rewardsNext),
    /learning_v4_publishing_required/,
  );
  // A V4 predecessor keeps its selection and migrations.
  const changed = structuredClone(next);
  changed.learningV4.codeHash = "0x" + "5c".repeat(32);
  assert.throws(
    () => assertLearningV4ApplicationUpgrade(next, changed),
    /learning_v4_selection_changed/,
  );
  const grown = structuredClone(next);
  grown.migrations.push("0014_unknown.sql");
  assert.throws(
    () => assertLearningV4ApplicationUpgrade(next, grown),
    /learning_v4_migrations_changed/,
  );
});

test("the managed publishing successor appends only 0004, swaps the grant and drops the registration key and bounds", async () => {
  // The registered predecessor the publishing successor replaced (history).
  const previous = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.moderation-plan-v8.json",
      "utf8",
    ),
  ).profile as Record<string, any>;
  const next = managedPublishingProfile(
    {
      ...structuredClone(previous),
      migrations: [...previous.migrations, "0004_owner_budget_windows.sql"],
    },
    await selection(),
  ) as Record<string, any>;
  assert.equal("releaseGrant" in next, false);
  assert.equal("registrationCredential" in next, false);
  assert.equal(
    next.secretNames.includes("REGISTRATION_OPERATOR_PRIVATE_KEY"),
    false,
  );
  assert.equal(
    next.signerSource.sha256,
    previous.registrationCredential.sha256,
  );
  assert.equal("targetChain" in next.signerSource, false);
  assert.doesNotThrow(() => assertPublishingManagedUpgrade(previous, next));
  // Only the one reviewed state repair may accompany the publishing successor.
  const repair = JSON.parse(await readFile(publishedStateRepairPath, "utf8"));
  assert.doesNotThrow(() =>
    assertPublishingManagedUpgrade(previous, {
      ...next,
      curatedStateRepair: repair,
    }),
  );
  const tamperedRepair = structuredClone(repair);
  tamperedRepair.summaries.spending_budgets.to.count = 7;
  assert.throws(
    () =>
      assertPublishingManagedUpgrade(previous, {
        ...next,
        curatedStateRepair: tamperedRepair,
      }),
    /owner_publishing_state_repair_changed/,
  );
  for (const [name, mutate] of [
    ["pairings", (p: any) => (p.pairings[0].requestCap = 99)],
    ["service cap", (p: any) => p.serviceRequestCap++],
    ["signer", (p: any) => (p.moderationSigner = "0x" + "77".repeat(20))],
    [
      "key kept",
      (p: any) => p.secretNames.push("REGISTRATION_OPERATOR_PRIVATE_KEY"),
    ],
    ["bound kept", (p: any) => (p.bounds.registrationTransactions = 1)],
    [
      "signer source",
      (p: any) => (p.signerSource.sha256 = "0x" + "0".repeat(64)),
    ],
    ["extra migration", (p: any) => p.migrations.push("0005_unknown.sql")],
    ["grant kept", (p: any) => (p.releaseGrant = previous.releaseGrant)],
  ] as const) {
    const altered = structuredClone(next);
    mutate(altered);
    assert.throws(
      () => assertPublishingManagedUpgrade(previous, altered),
      Error,
      name,
    );
  }
});

test("the managed update names the deployed owner publishing predecessor and its retained evidence", async () => {
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const plan = await read(managedUpdate.previousPlanPath),
    evidence = (await read(managedUpdate.previousEvidencePath)).services
      .managed,
    startup = (await read(managedUpdate.startupEvidencePath)).resourceIds;
  assert.equal(plan.profileHash, managedUpdate.previousProfileHash);
  assert.equal(hashJson(plan.profile), plan.profileHash);
  // The committed managed plan is either still this predecessor, byte for
  // byte, or the deployed publishing successor that its gate accepts.
  const current = await readFile(
    "docs/deployments/first-song-managed-20261105.moderation-plan.json",
    "utf8",
  );
  if (current !== (await readFile(managedUpdate.previousPlanPath, "utf8"))) {
    const successor = JSON.parse(current);
    assert.equal(hashJson(successor.profile), successor.profileHash);
    assert.doesNotThrow(() =>
      assertPublishingManagedUpgrade(plan.profile, successor.profile),
    );
  }
  assert.equal(evidence.profileHash, plan.profileHash);
  assert.equal(evidence.resultSha256, managedUpdate.expectedResultSha256);
  const rollout = await read(managedUpdate.previousEvidencePath);
  assert.equal(rollout.plan, managedUpdate.previousPlanPath);
  assert.equal(rollout.readback.workerModuleSha256, plan.profile.bundleSha256);
  // The deployed predecessor is itself owner publishing, so the next managed
  // successor keeps its owner scope and migrations and changes source only.
  assert.ok(plan.profile.ownerGrant);
  const next = {
    ...structuredClone(plan.profile),
    update: managedUpdate,
    sourceHashes: { ...plan.profile.sourceHashes, "harness/x.ts": "0x" + "1".repeat(64) },
    bundleSha256: "0x" + "2".repeat(64),
  };
  assert.doesNotThrow(() => assertPublishingManagedUpgrade(plan.profile, next));
  // A validly bound grant for another owner wallet is not a replacement.
  const registered = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.moderation-plan-v8.json",
      "utf8",
    ),
  ).profile;
  const otherOwner = {
    ...next,
    ownerGrant: managedPublishingProfile(
      registered,
      await selection(undefined, { ownerWallet: "0x" + "cd".repeat(20) }),
    ).ownerGrant,
  };
  assert.throws(
    () => assertPublishingManagedUpgrade(plan.profile, otherOwner),
    /owner_publishing_scope_changed/,
  );
  assert.throws(
    () =>
      assertPublishingManagedUpgrade(plan.profile, {
        ...next,
        migrations: [...next.migrations, "0005_unknown.sql"],
      }),
    /owner_publishing_migrations_changed/,
  );
  assert.deepEqual(
    evidence.resources.map((r: { id: string }) => r.id),
    [
      startup.worker.id,
      startup.database.uuid,
      startup.media.name,
      startup.queue.queue_id,
    ],
  );
});

test("infrastructure binds the owner values or the registered values, never both", async () => {
  const chosen = await selection(),
    owner = {
      OWNER_GRANT_JSON: JSON.stringify(chosen.ownerGrant),
      OWNER_AUTHORIZATION_JSON: JSON.stringify(chosen.ownerAuthorization),
    },
    registered = {
      CREATOR_PROFILE_HASH: "0x" + "b".repeat(64),
      RELEASE_GRANT_HASH: "0x" + "c".repeat(64),
      REGISTRATION_OPERATOR_ADDRESS: "0x" + "d".repeat(40),
      POSTING_EXPIRES_AT: "2000000000",
    };
  assert.deepEqual(applicationPublishingBindings(owner), owner);
  assert.deepEqual(applicationPublishingBindings(registered), registered);
  assert.throws(
    () => applicationPublishingBindings({ ...owner, ...registered }),
    /owner_publishing_binding_mixed/,
  );
  assert.throws(
    () =>
      applicationPublishingBindings({
        OWNER_GRANT_JSON: owner.OWNER_GRANT_JSON,
      }),
    /owner_publishing_binding_missing/,
  );
  const wrong = JSON.parse(owner.OWNER_AUTHORIZATION_JSON);
  wrong.authorization.ownerWallet = "0x" + "cd".repeat(20);
  assert.throws(
    () =>
      applicationPublishingBindings({
        ...owner,
        OWNER_AUTHORIZATION_JSON: JSON.stringify(wrong),
      }),
    /owner_publishing_binding_invalid/,
  );
});

// Current selector -> actual reviewed-update router -> pinned Alchemy/D1.
// The legacy profiles below are existing signed fixture scope, not new admitted
// deployment baselines. Nothing invokes a build, provider or deployment runner.
const migrationDirectory = "apps/community-wizard/infra/migrations";
const wizardMigrationRequire = createRequire(
  new URL("../apps/community-wizard/package.json", import.meta.url),
);
const sqlMigrationRequire = createRequire(
  wizardMigrationRequire.resolve("@alchemy.run/cloudflare/D1/Database"),
);
const migrationRegistry = await import(
  pathToFileURL(sqlMigrationRequire.resolve("@alchemy.run/sql/Migrations")).href
);
async function selectedUpgradeProfiles() {
  const names = await readdir(migrationDirectory);
  const legacy = await rewardsApplication();
  const chosen = await selection();
  const currentBase: Record<string, any> = {
    ...structuredClone(legacy),
    migrations: communityMigrations(names, {
      rewards: true,
      ownerPublishing: false,
      v4: false,
    }),
  };
  const ownerProfile = (previous: Record<string, any>, migrations: string[]) =>
    communityPublishingProfile(
      {
        ...structuredClone(previous),
        migrations,
        managedProfileHash: "0x" + "5".repeat(64),
      },
      chosen,
    ) as Record<string, any>;
  const legacyOwner = ownerProfile(legacy, [
    ...legacy.migrations,
    "0012_owner_budget_windows.sql",
  ]);
  const owner = ownerProfile(
    currentBase,
    communityMigrations(names, {
      rewards: true,
      ownerPublishing: true,
      v4: false,
    }),
  );
  const v4 = learningV4ReleaseSelection({
    schema: "pirate.learning-v4-release-selection/1",
    chainId: 6343,
    contract: "0x" + "c4".repeat(20),
    codeHash: "0x" + "4c".repeat(32),
    controller: "0x" + "c7".repeat(20),
    publicationPolicy: learningV4PublicityPolicy,
    policyVersion: 4,
    communityOrigin: owner.origin,
  });
  const withV4 = (
    previous: Record<string, any>,
    migrations: string[],
  ): Record<string, any> => ({
    ...structuredClone(previous),
    migrations,
    learningV4: v4,
    rewards: rewardsReleaseSelection({
      ...previous.rewards,
      successors: [
        {
          ...previous.rewards.source,
          schema: "pirate.reward-result-source/2",
          version: 4,
          contract: v4.contract,
          codeHash: v4.codeHash,
          fromBlock: "2",
        },
      ],
    }),
  });
  const legacyV4 = withV4(legacyOwner, [
    ...legacyOwner.migrations,
    "0013_learning_authorization.sql",
  ]);
  const currentV4 = withV4(
    owner,
    communityMigrations(names, {
      rewards: true,
      ownerPublishing: true,
      v4: true,
    }),
  );
  const retained: Record<string, any>[] = [
    { rewardClosure: true },
    { media: true },
    { rewardClosure: true, media: true, dance: true },
  ].map((optional) => ({
    ...structuredClone(currentV4),
    migrations: communityMigrations(names, {
      rewards: true,
      ownerPublishing: true,
      v4: true,
      ...optional,
    }),
  }));
  return {
    legacy,
    currentBase,
    legacyOwner,
    owner,
    legacyV4,
    currentV4,
    retained,
  };
}
async function reviewedSchemaPair(
  previous: Record<string, any>,
  next: Record<string, any>,
) {
  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(
    join(process.cwd(), ".local/owner-schema-upgrade-"),
  );
  const previousProfileHash = hashJson(previous);
  const previousPlanPath = join(directory, "previous-plan.json");
  await durableJson(previousPlanPath, {
    profile: previous,
    profileHash: previousProfileHash,
  });
  await durableJson(join(directory, "execution.json"), {
    profileHash: previousProfileHash,
  });
  await durableJson(join(directory, "deployment-result.json"), {
    profileHash: previousProfileHash,
    fixture: "retained predecessor receipt",
  });
  const profile = {
    ...structuredClone(next),
    reviewedUpdate: {
      previousPlanPath,
      previousProfileHash,
      expectedExecutionSha256: digest(
        await readFile(join(directory, "execution.json")),
      ),
      expectedResultSha256: digest(
        await readFile(join(directory, "deployment-result.json")),
      ),
    },
  };
  return {
    directory,
    packaged: { profile, profileHash: hashJson(profile) },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
async function assertReviewedSchemaPair(
  previous: Record<string, any>,
  next: Record<string, any>,
) {
  assertRewardsFollowLearningV4(next.rewards, next.learningV4);
  const f = await reviewedSchemaPair(previous, next);
  try {
    assert.equal(
      (await reviewedPredecessor(f.directory, f.packaged)).adopted,
      false,
    );
  } finally {
    await f.dispose();
  }
}

test("selector-produced current publishing and V4 histories pass the actual reviewed-update chain with predecessor pins intact", async () => {
  const p = await selectedUpgradeProfiles();
  for (const [previous, next] of [
    [p.legacy, p.owner],
    [p.currentBase, p.owner],
    [p.owner, structuredClone(p.owner)],
    [p.legacyOwner, p.currentV4],
    [p.owner, p.currentV4],
    [p.legacyV4, p.currentV4],
    [p.currentV4, structuredClone(p.currentV4)],
    ...p.retained.map((profile) => [profile, structuredClone(profile)]),
  ])
    await assertReviewedSchemaPair(previous!, next!);
  for (const receipt of [
    "execution.json",
    "deployment-result.json",
    "previous-plan.json",
  ]) {
    const f = await reviewedSchemaPair(p.owner, p.currentV4);
    try {
      await writeFile(
        join(f.directory, receipt),
        JSON.stringify({ profileHash: hashJson({ changed: receipt }) }),
        { mode: 0o600 },
      );
      await assert.rejects(
        reviewedPredecessor(f.directory, f.packaged),
        /reviewed_update_(plan|execution|result)_changed/,
      );
    } finally {
      await f.dispose();
    }
  }
});

test("current selected schemas refuse unknown or removed history and cannot activate optional features or change rights", async () => {
  const p = await selectedUpgradeProfiles();
  for (const mutate of [
    (profile: any) => {
      profile.migrations = profile.migrations.filter(
        (m: string) => m !== "0019_community_profiles.sql",
      );
    },
    (profile: any) => {
      profile.migrations = profile.migrations.filter(
        (m: string) => m !== "0018_learning_authority.sql",
      );
    },
    (profile: any) => profile.migrations.push("0020_unknown.sql"),
    (profile: any) => profile.migrations.reverse(),
    (profile: any) =>
      profile.migrations.push("0013_learning_authorization.sql"),
    (profile: any) => {
      profile.resources = [];
    },
    (profile: any) => profile.bounds.providerRequests++,
    (profile: any) => {
      profile.publisher = "0x" + "77".repeat(20);
    },
    (profile: any) => {
      profile.credentialBinding = { changed: true };
    },
    (profile: any) => {
      profile.learning.issuer = "0x" + "77".repeat(20);
    },
    (profile: any) => {
      profile.learningV4.codeHash = "0x" + "77".repeat(32);
    },
    (profile: any) => {
      profile.rewards.source.fromBlock = "3";
    },
  ]) {
    const altered = structuredClone(p.currentV4);
    mutate(altered);
    const f = await reviewedSchemaPair(p.currentV4, altered);
    try {
      await assert.rejects(reviewedPredecessor(f.directory, f.packaged), Error);
    } finally {
      await f.dispose();
    }
  }
  for (const profile of p.retained) {
    assert.throws(
      () => assertLearningV4ApplicationUpgrade(p.currentV4, profile),
      /learning_v4_migrations_changed/,
    );
    assert.throws(
      () => assertLearningV4ApplicationUpgrade(profile, p.currentV4),
      /learning_v4_migrations_changed/,
    );
  }
  for (const missing of [
    "0014_reward_closure_snapshots.sql",
    "0015_community_media.sql",
    "0016_dance.sql",
  ]) {
    const incomplete = structuredClone(p.retained[2]!);
    incomplete.migrations = incomplete.migrations.filter(
      (m: string) => m !== missing,
    );
    assert.throws(
      () =>
        assertLearningV4ApplicationUpgrade(
          incomplete,
          structuredClone(incomplete),
        ),
      /learning_v4_migrations_changed/,
    );
  }
  const changedOwner = communityPublishingProfile(
    structuredClone(p.currentV4),
    await selection(undefined, { ownerWallet: "0x" + "cd".repeat(20) }),
  );
  assert.throws(
    () => assertLearningV4ApplicationUpgrade(p.currentV4, changedOwner),
    /owner_publishing_scope_changed/,
  );
  for (const migrations of [
    p.owner.migrations.filter(
      (m: string) => m !== "0019_community_profiles.sql",
    ),
    [...p.owner.migrations, "0020_unknown.sql"],
  ])
    assert.throws(
      () =>
        assertPublishingApplicationUpgrade(p.currentBase, {
          ...p.owner,
          migrations,
        }),
      /owner_publishing_migrations_changed/,
    );
});

test("actual Alchemy upgrades insert owner and V4 ordinals behind recorded19 without rewriting ledger rows or retained data", async () => {
  const p = await selectedUpgradeProfiles();
  const scenarios = [
    [p.legacy, p.owner, p.currentV4, structuredClone(p.currentV4)],
    [p.currentBase, p.owner, p.currentV4, structuredClone(p.currentV4)],
    [p.legacyV4, p.currentV4, structuredClone(p.currentV4)],
    ...p.retained.map((profile) => [profile, structuredClone(profile)]),
  ];
  for (const profiles of scenarios) {
    const runtime = new Miniflare({
      modules: true,
      script:
        "export default {fetch(){return new Response('local migration fixture')}}",
      compatibilityDate: "2026-08-06",
      d1Databases: ["DB"],
    });
    try {
      const db = await runtime.getD1Database("DB");
      let ledger: Awaited<ReturnType<typeof ownerMigrationLedger>> = [];
      let retainedLedgerRows: Record<string, unknown>[] = [];
      const fullLedger = async () =>
        (
          await db
            .prepare("SELECT * FROM __alchemy_migrations ORDER BY id")
            .all<Record<string, unknown>>()
        ).results;
      let seeded = false,
        profileSeeded = false,
        charged = false;
      let spending: unknown = null;
      const storedProfile = () =>
        db
          .prepare(
            "SELECT * FROM community_profiles WHERE account_id='upgrade-account'",
          )
          .first();
      const budgets = async () =>
        (
          await db.batch([
            db.prepare("SELECT * FROM owner_budget_windows ORDER BY scope"),
            db.prepare(
              "SELECT * FROM spending_budgets ORDER BY scope,period,asset",
            ),
            db.prepare(
              "SELECT * FROM spending_reservations ORDER BY reservation_id,scope,period,asset",
            ),
          ])
        ).map((r) => r.results);
      let retainedProfile: unknown = null;
      for (let index = 0; index < profiles.length; index++) {
        const profile = profiles[index]!;
        if (index)
          await assertReviewedSchemaPair(profiles[index - 1]!, profile);
        const records = await ownerMigrationRecords(
          profile.migrations.map(
            (name: string) => `${migrationDirectory}/${name}`,
          ),
        );
        assert.equal(
          migrationRegistry.rewrittenMigrationHistory(
            Object.fromEntries(ledger.map(({ name, hash }) => [name, hash])),
            Object.fromEntries(records.map(({ name, hash }) => [name, hash])),
          ),
          undefined,
        );
        await applyOwnerMigrationRecords(db, records);
        const known = new Set(ledger.map((row) => row.name));
        // Ledger IDs preserve actual application order. Newly selected12/13/18
        // append their rows after the original19; the file list stays sorted.
        ledger = [
          ...ledger,
          ...records
            .filter((record) => !known.has(record.name))
            .map(({ name, hash }) => ({ name, hash })),
        ];
        assert.deepEqual(await ownerMigrationLedger(db), ledger);
        const newLedgerRows = await fullLedger();
        assert.deepEqual(
          newLedgerRows.slice(0, retainedLedgerRows.length),
          retainedLedgerRows,
        );
        retainedLedgerRows = newLedgerRows;
        if (!seeded) {
          await db
            .prepare(
              "INSERT INTO community_accounts VALUES('upgrade-account','upgrade-author',1)",
            )
            .run();
          seeded = true;
        }
        if (
          profile.migrations.includes("0019_community_profiles.sql") &&
          !profileSeeded
        ) {
          await db
            .prepare(
              "INSERT INTO community_profiles(community_id,account_id,revision,display_name,bio) VALUES(?,'upgrade-account',1,'learner','retained profile')",
            )
            .bind(
              profile.ownerPublishing?.ownerGrant.communityId ??
                p.owner.ownerPublishing.ownerGrant.communityId,
            )
            .run();
          retainedProfile = await storedProfile();
          profileSeeded = true;
        }
        if (profileSeeded)
          assert.deepEqual(await storedProfile(), retainedProfile);
        if (profile.ownerPublishing && !charged) {
          await reserveOwnerBudget(
            db,
            profile.ownerPublishing.ownerGrant,
            "songs",
            "owner-song:upgrade-preserved",
            hashJson({ job: "upgrade-preserved" }),
            "1",
            2000000001,
          );
          spending = await budgets();
          charged = true;
        }
        if (charged) {
          await reserveOwnerBudget(
            db,
            profile.ownerPublishing.ownerGrant,
            "songs",
            "owner-song:upgrade-preserved",
            hashJson({ job: "upgrade-preserved" }),
            "1",
            2000086401,
          );
          assert.deepEqual(await budgets(), spending);
        }
        assert.deepEqual(
          (await db.prepare("PRAGMA foreign_key_check").all()).results,
          [],
        );
      }
      const final = profiles.at(-1)!;
      const records = await ownerMigrationRecords(
        final.migrations.map((name: string) => `${migrationDirectory}/${name}`),
      );
      const target = records.findIndex(
        (record) => record.name === "0019_community_profiles.sql",
      );
      const changed = structuredClone(records);
      changed[target]!.hash = migrationSha(
        changed[target]!.sql + "\n-- altered applied source\n",
      );
      assert.deepEqual(
        migrationRegistry.rewrittenMigrationHistory(
          Object.fromEntries(records.map(({ name, hash }) => [name, hash])),
          Object.fromEntries(changed.map(({ name, hash }) => [name, hash])),
        ),
        { changed: ["0019_community_profiles.sql"], removed: [] },
      );
      await assert.rejects(
        applyOwnerMigrationRecords(db, changed),
        /does not match the local files/,
      );
      assert.deepEqual(
        migrationRegistry.rewrittenMigrationHistory(
          Object.fromEntries(records.map(({ name, hash }) => [name, hash])),
          Object.fromEntries(
            records
              .filter((record) => record.name !== "0019_community_profiles.sql")
              .map(({ name, hash }) => [name, hash]),
          ),
        ),
        { changed: [], removed: ["0019_community_profiles.sql"] },
      );
      await assert.rejects(
        applyOwnerMigrationRecords(
          db,
          records.filter(
            (record) => record.name !== "0019_community_profiles.sql",
          ),
        ),
        /does not match the local files/,
      );
      assert.deepEqual(await ownerMigrationLedger(db), ledger);
      assert.deepEqual(await fullLedger(), retainedLedgerRows);
      assert.deepEqual(await storedProfile(), retainedProfile);
      assert.deepEqual(await budgets(), spending);
    } finally {
      await runtime.dispose();
    }
  }
});
