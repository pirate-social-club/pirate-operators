import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { keccak256, type Hex } from "viem";
import { hashJson } from "../packages/community/common.ts";
import { songKeyOf, textKey } from "../packages/protocol/records.ts";
import { RewardOffers } from "../packages/rewards/offers.ts";
import type {
  QualificationEntry,
  RewardOfferInput,
  RewardSources,
  RewardsProfile,
} from "../packages/rewards/contracts.ts";
import {
  liveRewardSources,
  rewardResultSources,
  type RewardResultSource,
  type RewardResultSuccessor,
} from "../services/reward-sources.ts";
import {
  assertRewardsApplicationUpgrade,
  assertRewardsFollowLearningV4,
  rewardsReleaseSelection,
} from "../harness/rewards-release-profile.ts";
import { observeRewardSuccessors } from "../harness/rewards-successor-observation.ts";
import { applicationRewardsBindings } from "../apps/community-wizard/infra/rewards-bindings.ts";
import { learningCommunityProfile } from "../harness/learning-community-profile.ts";
import { studyReleaseSelection } from "../harness/study-release-profile.ts";
import { selectionFixture } from "./fixtures/study-release.ts";
import {
  manualRewardsFixture,
  rewardHash,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";

const grader = rewardTestProfile.operatorWallet;
const original: RewardResultSource = {
  schema: "pirate.reward-result-source/1",
  contract: `0x${"a3".repeat(20)}`,
  codeHash: rewardHash(903),
  fromBlock: "1",
  grader,
  karaokePolicy: rewardHash(910),
  studyPolicy: rewardHash(911),
};
const v4: RewardResultSuccessor = {
  schema: "pirate.reward-result-source/2",
  version: 4,
  contract: `0x${"a4".repeat(20)}`,
  codeHash: rewardHash(904),
  fromBlock: "40",
  grader,
  karaokePolicy: rewardHash(920),
  studyPolicy: rewardHash(921),
};
const originalHash = hashJson(original),
  v4Hash = hashJson(v4);
const liveProfile: RewardsProfile = {
  ...rewardTestProfile,
  mode: "live-testnet",
  operatorWallet: rewardTestProfile.payoutWallet,
  resultSourceHash: originalHash,
};

test("successor sources append to the original by content hash and never repeat a contract", () => {
  const sources = rewardResultSources(original, JSON.stringify([v4]));
  assert.deepEqual([...sources.keys()], [originalHash, v4Hash]);
  assert.deepEqual(
    [...rewardResultSources(original, undefined).keys()],
    [originalHash],
  );
  for (const bad of [
    [{ ...v4, contract: original.contract }],
    [v4, v4],
    [{ ...v4, version: 3 }],
    [{ ...v4, schema: "pirate.reward-result-source/1" }],
    [{ ...v4, extra: true }],
    [{ ...v4, contract: v4.contract.toUpperCase().replace("0X", "0x") }],
    Array.from({ length: 8 }, (_, i) => ({
      ...v4,
      contract: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    })),
    { ...v4 },
  ])
    assert.throws(
      () => rewardResultSources(original, JSON.stringify(bad)),
      /reward_result_successor_invalid|invalid_fields/,
    );
});

test("new offers pin accepted sources before opening; pins are stored, hashed and re-checked at close", async () => {
  const f = await manualRewardsFixture();
  try {
    let now = 1794070800000;
    let seen: RewardOfferInput | undefined;
    const sources: RewardSources = {
      mode: "simulated",
      resultSources: { accepted: [originalHash, v4Hash], current: v4Hash },
      purchase: async (input) => ({
        receiptHash: hashJson(input),
        mode: "simulated",
      }),
      qualifiers: async (offer) => {
        seen = offer;
        return [];
      },
      winnings: async () => ({
        mode: "simulated",
        usdcAtomic: "0",
        receiptHash: rewardHash(901),
      }),
    };
    const offers = new RewardOffers(f.store, sources, () => now);
    const input = (offerId: string, drawingId: string): RewardOfferInput => ({
      offerId,
      drawingId,
      songKey: rewardHash(500),
      opensAt: now + 1000,
      cutoffAt: now + 10000,
      purchaseHash: rewardHash(Number(drawingId) + 1000),
      ticketIds: [drawingId],
    });
    for (const resultSources of [
      [],
      [originalHash],
      [v4Hash, v4Hash],
      [v4Hash, rewardHash(77)],
    ])
      await assert.rejects(
        offers.attach({ ...input("offer_pin_01", "11"), resultSources }),
        /reward_offer_sources_invalid/,
      );
    const pinned = {
      ...input("offer_pin_01", "11"),
      resultSources: [originalHash, v4Hash],
    };
    const attached = await offers.attach(pinned);
    assert.deepEqual(attached.resultSources, [originalHash, v4Hash]);
    // Identical re-attachment is idempotent; changing the pins is a conflict.
    assert.deepEqual(
      (await offers.attach(pinned)).resultSources,
      pinned.resultSources,
    );
    await assert.rejects(
      offers.attach({ ...pinned, resultSources: [v4Hash] }),
      /reward_offer_conflict/,
    );
    // Naming no sources pins every live source, and resubmitting stays idempotent.
    const defaulted = input("offer_pin_05", "15");
    assert.deepEqual((await offers.attach(defaulted)).resultSources, [
      originalHash,
      v4Hash,
    ]);
    assert.deepEqual((await offers.attach(defaulted)).resultSources, [
      originalHash,
      v4Hash,
    ]);
    // A second open offer whose stored pins are altered cannot be closed.
    await offers.attach({
      ...input("offer_pin_02", "12"),
      resultSources: [v4Hash],
    });
    await f.db
      .prepare(
        "UPDATE reward_offers SET purchase_evidence=json_set(purchase_evidence,'$.resultSources',json(?)) WHERE offer_id='offer_pin_02'",
      )
      .bind(JSON.stringify([originalHash, v4Hash]))
      .run();
    now = pinned.cutoffAt;
    const closed = await offers.close("offer_pin_01");
    assert.equal(closed.state, "closed");
    assert.deepEqual(seen?.resultSources, [originalHash, v4Hash]);
    await assert.rejects(
      offers.close("offer_pin_02"),
      /reward_offer_input_changed/,
    );
    // A reader without public result sources accepts no pins.
    now = 1794070800000;
    await assert.rejects(
      f.offers.attach({
        ...input("offer_pin_03", "13"),
        resultSources: [v4Hash],
      }),
      /reward_offer_sources_unavailable/,
    );
    // An offer from before succession, with no pins, still closes unchanged.
    await f.offers.attach(input("offer_pin_04", "14"));
    now = 1794070800000 + 10000;
    const legacy = await new RewardOffers(f.store, sources, () => now).close(
      "offer_pin_04",
    );
    assert.equal(legacy.state, "closed");
    assert.equal(seen?.resultSources, undefined);
  } finally {
    await f.dispose();
  }
});

test("live qualifiers read every pinned source to one cutoff and keep each wallet's earliest result", async () => {
  const f = await manualRewardsFixture();
  try {
    const song = {
      chainId: 6343n,
      posts: `0x${"77".repeat(20)}`,
      communityId: rewardHash(7),
      postId: rewardHash(8),
    };
    const songKey = songKeyOf({ ...song, chainId: 6343 } as never);
    const learnerA = `0x${"55".repeat(20)}`,
      learnerB = `0x${"66".repeat(20)}`;
    const karaoke = (
      source: RewardResultSource | RewardResultSuccessor,
      learner: string,
      completedSeconds: number,
      commitment: string,
    ) => ({
      verified: true,
      commitment,
      period: 0n,
      problems: [],
      assessment: {
        activity: 1,
        lines: [{ status: "assessed", scoreBps: 9000 }],
      },
      result: {
        learner,
        grader,
        activity: 1,
        status: 1,
        completedAt: BigInt(completedSeconds),
        song,
        qualificationPolicy: source.karaokePolicy,
        scoringPolicy: textKey("karaoke-scoring/5"),
      },
    });
    const calls: {
      contract: string;
      version: number;
      from: bigint;
      to: bigint;
    }[] = [];
    const block = (n: bigint) => ({
      number: n,
      timestamp: n,
      hash: rewardHash(Number(n)) as Hex,
    });
    let policy: Record<number, string> = {};
    let flip = false;
    const live = (learningRecords: string, profile = liveProfile) =>
      liveRewardSources({
        db: f.db,
        profile,
        sources: rewardResultSources(original, JSON.stringify([v4])),
        config: {
          communityId: rewardHash(7),
          learningRecords,
        } as never,
        reads: {
          client: {
            getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) =>
              q.blockTag === "safe"
                ? block(100n)
                : flip && q.blockNumber === 89n && calls.length > 0
                  ? { ...block(89n), hash: rewardHash(1) as Hex }
                  : block(q.blockNumber!),
            readContract: async ({
              address,
              functionName,
              args,
            }: {
              address: string;
              functionName: string;
              args: [number | bigint, bigint];
            }) => {
              assert.equal(address, v4.contract);
              if (functionName === "periodOf") return BigInt(args[0]) / 86400n;
              const activity = Number(args[0]);
              return (
                policy[activity] ??
                (activity === 1 ? v4.karaokePolicy : v4.studyPolicy)
              );
            },
          } as never,
          profile: {} as never,
        },
        readResults: (async (source: any, input: any) => {
          calls.push({
            contract: source.contract,
            version: source.version,
            from: input.fromBlock,
            to: input.toBlock,
          });
          return source.contract === original.contract
            ? [
                karaoke(original, learnerA, 60, rewardHash(301)),
                karaoke(original, learnerB, 70, rewardHash(302)),
              ]
            : [
                karaoke(v4, learnerA, 55, rewardHash(401)),
                // After the cutoff, and under the wrong policy: neither counts.
                karaoke(v4, learnerB, 95, rewardHash(402)),
                karaoke(original, learnerB, 65, rewardHash(403)),
              ];
        }) as never,
      });
    const offer: RewardOfferInput = {
      offerId: "offer_live_01",
      drawingId: "1",
      songKey,
      opensAt: 50000,
      cutoffAt: 90000,
      purchaseHash: rewardHash(1),
      ticketIds: ["1"],
    };
    const both = live(v4.contract);
    assert.deepEqual(both.resultSources, {
      accepted: [originalHash, v4Hash],
      current: v4Hash,
    });
    const entries = (
      await both.qualifiers({ ...offer, resultSources: [originalHash, v4Hash] })
    ).sort((a: QualificationEntry, b: QualificationEntry) =>
      a.accountId.localeCompare(b.accountId),
    );
    assert.deepEqual(
      calls.map((c) => [c.contract, c.version, c.from, c.to]),
      [
        [original.contract, 3, 50n, 89n],
        [v4.contract, 4, 50n, 89n],
      ],
    );
    assert.deepEqual(
      entries.map((e) => [e.accountId, e.evidenceHash, e.completedAt]),
      [
        ["learner_01", rewardHash(401), 55000],
        ["learner_02", rewardHash(302), 70000],
      ],
    );
    // Without pins an offer reads the original source alone.
    calls.length = 0;
    assert.equal((await both.qualifiers(offer)).length, 2);
    assert.deepEqual(
      calls.map((c) => c.contract),
      [original.contract],
    );
    await assert.rejects(
      both.qualifiers({ ...offer, resultSources: [rewardHash(77)] }),
      /reward_result_source_unavailable/,
    );
    assert.equal(live(original.contract).resultSources?.current, originalHash);
    assert.throws(
      () => live(`0x${"a5".repeat(20)}`),
      /reward_results_contract_changed/,
    );
    assert.throws(
      () =>
        live(v4.contract, { ...liveProfile, resultSourceHash: rewardHash(5) }),
      /reward_result_profile_changed/,
    );
    // A V4 policy rotated inside the window stops the close; a period before
    // the first activation (zero) does not.
    const pinnedBoth = { ...offer, resultSources: [originalHash, v4Hash] };
    policy = { 2: rewardHash(999) };
    await assert.rejects(
      both.qualifiers(pinnedBoth),
      /reward_result_policy_rotated/,
    );
    policy = { 1: rewardHash(0), 2: rewardHash(0) };
    assert.equal((await both.qualifiers(pinnedBoth)).length, 2);
    policy = {};
    // Every source is read to the same canonical cutoff block.
    calls.length = 0;
    flip = true;
    await assert.rejects(
      both.qualifiers(pinnedBoth),
      /reward_results_head_changed/,
    );
    flip = false;
    // A rehearsal keeps the live reader's accepted sources.
    const rehearsal = live(v4.contract, {
      ...liveProfile,
      rehearsal: {
        schema: "pirate.reward-rehearsal/1",
        offerId: "rehearsal_001",
        prizeUsdcAtomic: "30000",
      },
    });
    assert.deepEqual(rehearsal.resultSources, both.resultSources);
  } finally {
    await f.dispose();
  }
});

