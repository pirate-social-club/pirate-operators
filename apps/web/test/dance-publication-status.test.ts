
import assert from "node:assert/strict";
import test from "node:test";
import { createDanceClient, DancePublicationStatusError } from "../src/dance/client.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import type { DanceCapture } from "../src/dance/capture.ts";
import { danceTargetKey } from "../src/dance/source/ports.ts";
import { dancePublicationStatusVersion } from "../../../packages/dance/publication-status.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import { hash, scope, sha, simulatedSource } from "./dance-source-fixtures.ts";

test("publication resume observes the original and only proven absence permits its exact POST", async () => {
  const fixture = simulatedSource();
  const durable = simulatedCommandStorage();
  const captureId = hash(22), actionId = hash(23);
  const capture = {
    ...fixture.c, captureId, version: "pirate.dance/2", publication: { kind: "publication-bound" },
  } as unknown as DanceCapture;
  const calls: { method: string; path: string; body: unknown }[] = [];
  let mode: "offline" | "held" | "awaiting_publisher" | "malformed" | "retained_unsent" | "wrong_id" | "reverted" = "offline";
  let statusCode = 200;
  let requestId = "";
  const client = createDanceClient({
    communityId: scope.communityId, accountId: scope.accountId, csrf: "fixture_csrf", isCurrent: () => true,
    journal: durable.journal(),
    async fetcher(url, options) {
      const path = String(url), method = options?.method ?? "GET";
      calls.push({ method, path, body: options?.body });
      const response = (state: string) => ({ version: dancePublicationStatusVersion, requestId, actionId, state });
      if (method === "POST") return Response.json(response("retained_unsent"), { status: 202 });
      assert.equal(path, "/api/dance/reviews/" + captureId + "/submission-status?requestId=" + requestId);
      if (mode === "offline") return Response.json({ error: "native_dance_observation_unavailable" }, { status: 503 });
      if (mode === "malformed") return Response.json({ ...response("awaiting_publisher"), transactionHash: hash(24) });
      if (mode === "wrong_id") return Response.json({ ...response("retained_unsent"), actionId: hash(24) });
      return Response.json(response(mode), { status: statusCode });
    },
  });
  const prepared = await client.prepareSubmission!(danceTargetKey(scope), captureId, "media", hash(16));
  requestId = prepared.commandId;
  await durable.journal().markDispatch!(prepared);
  await fixture.seed({ capture, submission: "unknown", commands: { submit: prepared }, upload: {
    requestId: "fixture_upload", recordingSha256: sha(16), bytes: 4, mediaId: "media", put: "acknowledged", status: null,
  } });
  const controller = createDanceReviewController({ ...fixture.ports, client });
  const signal = new AbortController().signal;
  const refuses = (error: unknown) => error instanceof DancePublicationStatusError;
  await assert.rejects(controller.load(signal), error => refuses(error) && !error.publicationStatus);
  mode = "malformed";
  await assert.rejects(controller.load(signal), error => refuses(error) && !error.publicationStatus);
  mode = "awaiting_publisher";
  statusCode = 202;
  await assert.rejects(controller.load(signal), error => refuses(error) && !error.publicationStatus);
  assert.deepEqual(await client.retained!(), { ...prepared, attempted: true });
  statusCode = 200;
  mode = "held";
  await assert.rejects(controller.load(signal), error => refuses(error) && error.publicationStatus?.state === "held");
  assert.ok(calls.every(call => call.method === "GET"));
  assert.equal((await client.retained!())?.commandId, prepared.commandId);
  assert.equal((await client.retained!())?.receiptJson, undefined);

  mode = "awaiting_publisher";
  await assert.rejects(controller.load(signal), error => refuses(error) && error.publicationStatus?.state === "retained_unsent");
  assert.deepEqual(calls.filter(call => call.method === "POST").map(call => call.body), [prepared.requestJson]);
  assert.equal((await client.retained!())?.publicationStatus?.actionId, actionId);
  assert.equal((await client.retained!())?.retainedPublicationOriginal, true);

  for (const state of ["wrong_id", "awaiting_publisher", "reverted"] as const) {
    mode = state;
    await assert.rejects(controller.load(signal), refuses);
  }
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal((await client.retained!())?.publicationStatus?.state, "reverted");
  assert.equal((await client.retained!())?.receiptJson, undefined);
});

test("a malformed 202 or a legacy-shaped reply cannot acknowledge the authenticated publication original", async () => {
  for (const version of ["pirate.dance-action-status/2", "pirate.dance/1"]) {
    const durable = simulatedCommandStorage();
    const client = createDanceClient({
      communityId: scope.communityId, accountId: scope.accountId, csrf: "fixture_csrf", isCurrent: () => true,
      journal: durable.journal(),
      async fetcher(_url, options) {
        const original = JSON.parse(String(options?.body));
        return Response.json({
          version, commandId: original.commandId, reviewId: original.captureId,
          revision: 1, state: "awaiting_review", intentId: null,
        }, { status: version === "pirate.dance/1" ? 200 : 202 });
      },
    });
    const original = await client.prepareSubmission!(danceTargetKey(scope), hash(21), "media", hash(16), true);
    await assert.rejects(client.dispatchPrepared!(original), /dance_response_unknown/);
    const saved = await client.retained!();
    assert.equal(saved?.commandId, original.commandId);
    assert.equal(saved?.receiptJson, undefined);
    assert.equal(saved?.publicationStatus, undefined);
    assert.equal(saved?.attempted, true);
  }
});

test("an exact original legacy receipt stays compatible, while a wrong-version response cannot acknowledge it", async () => {
  for (const version of ["pirate.dance-action-status/2", "pirate.dance/1"]) {
    const durable = simulatedCommandStorage();
    const client = createDanceClient({
      communityId: scope.communityId, accountId: scope.accountId, csrf: "fixture_csrf", isCurrent: () => true,
      journal: durable.journal(),
      async fetcher(_url, options) {
        const requested = JSON.parse(String(options?.body));
        return Response.json({
          version, commandId: requested.commandId, reviewId: requested.captureId,
          revision: 1, state: "awaiting_review", intentId: null,
        }, { status: version === "pirate.dance/1" ? 200 : 202 });
      },
    });
    const original = await client.prepareSubmission!(danceTargetKey(scope), "legacy-capture", "media", hash(16));
    if (version === "pirate.dance/1") {
      await client.dispatchPrepared!(original);
      assert.equal((await client.retained!())?.receiptJson !== undefined, true);
    } else {
      await assert.rejects(client.dispatchPrepared!(original), /dance_response_unknown/);
      assert.equal((await client.retained!())?.receiptJson, undefined);
    }
  }
});
