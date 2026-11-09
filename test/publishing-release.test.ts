// Owner publishing deployment profiles and successor gates. Public data only;
// nothing here deploys, binds credentials or publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { hashJson } from "../packages/community/common.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../packages/community/owner-policy.ts";
import {
  ownerGrantDigest,
  validateOwnerGrant,
} from "../packages/release/owner-grant.ts";
import { learningCommunityProfile } from "../harness/learning-community-profile.ts";
import { studyReleaseSelection } from "../harness/study-release-profile.ts";
import { selectionFixture } from "./fixtures/study-release.ts";
import { rewardHash, rewardTestProfile } from "./manual-rewards-fixture.ts";
import {
  assertRewardsApplicationUpgrade,
  rewardsReleaseSelection,
} from "../harness/rewards-release-profile.ts";
import {
  assertPublishingApplicationUpgrade,
  assertPublishingManagedUpgrade,
  communityPublishingProfile,
  managedPublishingProfile,
  publishingReleaseSelection,
} from "../harness/publishing-release-profile.ts";
import { applicationPublishingBindings } from "../apps/community-wizard/infra/publishing-bindings.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { managedUpdate } from "../harness/managed-update-pin.ts";

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

test("the managed publishing successor appends only 0004, swaps the grant and drops the registration key and bounds", async () => {
  const previous = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.moderation-plan.json",
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

test("the managed update names the deployed published-recovery predecessor and its retained evidence", async () => {
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const plan = await read(managedUpdate.previousPlanPath),
    evidence = (await read(managedUpdate.previousEvidencePath)).services
      .managed,
    startup = (await read(managedUpdate.startupEvidencePath)).resourceIds;
  assert.equal(plan.profileHash, managedUpdate.previousProfileHash);
  assert.equal(hashJson(plan.profile), plan.profileHash);
  // The pinned predecessor is a byte copy of the committed deployed plan.
  assert.equal(
    await readFile(managedUpdate.previousPlanPath, "utf8"),
    await readFile(
      "docs/deployments/first-song-managed-20261105.moderation-plan.json",
      "utf8",
    ),
  );
  assert.equal(evidence.profileHash, plan.profileHash);
  assert.equal(evidence.resultSha256, managedUpdate.expectedResultSha256);
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