async function releaseProfiles() {
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
    ...original,
    contract: previous.learning.studyContract,
    codeHash: previous.learning.studyCodeHash,
  };
  const rewards = {
    schema: "pirate.rewards-release-selection/1",
    profile: { ...liveProfile, resultSourceHash: hashJson(source) },
    source,
  };
  const deployed = {
    ...structuredClone(previous),
    rewards: rewardsReleaseSelection(rewards),
    migrations: [...previous.migrations, "0011_manual_rewards.sql"],
  };
  return { previous, deployed };
}

test("a rewards release appends at most one result source and never edits or removes one", async () => {
  const { previous, deployed } = await releaseProfiles();
  const withV4 = structuredClone(deployed);
  withV4.rewards.successors = [v4];
  assert.doesNotThrow(() => assertRewardsApplicationUpgrade(deployed, withV4));
  assert.doesNotThrow(() =>
    assertRewardsApplicationUpgrade(withV4, structuredClone(withV4)),
  );
  const v5 = { ...v4, contract: `0x${"a6".repeat(20)}` };
  const appended = structuredClone(withV4);
  appended.rewards.successors.push(v5);
  assert.doesNotThrow(() => assertRewardsApplicationUpgrade(withV4, appended));
  const twice = structuredClone(deployed);
  twice.rewards.successors = [v4, v5];
  const edited = structuredClone(withV4);
  edited.rewards.successors[0].fromBlock = "41";
  const reordered = structuredClone(appended);
  reordered.rewards.successors.reverse();
  const firstRelease = { ...structuredClone(withV4) };
  for (const [from, to] of [
    [deployed, twice],
    [withV4, deployed],
    [withV4, edited],
    [appended, reordered],
    [previous, firstRelease],
  ])
    assert.throws(
      () => assertRewardsApplicationUpgrade(from, to),
      /reward_release_successors_changed/,
    );
  // A rehearsal rollover may travel with an appended source.
  const rehearsal = structuredClone(deployed);
  rehearsal.rewards.profile.rehearsal = {
    schema: "pirate.reward-rehearsal/1",
    offerId: "rehearsal_001",
    prizeUsdcAtomic: "30000",
  };
  const rolled = structuredClone(rehearsal);
  rolled.rewards.profile.rehearsalHistory = [
    rehearsal.rewards.profile.rehearsal,
  ];
  rolled.rewards.profile.rehearsal = {
    ...rehearsal.rewards.profile.rehearsal,
    offerId: "rehearsal_002",
  };
  rolled.rewards.successors = [v4];
  assert.doesNotThrow(() => assertRewardsApplicationUpgrade(rehearsal, rolled));
  const program = structuredClone(withV4);
  program.rewards.profile.veryAppId = "another_program";
  assert.throws(
    () => assertRewardsApplicationUpgrade(deployed, program),
    /reward_release_program_changed/,
  );
  for (const [successors, error] of [
    [[{ ...v4, grader: rewardTestProfile.token }], /successor_grader_changed/],
    [
      [{ ...v4, contract: deployed.rewards.source.contract }],
      /successor_invalid/,
    ],
    [[], /successors_invalid/],
  ] as const) {
    const bad = structuredClone(deployed);
    (bad.rewards as any).successors = successors;
    assert.throws(() => rewardsReleaseSelection(bad.rewards), error);
  }
});

