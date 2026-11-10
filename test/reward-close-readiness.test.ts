import { test } from "node:test";
import assert from "node:assert/strict";
import { hashText } from "../packages/community/common.ts";
import { confirmedRewardTimestamp } from "../services/reward-close-clock.ts";
import { rewardsCommunityApi } from "../services/rewards-community-api.ts";
import {
  manualRewardsFixture,
  rewardHash,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";

test("the close clock checks its chain and safely converts canonical seconds", async () => {
  let reads = 0;
  const clock = {
    chainId: async () => 6343,
    safeTimestampSeconds: async () => {
      reads++;
      return 1794070800n;
    },
  };
  assert.equal(await confirmedRewardTimestamp(clock, 6343), 1794070800000);
  await assert.rejects(
    confirmedRewardTimestamp({ ...clock, chainId: async () => 1 }, 6343),
    /wrong_reward_close_chain/,
  );
  assert.equal(reads, 1);
  for (const timestamp of [-1n, BigInt(Number.MAX_SAFE_INTEGER)]) {
    await assert.rejects(
      confirmedRewardTimestamp(
        { ...clock, safeTimestampSeconds: async () => timestamp },
        6343,
      ),
      /invalid_reward_close_clock/,
    );
  }
});

test("operator readiness waits for safe confirmation and preserves the page when reads fail", async () => {
  const f = await manualRewardsFixture();
  try {
    const context = {
      communityId: rewardHash(700) as `0x${string}`,
      origin: "https://community.example",
    };
    const token = "d".repeat(64);
    await f.db
      .prepare(
        "INSERT INTO community_sessions(session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        hashText(token),
        context.communityId,
        context.origin,
        f.principals[2].accountId,
        "binding_2",
        "fixture_csrf",
        Date.now() + 600000,
      )
      .run();
    const offer = await f.offer("close_offer_001", "8101");
    let calls = 0;
    let safe = offer.cutoffAt - 1;
    let fail = false;
    async function overview(withClock = true) {
      const response = await rewardsCommunityApi(
        new Request(context.origin + "/api/operator/rewards", {
          headers: { cookie: `__Host-community_session=${token}` },
        }),
        {
          db: f.db,
          profile: rewardTestProfile,
          chain: f.chain,
          verification: f.provider,
          sources: f.sources,
          now: f.now,
          ...(withClock
            ? {
                confirmedCutoffTimestamp: async () => {
                  calls++;
                  if (fail) throw Error("fixture RPC unavailable");
                  return safe;
                },
              }
            : {}),
        },
        context,
        new Headers(),
      );
      assert.equal(response!.status, 200);
      return (await response!.json()) as {
        offers: unknown[];
        liabilities: { total: string };
        closeReadiness: {
          checkedAt: number;
          offers: Record<
            string,
            { state: string; confirmedTimestamp?: number }
          >;
        };
      };
    }
    f.setNow(offer.cutoffAt - 1);
    assert.equal(
      (await overview()).closeReadiness.offers[offer.offerId].state,
      "before_cutoff",
    );
    assert.equal(calls, 0);
    f.setNow(offer.cutoffAt);
    assert.equal(
      (await overview()).closeReadiness.offers[offer.offerId].state,
      "awaiting_confirmation",
    );
    safe = offer.cutoffAt;
    assert.equal(
      (await overview()).closeReadiness.offers[offer.offerId].state,
      "ready",
    );
    fail = true;
    const unavailable = await overview();
    assert.equal(
      unavailable.closeReadiness.offers[offer.offerId].state,
      "unavailable",
    );
    assert.equal(unavailable.offers.length, 1);
    assert.equal(unavailable.liabilities.total, "0");
    assert.equal(
      (await overview(false)).closeReadiness.offers[offer.offerId].state,
      "unavailable",
    );
    fail = false;
    safe = Number.NaN;
    assert.equal(
      (await overview()).closeReadiness.offers[offer.offerId].state,
      "unavailable",
    );
  } finally {
    await f.dispose();
  }
});
