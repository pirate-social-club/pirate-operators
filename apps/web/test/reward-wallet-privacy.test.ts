// Prepared only. Actual HTTP adapter/summary, native Response and deferred JSON bodies.
import test from "node:test";
import assert from "node:assert/strict";
import { get, post, CommunityRequestError } from "../src/live/api.ts";
import { rewardsData } from "../src/live/rewards-data.ts";
import { rewardSummary } from "../src/wallet/reward-status.ts";
import type { RewardWalletView } from "../../../packages/rewards/contracts.ts";
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const wallet = {
  schema: "pirate.learner-wallet/1",
  accountId: a,
  address: "0x" + "11".repeat(20),
  chainId: 6343,
  token: "0x" + "33".repeat(20),
  decimals: 18,
  balanceAtomic: "30000000000000000",
  operator: false,
  practiceOnly: true,
  drawings: [],
} satisfies RewardWalletView & { accountId: string };
const credit = (owner: string, id: string) => ({
  credit_id: id,
  offer_id: "offer_0001",
  account_id: owner,
  chain_id: 6343 as const,
  token_address: wallet.token,
  token_decimals: 18,
  amount_atomic: "30000000000000000",
  paid_atomic: "0",
  payment_id: null,
  claim: {
    status: "unclaimed" as const,
    payout_status: "awaiting_payment" as const,
  },
});
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
for (const status of [401, 403])
  for (const method of ["GET", "POST"]) {
    test(
      `wallet ${method} typed ${status} rejects at headers without decoding held JSON`,
      { timeout: 1000 },
      async (t) => {
        let reads = 0;
        const body = held<unknown>();
        const response = new Response(null, { status });
        response.json = () => {
          reads++;
          return body.promise;
        };
        t.mock.method(globalThis, "fetch", async () => response);
        await assert.rejects(
          method === "GET"
            ? get("/api/rewards/wallet")
            : post(
                "/api/rewards/verification-intents/intent_0001/complete",
                {},
                "session-a",
              ),
          (error: unknown) =>
            error instanceof CommunityRequestError && error.status === status,
        );
        assert.equal(reads, 0);
        body.resolve({ error: "session_required" });
      },
    );
  }
test("a held A page followed by same-currency distinct B rows fails closed instead of blending", async (t) => {
  const body = held<unknown>();
  let pages = 0,
    reads = 0;
  const first = new Response();
  first.json = () => {
    reads++;
    return body.promise;
  };
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-csrf-token"), "session-a");
    assert.equal(headers.get("x-pirate-reward-owner"), a);
    return pages++ === 0
      ? first
      : Response.json({
          object: "reward_credit_list",
          accountId: b,
          items: [credit(b, "credit_b002")],
          next_cursor: null,
        });
  });
  const pending = rewardsData("session-a").credits(a);
  await Promise.resolve();
  assert.equal(reads, 1);
  body.resolve({
    object: "reward_credit_list",
    accountId: a,
    items: [credit(a, "credit_a001")],
    next_cursor: "credit_a001",
  });
  await assert.rejects(pending, /account could not be confirmed/);
  assert.equal(pages, 2);
});
test("a cancelled or replaced read generation stops pagination before another HTTP request", async (t) => {
  for (const mode of ["cancel", "replace"]) {
    const body = held<unknown>();
    const abort = new AbortController();
    let current = true,
      pages = 0;
    const response = new Response();
    response.json = () => body.promise;
    t.mock.method(globalThis, "fetch", async () => {
      pages++;
      return response;
    });
    const pending = rewardsData("session-a").credits(a, {
      signal: abort.signal,
      current: () => current,
    });
    await Promise.resolve();
    if (mode === "cancel") abort.abort();
    else current = false;
    body.resolve({
      object: "reward_credit_list",
      accountId: a,
      items: [credit(a, "credit_a001")],
      next_cursor: "credit_a001",
    });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(pages, 1);
    t.mock.restoreAll();
  }
});
test("page envelope, each row and summary consumption require the genuine private UUID", async (t) => {
  for (const page of [
    { items: [credit(a, "credit_0001")] },
    { accountId: a, items: [credit(b, "credit_0002")] },
    { accountId: wallet.address, items: [] },
  ]) {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        object: "reward_credit_list",
        next_cursor: null,
        ...page,
      }),
    );
    await assert.rejects(
      rewardsData("session-a").credits(a),
      /account could not be confirmed/,
    );
    t.mock.restoreAll();
  }
  assert.throws(
    () => rewardSummary(wallet, [credit(b, "credit_b001")]),
    /account could not be confirmed/,
  );
  assert.throws(
    () =>
      rewardSummary(
        { ...wallet, accountId: undefined } as unknown as RewardWalletView,
        [],
      ),
    /account could not be confirmed/,
  );
  await assert.rejects(
    rewardsData("session-a").credits(),
    /account could not be confirmed/,
  );
});
test("current-owner multipage results preserve exact amounts and duplicate/cursor bounds", async (t) => {
  let pages = 0;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      object: "reward_credit_list",
      accountId: a,
      items: [credit(a, pages === 0 ? "credit_0001" : "credit_0002")],
      next_cursor: pages++ === 0 ? "credit_0001" : null,
    }),
  );
  const rows = await rewardsData("session-a").credits(a);
  assert.equal(rows.length, 2);
  assert.equal(rewardSummary(wallet, rows).pending, "60000000000000000");
  assert.equal(wallet.balanceAtomic, "30000000000000000");
});
test("ordinary 503 keeps the existing decoded retry path and is not an auth verdict", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
  );
  await assert.rejects(get("/api/rewards/wallet"), /temporarily unavailable/);
  await assert.rejects(
    post("/api/rewards/credits/credit_0001/claim", {}, "session-a"),
    (error: unknown) =>
      error instanceof CommunityRequestError &&
      error.status === 503 &&
      error.code === "temporarily_unavailable",
  );
});