test("a V4 selection and the rewards V4 source travel together", () => {
  const selection = rewardsReleaseSelection({
    schema: "pirate.rewards-release-selection/1",
    profile: liveProfile,
    source: original,
    successors: [v4],
  });
  const bare = rewardsReleaseSelection({
    schema: "pirate.rewards-release-selection/1",
    profile: liveProfile,
    source: original,
  });
  const learningV4 = { contract: v4.contract, codeHash: v4.codeHash };
  assert.doesNotThrow(() =>
    assertRewardsFollowLearningV4(selection, learningV4),
  );
  assert.doesNotThrow(() => assertRewardsFollowLearningV4(bare, undefined));
  assert.doesNotThrow(() =>
    assertRewardsFollowLearningV4(undefined, learningV4),
  );
  // A redeployed V4 is appended; the latest V4 source is the selected one.
  const redeployed = {
    ...v4,
    contract: `0x${"a7".repeat(20)}`,
    codeHash: rewardHash(907),
  };
  const both = rewardsReleaseSelection({
    schema: "pirate.rewards-release-selection/1",
    profile: liveProfile,
    source: original,
    successors: [v4, redeployed],
  });
  assert.doesNotThrow(() =>
    assertRewardsFollowLearningV4(both, {
      contract: redeployed.contract,
      codeHash: redeployed.codeHash,
    }),
  );
  for (const [rewards, v] of [
    [both, learningV4],
    [bare, learningV4],
    [selection, undefined],
    [selection, { ...learningV4, codeHash: rewardHash(905) }],
    [selection, { ...learningV4, contract: original.contract }],
  ] as const)
    assert.throws(
      () => assertRewardsFollowLearningV4(rewards, v),
      /reward_release_v4_source_mismatch/,
    );
});

