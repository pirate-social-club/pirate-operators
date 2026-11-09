// Rewards from actual local V3 and V4 publications, through the authenticated
// operator API. A local anvil runs with the pilot chain id so the live reader
// runs unchanged: code hash, version, community, events, commitments and
// revision reduction are all real. Only the lyric source authentication is a
// fixture, because no posts contract or IPFS exists locally. Purchases and
// prizes are the declared rehearsal's simulated ones; no provider is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Address, type Hex } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts } from "../harness/runtime.ts";
import { stopChain } from "./payments-fixture.ts";
import {
  CommunityError,
  hashJson,
  hashText,
} from "../packages/community/common.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  songKeyOf,
  RECORDS_EPOCH_START,
} from "../packages/protocol/records.ts";
import {
  enrollmentTypes,
  enrollmentV3Id,
  resultsV3Domain,
} from "../packages/protocol/learning-results-v3.ts";
import {
  resultsV4Domain,
  signInIdV4,
  signInTypes,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  completedStudyBundle,
  terminalStudyFacts,
} from "../packages/study/result-adapter.ts";
import { studyFactsBundle } from "../packages/study/terminal-facts.ts";
import { rehearsalTerms } from "../packages/rewards/rehearsal.ts";
import type { RewardsProfile } from "../packages/rewards/contracts.ts";
import {
  liveRewardSources,
  rewardResultSources,
  type RewardResultSource,
  type RewardResultSuccessor,
} from "../services/reward-sources.ts";
import { rewardsCommunityApi } from "../services/rewards-community-api.ts";
import { studyResultFixture } from "./study-result-fixture.ts";
import {
  manualRewardsFixture,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";

const PERIOD = 86400n;
/** Session cookie tokens have the application's 64-hex form. */
const token = (who: "operator" | number) =>
  (who === "operator" ? "fe" : `a${who}`).repeat(32);

test(
  "actual V3 and V4 publications qualify through pinned sources, and a learner on both is credited once",
  { timeout: 180000 },
  async () => {
    const evm = await chain(19793, 6343);
    const study = studyResultFixture();
    const communityId = study.source.communityId as Hex;
    const grader = accounts[2]!.address as Address;
    const policy = digest(study.policy);
    let f: Awaited<ReturnType<typeof manualRewardsFixture>> | undefined;
    let g: typeof f;
    try {
      // The original V3 source and the appended V4 contract, both graded by
      // the publisher with the same Study policy from the next period.
      const v3 = await evm.deploy("LearningResultsV3", [
        accounts[3]!.address,
        communityId,
        digest("publicity-v3"),
      ]);
      const v4 = await evm.deploy("LearningResultsV4", [
        accounts[3]!.address,
        communityId,
        learningV4PublicityPolicy,
      ]);
      const deployed = await evm.publicClient.getBlock();
      const nextPeriod =
        (deployed.timestamp - BigInt(RECORDS_EPOCH_START)) / PERIOD + 1n;
      for (const [address, name] of [
        [v3, "LearningResultsV3"],
        [v4, "LearningResultsV4"],
      ] as const) {
        await evm.write(address, name, "setGrader", [grader, 2, true], 3);
        await evm.write(
          address,
          name,
          "activatePolicy",
          [2, policy, "ipfs://local-policy-fixture", nextPeriod],
          3,
        );
      }
      const codeHash = async (address: Address) =>
        keccak256((await evm.publicClient.getCode({ address }))!);
      const karaokePolicy = digest("karaoke-policy-not-activated");
      const original: RewardResultSource = {
        schema: "pirate.reward-result-source/1",
        contract: v3.toLowerCase(),
        codeHash: await codeHash(v3),
        fromBlock: deployed.number.toString(),
        grader: grader.toLowerCase(),
        karaokePolicy,
        studyPolicy: policy,
      };
      const successor: RewardResultSuccessor = {
        schema: "pirate.reward-result-source/2",
        version: 4,
        contract: v4.toLowerCase(),
        codeHash: await codeHash(v4),
        fromBlock: deployed.number.toString(),
        grader: grader.toLowerCase(),
        karaokePolicy,
        studyPolicy: policy,
      };
      const originalHash = hashJson(original),
        successorHash = hashJson(successor);

      // Publication permission: A and B enroll on V3; A and C sign in on V4.
      const [a, b, c] = [accounts[5]!, accounts[6]!, accounts[7]!];
      const now0 = (await evm.publicClient.getBlock()).timestamp;
      const v3Grants = new Map<
        string,
        { id: Hex; issuedAt: number; expiresAt: number }
      >();
      for (const learner of [a, b]) {
        const enrollment = {
          learner: learner.address,
          communityId,
          activities: 3n,
          publicityPolicy: digest("publicity-v3"),
          expiresAt: now0 + 3n * PERIOD,
          nonce: 0n,
        };
        const signature = await learner.signTypedData({
          domain: resultsV3Domain(6343, v3),
          types: enrollmentTypes,
          primaryType: "Enrollment",
          message: enrollment,
        });
        await evm.write(
          v3,
          "LearningResultsV3",
          "enroll",
          [enrollment, signature],
          2,
        );
        const grant = (await evm.read(v3, "LearningResultsV3", "enrollments", [
          learner.address,
        ])) as readonly [Hex, bigint, bigint, bigint];
        v3Grants.set(learner.address, {
          id: enrollmentV3Id(6343, v3, enrollment),
          issuedAt: Number(grant[2]),
          expiresAt: Number(grant[3]),
        });
      }
      const v4Grants = new Map<
        string,
        { id: Hex; issuedAt: number; expiresAt: number }
      >();
      for (const learner of [a, c]) {
        const message: SignIn = {
          learner: learner.address,
          communityId,
          origin: "https://community.example",
          publicationPolicy: learningV4PublicityPolicy,
          nonce: digest(`sign-in-${learner.address}`),
          issuedAt: now0,
          expiresAt: now0 + 300n,
        };
        const signature = await learner.signTypedData({
          domain: resultsV4Domain(6343, v4),
          types: signInTypes,
          primaryType: "SignIn",
          message,
        });
        await evm.write(
          v4,
          "LearningResultsV4",
          "authorize",
          [message, signature],
          2,
        );
        v4Grants.set(learner.address, {
          id: signInIdV4(6343, v4, message),
          issuedAt: Number(now0),
          expiresAt: Number(now0 + 300n),
        });
      }

      // The policy period begins; offers are attached before their windows open.
      const start = BigInt(RECORDS_EPOCH_START) + nextPeriod * PERIOD + 10n;
      await evm.rpc("evm_setNextBlockTimestamp", [Number(start)]);
      await evm.rpc("evm_mine", []);
      let now = Number(start) * 1000;
      const opensAt = now + 60_000,
        cutoffAt = now + 3_600_000;

      const profile: RewardsProfile = {
        ...rewardTestProfile,
        mode: "live-testnet",
        operatorWallet: rewardTestProfile.payoutWallet,
        rpcUrl: evm.rpcUrl,
        resultSourceHash: originalHash,
        rehearsal: {
          schema: "pirate.reward-rehearsal/1",
          offerId: "rehearsal_v3v4_both_001",
          prizeUsdcAtomic: "30000",
        },
      };
      // A second program, in its own database (one program per database),
      // whose offer pins V4 alone.
      const v4Only: RewardsProfile = {
        ...profile,
        programId: `0x${"cd".repeat(32)}`,
        rehearsal: {
          schema: "pirate.reward-rehearsal/1",
          offerId: "rehearsal_v4_only_001",
          prizeUsdcAtomic: "30000",
        },
      };
      f = await manualRewardsFixture(profile);
      g = await manualRewardsFixture(v4Only);
      const dbs = new Map([
        [profile.programId, f],
        [v4Only.programId, g],
      ]);
      // Learner accounts bound to their MOSS wallets, and sessions for them and the operator.
      const context = { communityId, origin: "https://community.example" };
      const people = [
        ["learner_a", a.address],
        ["learner_b", b.address],
        ["learner_c", c.address],
      ] as const;
      for (const { db } of dbs.values()) {
        for (const [i, [accountId, wallet]] of people.entries())
          await db.batch([
            db
              .prepare(
                "INSERT INTO community_accounts(account_id,author_id,created_at) VALUES(?,?,0)",
              )
              .bind(accountId, digest(`author-${accountId}`)),
            db
              .prepare(
                "INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at) VALUES(?,?,'moss',6343,?,0)",
              )
              .bind(`binding_${accountId}`, accountId, wallet.toLowerCase()),
            db
              .prepare(
                "INSERT INTO community_sessions(session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at) VALUES(?,?,?,?,?,?,?)",
              )
              .bind(
                hashText(token(i)),
                communityId,
                context.origin,
                accountId,
                `binding_${accountId}`,
                `csrf_${i}`,
                Date.now() + 1_000_000,
              ),
          ]);
        await db
          .prepare(
            "INSERT INTO community_sessions(session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at) VALUES(?,?,?,?,?,?,?)",
          )
          .bind(
            hashText(token("operator")),
            communityId,
            context.origin,
            "operator_01",
            "binding_2",
            "csrf_operator",
            Date.now() + 1_000_000,
          )
          .run();
      }

      const songKey = songKeyOf({
        chainId: 6343,
        posts: study.source.postsContract,
        communityId,
        postId: study.source.postId,
      } as never);
      const sourcesFor = (p: RewardsProfile) =>
        liveRewardSources({
          db: dbs.get(p.programId)!.db,
          profile: p,
          sources: rewardResultSources(original, JSON.stringify([successor])),
          // The directory now publishes to V4.
          config: { communityId, learningRecords: v4 } as never,
          reads: { client: evm.publicClient as never, profile: {} as never },
          sourcePorts: {
            studyManifest: async () => study.source,
            authenticateStudy: async (s) => digest(s) === digest(study.source),
          },
        });
      async function call(
        p: RewardsProfile,
        who: "operator" | number,
        path: string,
        body?: unknown,
      ) {
        const headers = new Headers({
          cookie: `__Host-community_session=${token(who)}`,
        });
        if (body !== undefined) {
          headers.set("origin", context.origin);
          headers.set("content-type", "application/json");
          headers.set("x-csrf-token", `csrf_${who}`);
        }
        try {
          const response = (await rewardsCommunityApi(
            new Request(context.origin + path, {
              method: body === undefined ? "GET" : "POST",
              headers,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
            {
              db: dbs.get(p.programId)!.db,
              profile: p,
              chain: dbs.get(p.programId)!.chain,
              verification: dbs.get(p.programId)!.provider,
              sources: sourcesFor(p),
              now: () => now,
              songs: async () => [{ songKey, title: "Fixture song" }],
            },
            context,
            new Headers(),
          ))!;
          return {
            status: response.status,
            body: (await response.json()) as any,
          };
        } catch (error) {
          if (error instanceof CommunityError)
            return { status: error.status, body: { error: error.code } };
          throw error;
        }
      }
      const offerFor = (p: RewardsProfile) => {
        const terms = rehearsalTerms(p)!;
        return {
          offerId: terms.offerId,
          drawingId: terms.drawingId,
          songKey,
          opensAt,
          cutoffAt,
          purchaseHash: terms.purchaseHash,
          ticketIds: terms.ticketIds,
        };
      };

      // Only the operator may attach; a learner session is refused.
      assert.equal(
        (
          await call(
            profile,
            0,
            "/api/operator/rewards/offers",
            offerFor(profile),
          )
        ).status,
        403,
      );
      // An explicit pin set must include the source the community publishes to now.
      const stale = await call(
        v4Only,
        "operator",
        "/api/operator/rewards/offers",
        {
          ...offerFor(v4Only),
          resultSources: [originalHash],
        },
      );
      assert.deepEqual(
        [stale.status, stale.body.error],
        [409, "reward_offer_sources_invalid"],
      );
      // Naming no sources pins every live source.
      const both = await call(
        profile,
        "operator",
        "/api/operator/rewards/offers",
        offerFor(profile),
      );
      assert.equal(both.status, 200);
      assert.deepEqual(both.body.resultSources, [originalHash, successorHash]);
      const only = await call(
        v4Only,
        "operator",
        "/api/operator/rewards/offers",
        {
          ...offerFor(v4Only),
          resultSources: [successorHash],
        },
      );
      assert.equal(only.status, 200);
      assert.deepEqual(only.body.resultSources, [successorHash]);
      const overview = await call(profile, "operator", "/api/operator/rewards");
      assert.deepEqual(overview.body.resultSources, {
        accepted: [originalHash, successorHash],
        current: successorHash,
      });

      // Real publications inside the window. A has qualifying results on both
      // contracts, the earlier on V4, plus a later repeat on V4; B is on V3
      // only and C on V4 only.
      const commitments = new Map<string, Hex>();
      async function publish(
        learner: typeof a,
        version: 3 | 4,
        lesson: string,
        offsetMs: number,
      ) {
        const fixture = studyResultFixture(undefined, opensAt + offsetMs);
        const grant = (version === 3 ? v3Grants : v4Grants).get(
          learner.address,
        )!;
        const { enrollment: _fixtureGrant, ...base } = fixture.input;
        const fields = {
          ...base,
          lessonId: lesson,
          learner: learner.address,
          qualificationPolicy: policy,
        };
        // V3 lessons publish under an enrollment window; V4 lessons under the
        // learner's open-ended sign-in authorization, as the application does.
        const bundle =
          version === 3
            ? completedStudyBundle({ ...fields, enrollment: grant })
            : studyFactsBundle({
                ...fields,
                terminal: terminalStudyFacts(fields),
                authorization: { id: grant.id, issuedAt: grant.issuedAt },
              });
        await evm.rpc("evm_setNextBlockTimestamp", [
          Number(bundle.result.completedAt) + 1,
        ]);
        await evm.rpc("evm_mine", []);
        const receipt = await evm.write(
          version === 3 ? v3 : v4,
          version === 3 ? "LearningResultsV3" : "LearningResultsV4",
          "publish",
          [bundle.result, bundle.outcomes],
          2,
        );
        assert.equal(receipt.status, "success");
        commitments.set(
          lesson,
          (await evm.read(
            version === 3 ? v3 : v4,
            version === 3 ? "LearningResultsV3" : "LearningResultsV4",
            "commitments",
            [bundle.result.sessionId],
          )) as Hex,
        );
        return bundle.result.completedAt;
      }
      const aFirst = await publish(a, 4, "lesson-a-v4-first", 5_000);
      await publish(b, 3, "lesson-b-v3", 60_000);
      await publish(c, 4, "lesson-c-v4", 90_000);
      await publish(a, 3, "lesson-a-v3-later", 200_000);
      await publish(a, 4, "lesson-a-v4-repeat", 300_000);

      // Past the cutoff, with enough confirmed blocks after it.
      await evm.rpc("evm_setNextBlockTimestamp", [
        Math.floor(cutoffAt / 1000) + 10,
      ]);
      await evm.rpc("anvil_mine", ["0x50", "0x1"]);
      now = cutoffAt + 20_000;

      const closed = await call(
        profile,
        "operator",
        `/api/operator/rewards/offers/${offerFor(profile).offerId}/close`,
        {},
      );
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      const entries = (closed.body.entries as any[]).map((e) => [
        e.accountId,
        e.evidenceHash,
        e.completedAt,
      ]);
      assert.deepEqual(entries, [
        [
          "learner_a",
          commitments.get("lesson-a-v4-first"),
          Number(aFirst) * 1000,
        ],
        ["learner_b", commitments.get("lesson-b-v3"), entries[1][2]],
        ["learner_c", commitments.get("lesson-c-v4"), entries[2][2]],
      ]);
      // The V4-only offer never reads V3: B is absent, A keeps their V4 result.
      const closedOnly = await call(
        v4Only,
        "operator",
        `/api/operator/rewards/offers/${offerFor(v4Only).offerId}/close`,
        {},
      );
      assert.equal(closedOnly.status, 200, JSON.stringify(closedOnly.body));
      assert.deepEqual(
        (closedOnly.body.entries as any[]).map((e) => [
          e.accountId,
          e.evidenceHash,
        ]),
        [
          ["learner_a", commitments.get("lesson-a-v4-first")],
          ["learner_c", commitments.get("lesson-c-v4")],
        ],
      );

      // Settlement credits each entered account once, and repeating it adds nothing.
      for (let i = 0; i < 2; i++) {
        const settled = await call(
          profile,
          "operator",
          `/api/operator/rewards/offers/${offerFor(profile).offerId}/settle`,
          {},
        );
        assert.equal(settled.status, 200, JSON.stringify(settled.body));
        assert.equal(settled.body.state, "settled");
      }
      const credits = await f.db
        .prepare(
          "SELECT account_id,COUNT(*) AS n FROM reward_credits WHERE program_id=? GROUP BY account_id ORDER BY account_id",
        )
        .bind(profile.programId)
        .all<{ account_id: string; n: number }>();
      assert.deepEqual(
        credits.results.map((r) => [r.account_id, r.n]),
        [
          ["learner_a", 1],
          ["learner_b", 1],
          ["learner_c", 1],
        ],
      );
      // Each learner sees exactly their own one credit.
      for (const i of [0, 1, 2]) {
        const mine = await call(profile, i, "/api/rewards/credits");
        assert.equal(mine.status, 200);
        assert.equal(mine.body.items.length, 1);
      }
    } finally {
      if (f) await f.dispose();
      if (g) await g.dispose();
      await stopChain(evm);
    }
  },
);
