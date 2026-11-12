import { test } from "node:test";
import assert from "node:assert/strict";
import { rewardsData, walletSendData } from "../src/live/rewards-data.ts";

test("retrying prepare/dispatch retains server idempotency identity and never posts a client balance or claim amount", async (t) => {
  const requests: { path: string; body: unknown; key: string | null }[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(headers.get("x-csrf-token"), "fixture-csrf");
    requests.push({
      path: String(input),
      body: JSON.parse(String(init?.body)),
      key: headers.get("idempotency-key"),
    });
    return Response.json({});
  };
  const adapter = walletSendData("fixture-csrf");
  const quote = { quoteId: "quote_001" } as Parameters<
    typeof adapter.prepare
  >[0];
  await adapter.prepare(quote);
  await adapter.prepare(quote);
  await adapter.begin("send_0001", "attempt_001");
  await adapter.begin("send_0001", "attempt_001");
  assert.deepEqual(
    requests.slice(0, 2),
    Array(2).fill({
      path: "/api/rewards/sends",
      body: { quoteId: "quote_001" },
      key: "quote_001",
    }),
  );
  assert.deepEqual(
    requests.slice(2),
    Array(2).fill({
      path: "/api/rewards/sends/send_0001/dispatch",
      body: { action: "pay", attemptId: "attempt_001" },
      key: "attempt_001",
    }),
  );
});

test("a changing paginated credit list refuses duplicate accounting instead of doubling pending rewards", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let pages = 0;
  globalThis.fetch = async () =>
    Response.json({
      object: "reward_credit_list",
      accountId: "11111111-1111-4111-8111-111111111111",
      items: [
        {
          credit_id: "credit_0001",
          account_id: "11111111-1111-4111-8111-111111111111",
          offer_id: "offer_0001",
          chain_id: 6343,
          token_address: "0x" + "33".repeat(20),
          token_decimals: 18,
          amount_atomic: "30000000000000000",
          paid_atomic: "0",
          payment_id: null,
          claim: { status: "unclaimed", payout_status: "awaiting_payment" },
        },
      ],
      next_cursor: pages++ === 0 ? "page_two" : null,
    });
  await assert.rejects(
    rewardsData("fixture-csrf").credits("11111111-1111-4111-8111-111111111111"),
    /reward list changed/,
  );
  assert.equal(pages, 2);
});