test("the reviewed binding package passes appended sources through only when valid", () => {
  const env = {
    REWARDS_PROFILE_JSON: JSON.stringify(liveProfile),
    REWARDS_RESULT_SOURCE_JSON: JSON.stringify(original),
  };
  assert.deepEqual(applicationRewardsBindings(env), env);
  const withV4 = {
    ...env,
    REWARDS_RESULT_SUCCESSORS_JSON: JSON.stringify([v4]),
  };
  assert.deepEqual(applicationRewardsBindings(withV4), withV4);
  for (const successors of [
    [],
    [{ ...v4, version: 3 }],
    [{ ...v4, grader: rewardTestProfile.token }],
    [{ ...v4, contract: original.contract }],
    [{ ...v4, fromBlock: "01" }],
    [{ ...v4, codeHash: rewardHash(0) }],
    [{ ...v4, studyPolicy: rewardHash(0) }],
    [v4, v4],
  ])
    assert.throws(
      () =>
        applicationRewardsBindings({
          ...env,
          REWARDS_RESULT_SUCCESSORS_JSON: JSON.stringify(successors),
        }),
      /reward_release_binding_invalid/,
    );
  assert.throws(
    () =>
      applicationRewardsBindings({
        REWARDS_RESULT_SUCCESSORS_JSON: JSON.stringify([v4]),
      }),
    /reward_release_binding_missing/,
  );
});

