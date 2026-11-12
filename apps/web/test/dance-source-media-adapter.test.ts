/** UNRUN. Actual source3-client adapter, intercepted HTTP, no server/provider. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDancePrivateMediaPort } from "../src/dance/source/media-adapter.ts";
import { DanceClientError } from "../src/dance/client.ts";
import {
  captureFixture,
  scope,
  hash,
  sha,
  mediaFixture,
  simulatedCanonicalReview,
} from "./dance-source-fixtures.ts";
import {
  assertDanceReview,
  danceResultPresentation,
} from "../src/dance/source/dance-review-api.ts";
test("uses existing media route with original request ID/private purpose and exact account/CSRF; no second pipeline", async () => {
  const c = captureFixture(),
    sent: { url: string; body: string }[] = [];
  const port = createDancePrivateMediaPort({
    scope,
    currentScope: () => scope,
    csrf: () => "fixture_csrf",
    maximumBytes: 32 * 1024 * 1024,
    fetcher: (async (url, init) => {
      assert.equal(init?.credentials, "same-origin");
      assert.equal(
        new Headers(init?.headers).get("x-dance-account"),
        scope.accountId,
      );
      assert.equal(
        new Headers(init?.headers).get("x-csrf-token"),
        "fixture_csrf",
      );
      sent.push({ url: String(url), body: String(init?.body) });
      return Response.json(mediaFixture(c));
    }) as typeof fetch,
  });
  const intent = {
    requestId: "immutable_original",
    songKey: c.songKey,
    songRevision: c.songRevision,
    recordingSha256: sha(16),
    bytes: 4,
    startSample: c.startSample,
    durationSamples: c.durationSamples,
    purpose: "private-review" as const,
    publicConsent: false,
  };
  await port.reserve(c, intent, new AbortController().signal);
  assert.equal(sent[0]!.url, "/api/media");
  assert.deepEqual(JSON.parse(sent[0]!.body), intent);
  await assert.rejects(
    port.reserve(
      c,
      { ...intent, publicConsent: true },
      new AbortController().signal,
    ),
  );
  assert.equal(sent.length, 1);
});
for (const status of [401, 403])
  test(`source3 plain-text ${status} propagates authoritative private denial`, async () => {
    const c = captureFixture();
    const port = createDancePrivateMediaPort({
      scope,
      currentScope: () => scope,
      csrf: () => "fixture_csrf",
      maximumBytes: 32 * 1024 * 1024,
      fetcher: (async () => new Response("denied", { status })) as typeof fetch,
    });
    await assert.rejects(
      port.status(c, "media", new AbortController().signal),
      (e) => e instanceof DanceClientError && e.status === status,
    );
  });
test("passed/not-passed presentations require separate canonical evidence, and mismatched source provenance refuses", () => {
  for (const verdict of ["pass", "not_passed"] as const) {
    const r = simulatedCanonicalReview(captureFixture(), verdict);
    assertDanceReview(r, scope);
    assert.equal(
      danceResultPresentation({ kind: "review", state: r.state, review: r })
        .title,
      verdict === "pass" ? "Passed" : "Not passed",
    );
    r.canonical = null;
    r.state = "decision_pending";
    assert.equal(
      danceResultPresentation({ kind: "review", state: r.state, review: r })
        .title,
      "Decision pending",
    );
  }
  const wrong = simulatedCanonicalReview(captureFixture(), "pass");
  wrong.canonical = {
    ...wrong.canonical!,
    source: { ...wrong.capture.source, runtimeCodeHash: hash(99) },
  };
  assert.throws(() => assertDanceReview(wrong, scope), /projection_invalid/);
});
