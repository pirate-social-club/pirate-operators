import test from "node:test";
import assert from "node:assert/strict";
import { createDanceClient } from "../apps/web/src/dance/client.ts";
import { danceStatus } from "../apps/web/src/dance/presentation.ts";
import type { DanceReview } from "../packages/dance/contracts.ts";

test("client retries identical command after unknown response and sends current-account fence", async () => {
  const bodies: string[] = [],
    headers: Headers[] = [];
  const client = createDanceClient({
    accountId: "learner",
    csrf: "csrf_fixture",
    isCurrent: () => true,
    fetcher: async (_input, init) => {
      bodies.push(String(init?.body));
      headers.push(new Headers(init?.headers));
      if (bodies.length === 1)
        throw Error("fixture connection lost after commit");
      return Response.json({ reviewId: "review_1" });
    },
  });
  await assert.rejects(
    client.decide("review_1", 1, "passed"),
    /dance_response_unknown/,
  );
  await client.decide("review_1", 1, "passed");
  assert.equal(bodies[0], bodies[1]);
  assert.equal(headers[0].get("x-dance-account"), "learner");
  assert.equal(headers[0].get("x-csrf-token"), "csrf_fixture");
  client.dispose();
  await assert.rejects(client.get("review_1"), /dance_account_changed/);
});

test("client discards a successful private result after account change", async () => {
  let current = true;
  const client = createDanceClient({
    accountId: "learner",
    csrf: "csrf_fixture",
    isCurrent: () => current,
    fetcher: async () => {
      current = false;
      return Response.json({ private: "must not appear" });
    },
  });
  await assert.rejects(client.get("review_1"), /dance_account_changed/);
});

test("a new recording reserves fresh capture terms after a completed reservation", async () => {
  const commands: string[] = [];
  const client = createDanceClient({
    accountId: "learner",
    csrf: "fixture",
    isCurrent: () => true,
    fetcher: async (_url, init) => {
      commands.push(JSON.parse(String(init?.body)).commandId);
      return Response.json({ captureId: `capture_${commands.length}` });
    },
  });
  await client.capture("song", null, null);
  await client.capture("song", null, null);
  assert.notEqual(commands[0], commands[1]);
});

test("a visible approved performance accurately explains no eligible reward", () => {
  const review = {
    state: "reviewed",
    verdict: { verdict: "passed", rewardReason: "outside_window" },
  } as DanceReview;
  assert.equal(danceStatus(review).title, "Passed");
  assert.match(danceStatus(review).detail, /no eligible reward/);
  const held = {
    ...review,
    verdict: { ...review.verdict!, rewardReason: "candidate_held" as const },
  };
  assert.match(danceStatus(held).detail, /No payout is available/);
});