test("an appended source is observed live: code, version, community, grader roles and pinned policies", async () => {
  const code = "0x6001600055" as Hex;
  const source = { ...v4, codeHash: keccak256(code) };
  const selection = rewardsReleaseSelection({
    schema: "pirate.rewards-release-selection/1",
    profile: liveProfile,
    source: original,
    successors: [source],
  });
  const communityId = rewardHash(7);
  const pinned = (activity: unknown) =>
    activity === 1 ? source.karaokePolicy : source.studyPolicy;
  const client = (
    change: Record<string, unknown> = {},
    current: (activity: unknown) => string = pinned,
    future: (activity: unknown) => string = pinned,
  ) =>
    ({
      getChainId: async () => 6343,
      getBlockNumber: async () => 101n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: rewardHash(Number(blockNumber)),
        timestamp: 1_794_070_800n,
      }),
      getCode: async () => change.code ?? code,
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: unknown[];
      }) => {
        if (functionName in change) return change[functionName];
        if (functionName === "VERSION") return 4;
        if (functionName === "communityId") return communityId;
        if (functionName === "graders") return args![0] === grader;
        if (functionName === "periodOf") return 12n;
        if (functionName === "policyFor")
          return args![1] === 12n ? current(args![0]) : future(args![0]);
        throw Error(functionName);
      },
    }) as never;
  const ok = await observeRewardSuccessors(client(), selection, communityId);
  assert.deepEqual(ok.observed, [{ contract: source.contract, period: "12" }]);
  // Just after deployment the first activation may not have started yet.
  await observeRewardSuccessors(
    client({}, () => rewardHash(0)),
    selection,
    communityId,
  );
  for (const [change, current, future, error] of [
    [{ code: "0x6001" }, pinned, pinned, /code_changed/],
    [{ VERSION: 3 }, pinned, pinned, /version_changed/],
    [{ communityId: rewardHash(8) }, pinned, pinned, /community_changed/],
    [{ graders: false }, pinned, pinned, /grader_missing/],
    [{}, () => rewardHash(5), pinned, /policy_changed/],
    // A rotation already scheduled for a later period.
    [{}, pinned, () => rewardHash(5), /policy_changed/],
    [{}, pinned, () => rewardHash(0), /policy_changed/],
  ] as const)
    await assert.rejects(
      observeRewardSuccessors(
        client(change, current, future),
        selection,
        communityId,
      ),
      error,
    );
  // A source the deployed predecessor already carries is not re-judged.
  const again = await observeRewardSuccessors(
    client({ code: "0x6001" }),
    selection,
    communityId,
    [source],
  );
  assert.deepEqual(again.observed, []);
});

