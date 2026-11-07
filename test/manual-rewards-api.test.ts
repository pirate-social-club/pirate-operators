import { test } from "node:test";
import assert from "node:assert/strict";
import { hashText, CommunityError } from "../packages/community/common.ts";
import { rewardsCommunityApi } from "../services/rewards-community-api.ts";
import {
  manualRewardsFixture,
  rewardHash,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";
import { rewardCutoffBlock } from "../services/reward-sources.ts";

test("actual account cookies, Origin and CSRF protect credits, verification intents and operator actions", async () => {
  const f = await manualRewardsFixture();
  try {
    const context = {
      communityId: rewardHash(700) as `0x${string}`,
      origin: "https://community.example",
    };
    const tokens = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    for (const [i, p] of f.principals.entries())
      await f.db
        .prepare(
          "INSERT INTO community_sessions(session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          hashText(tokens[i]),
          context.communityId,
          context.origin,
          p.accountId,
          `binding_${i}`,
          `csrf_${i}`,
          Date.now() + 1000000,
        )
        .run();
    const ports = {
      db: f.db,
      profile: rewardTestProfile,
      chain: f.chain,
      verification: f.provider,
      sources: f.sources,
      now: f.now,
      songs: async () => [{ songKey: rewardHash(500), title: "Fixture song" }],
    };
    async function call(
      who: number | undefined,
      path: string,
      method = "GET",
      body: unknown = {},
      csrf = true,
      origin = context.origin,
    ) {
      const headers = new Headers();
      if (who !== undefined)
        headers.set("cookie", `__Host-community_session=${tokens[who]}`);
      if (method !== "GET") {
        headers.set("origin", origin);
        headers.set("content-type", "application/json");
        if (csrf && who !== undefined)
          headers.set("x-csrf-token", `csrf_${who}`);
      }
      try {
        return (await rewardsCommunityApi(
          new Request(context.origin + path, {
            method,
            headers,
            ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
          }),
          ports,
          context,
          new Headers(),
        ))!;
      } catch (error) {
        if (error instanceof CommunityError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    }
    assert.equal((await call(undefined, "/api/rewards/credits")).status, 401);
    assert.equal((await call(0, "/api/operator/rewards")).status, 403);
    assert.equal(
      (
        await call(
          2,
          "/api/operator/rewards/participants",
          "POST",
          { wallet: f.principals[0].wallet },
          false,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          2,
          "/api/operator/rewards/participants",
          "POST",
          { wallet: f.principals[0].wallet },
          true,
          "https://other.example",
        )
      ).status,
      403,
    );
    for (const p of f.principals.slice(0, 2))
      assert.equal(
        (
          await call(2, "/api/operator/rewards/participants", "POST", {
            wallet: p.wallet,
          })
        ).status,
        200,
      );
    await f.settle("offer_0001", "1");
    const page = (await (
      await call(0, "/api/rewards/credits?limit=1")
    ).json()) as { items: { credit_id: string; claim: { status: string } }[] };
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].claim.status, "unclaimed");
    const path = `/api/rewards/credits/${page.items[0].credit_id}/claim`;
    assert.equal((await call(1, path, "POST")).status, 404);
    assert.equal((await call(0, path, "POST", {}, false)).status, 403);
    const intent = (await (
      await call(0, "/api/rewards/claim-verification-intents", "POST")
    ).json()) as { intent_id: string };
    assert.equal(
      (await call(1, `/api/rewards/verification-intents/${intent.intent_id}`))
        .status,
      404,
    );
    f.subjects.set("provider_1", "99");
    assert.equal(
      (
        await call(
          0,
          `/api/rewards/verification-intents/${intent.intent_id}/complete`,
          "POST",
        )
      ).status,
      200,
    );
    const accepted = (await (await call(0, path, "POST")).json()) as {
      outcome: string;
      credit: { paid_atomic: string; claim: { payout_status: string } };
    };
    assert.equal(accepted.outcome, "accepted");
    assert.equal(accepted.credit.paid_atomic, "0");
    assert.equal(accepted.credit.claim.payout_status, "awaiting_payment");
    const wallet = (await (await call(0, "/api/rewards/wallet")).json()) as {
      balanceAtomic: string;
      practiceOnly: boolean;
      drawings: { qualified: boolean }[];
    };
    assert.equal(wallet.balanceAtomic, "10000000");
    assert.equal(wallet.practiceOnly, true);
    assert.equal(wallet.drawings[0].qualified, true);
  } finally {
    await f.dispose();
  }
});

test("eligibility readback excludes publications after cutoff even when a lesson completed earlier", async () => {
  const block = await rewardCutoffBlock(
    1n,
    { number: 100n, timestamp: 100n },
    50000,
    async (number) => ({
      number,
      timestamp: number,
      hash: rewardHash(Number(number)) as `0x${string}`,
    }),
  );
  assert.equal(block.number, 49n);
  await assert.rejects(
    rewardCutoffBlock(
      1n,
      { number: 10n, timestamp: 10n },
      50000,
      async (number) => ({
        number,
        timestamp: number,
        hash: rewardHash(1) as `0x${string}`,
      }),
    ),
    /reward_cutoff_not_confirmed/,
  );
});