test("a categorical pin shares the scored cutoff and remains explicit and revalidatable", async () => {
  const code = "0x60006000f3";
  const scored = { ...original, codeHash: keccak256(code) };
  const scoredHash = hashJson(scored);
  const categoryHash = rewardHash(9010);
  let cutoffHash = rewardHash(89) as Hex;
  let policyHash = rewardHash(9011) as Hex;
  const entry = {
    accountId: "learner_01",
    wallet: `0x${"55".repeat(20)}`,
    completedAt: 65000,
    evidenceHash: rewardHash(9012),
  };
  const verified: bigint[] = [];
  const scoredCutoffs: (Hex | undefined)[] = [];
  const live = liveRewardSources({
    db: {} as D1Database,
    profile: { ...liveProfile, resultSourceHash: scoredHash },
    sources: rewardResultSources(scored, undefined),
    config: {
      communityId: rewardHash(7),
      learningRecords: scored.contract,
    } as never,
    reads: {
      client: {
        getChainId: async () => 6343,
        getCode: async () => code,
        getBlock: async ({
          blockTag,
          blockNumber,
        }: {
          blockTag?: string;
          blockNumber?: bigint;
        }) => {
          const number = blockTag === "safe" ? 100n : blockNumber!;
          return {
            number,
            timestamp: number,
            hash: number === 89n ? cutoffHash : rewardHash(Number(number)),
          };
        },
      } as never,
      profile: {} as never,
    },
    readResults: async (_source, range) => {
      assert.equal(range.fromBlock, 50n);
      assert.equal(range.toBlock, 89n);
      scoredCutoffs.push(range.expectedToBlockHash);
      return [];
    },
    categorical: new Map([
      [
        categoryHash,
        {
          fromBlock: 40n,
          verifyAt: async (block) => {
            verified.push(block.number);
            return policyHash;
          },
          read: async (offer, hash, start, block) => {
            assert.equal(hash, hashJson(offer));
            assert.equal(start, 50n);
            assert.equal(block.number, 89n);
            return [entry];
          },
        },
      ],
    ]),
  });
  assert.deepEqual(live.resultSources, {
    accepted: [scoredHash, categoryHash],
    current: scoredHash,
    defaults: [scoredHash],
  });
  const offer: RewardOfferInput = {
    offerId: "offer_categorical",
    drawingId: "1",
    songKey: rewardHash(10),
    opensAt: 50000,
    cutoffAt: 90000,
    purchaseHash: rewardHash(9),
    ticketIds: ["1"],
  };
  const pinned = { ...offer, resultSources: [scoredHash, categoryHash] };
  assert.ok(live.closure);
  assert.equal(live.closure.requires(offer), false);
  assert.deepEqual(await live.qualifiers(offer), []);
  assert.deepEqual(verified, []);
  await assert.rejects(live.qualifiers(pinned), /reward_closure_unavailable/);
  await assert.rejects(
    live.closure.admit!({ ...pinned, opensAt: 39000 }),
    /reward_history_starts_after_offer/,
  );
  await live.closure.admit!(pinned);
  const closed = await live.closure.scan(pinned, hashJson(pinned));
  assert.deepEqual(closed.entries, [entry]);
  assert.deepEqual(scoredCutoffs, [undefined, undefined, cutoffHash]);
  assert.deepEqual(closed.captured, new Set([hashJson(entry)]));
  assert.deepEqual(
    closed.evidence.sources.map((pin) => pin.sourceHash),
    pinned.resultSources,
  );
  assert.equal(closed.evidence.cutoffHash, cutoffHash);
  await live.closure.verify(pinned, closed.evidence);
  assert.deepEqual(verified, [100n, 89n, 89n]);
  policyHash = rewardHash(9013) as Hex;
  await assert.rejects(
    live.closure.verify(pinned, closed.evidence),
    /reward_closure_sources_changed/,
  );
  cutoffHash = rewardHash(9014) as Hex;
  await assert.rejects(
    live.closure.verify(pinned, closed.evidence),
    /reward_results_head_changed/,
  );
});
