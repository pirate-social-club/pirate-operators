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

const adapterIntent = (c: ReturnType<typeof captureFixture>, requestId = "original_media2") => ({
  requestId, songKey: c.songKey, songRevision: c.songRevision, recordingSha256: sha(16), bytes: 4,
  startSample: c.startSample, durationSamples: c.durationSamples,
  purpose: "private-review" as const, publicConsent: false,
});
function successorCapture(c: ReturnType<typeof captureFixture>) {
  const next = structuredClone(c); next.captureId = "successor_capture"; next.captureHash = hash(51);
  next.consent = { ...next.consent!, captureId: next.captureId, captureHash: next.captureHash };
  return next;
}
function adapterPause() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

test("Media2 actual adapter snapshots capture/envelope before CSRF and transport awaits", async () => {
  const capture = captureFixture(), original = structuredClone(capture), intent = adapterIntent(capture),
    originalBody = JSON.stringify(intent), pause = adapterPause();
  const sent: { url: string; body: BodyInit | null | undefined; headers: Headers; signal?: AbortSignal | null }[] = [];
  const port = createDancePrivateMediaPort({ scope, currentScope: () => scope, csrf: () => "fixture_csrf",
    maximumBytes: 1024,
    fetcher: (async (url, init) => {
      sent.push({ url: String(url), body: init?.body, headers: new Headers(init?.headers), signal: init?.signal });
      await pause.wait(); return Response.json(mediaFixture(original));
    }) as typeof fetch });
  const pending = port.reserve(capture, intent, new AbortController().signal);
  await pause.entered;
  Object.assign(capture, successorCapture(capture)); capture.reference!.revision++;
  intent.requestId = "mutated_request"; intent.recordingSha256 = sha(99); intent.songRevision++;
  pause.release(); await pending;
  assert.equal(sent.length, 1); assert.equal(sent[0]!.url, "/api/media");
  assert.equal(sent[0]!.headers.get("x-dance-capture-id"), original.captureId);
  assert.equal(sent[0]!.headers.get("x-dance-capture-hash"), original.captureHash);
  assert.equal(sent[0]!.headers.get("x-dance-account"), scope.accountId);
  assert.equal(sent[0]!.headers.get("x-csrf-token"), "fixture_csrf");
  assert.equal(sent[0]!.body, originalBody);
});

test("Media2 lost reserve ACK reuses exact witness/body; cross-capture and changed recording cannot relink request", async () => {
  const capture = captureFixture(), next = successorCapture(capture), intent = adapterIntent(capture);
  const sent: { url: string; body: BodyInit | null | undefined; headers: Headers }[] = [];
  let lose = true;
  const port = createDancePrivateMediaPort({ scope, currentScope: () => scope, csrf: () => "fixture_csrf",
    maximumBytes: 1024, fetcher: (async (url, init) => {
      sent.push({ url: String(url), body: init?.body, headers: new Headers(init?.headers) });
      if (lose) { lose = false; throw Error("simulated committed reserve response lost"); }
      return Response.json(mediaFixture(capture));
    }) as typeof fetch });
  await assert.rejects(port.reserve(capture, intent, new AbortController().signal), /response lost/);
  await assert.rejects(port.reserve(next, intent, new AbortController().signal), /target_changed/);
  await assert.rejects(port.reserve(capture, { ...intent, recordingSha256: sha(99) },
    new AbortController().signal), /target_changed/);
  assert.equal(sent.length, 1);
  const recovered = await port.reserve(structuredClone(capture), structuredClone(intent), new AbortController().signal);
  assert.equal(recovered.id, mediaFixture(capture).id);
  assert.equal(sent.length, 2); assert.equal(sent[0]!.body, sent[1]!.body);
  for (const item of sent) {
    assert.equal(item.headers.get("x-dance-capture-id"), capture.captureId);
    assert.equal(item.headers.get("x-dance-capture-hash"), capture.captureHash);
  }
  // A definite reserve response establishes a local exclusion guard. It does
  // not invent ownership for IDs restored after reload; the server rechecks.
  await assert.rejects(port.retry(next, recovered.id, new AbortController().signal), /target_changed/);
  await assert.rejects(port.status(next, recovered.id, new AbortController().signal), /target_changed/);
  assert.equal(sent.length, 2);
  await port.retry(capture, recovered.id, new AbortController().signal);
  assert.equal(sent[2]!.url, `/api/media/${recovered.id}/retry`);
});

test("Media2 same original File and cancellation reach source3; ignored abort cannot return a late ACK or relink capture", async () => {
  const capture = captureFixture(), intent = adapterIntent(capture), pause = adapterPause();
  let hold = false;
  const sent: { url: string; body: BodyInit | null | undefined; signal?: AbortSignal | null }[] = [];
  const port = createDancePrivateMediaPort({ scope, currentScope: () => scope, csrf: () => "fixture_csrf",
    maximumBytes: 1024, fetcher: (async (url, init) => {
      sent.push({ url: String(url), body: init?.body, signal: init?.signal });
      if (hold) await pause.wait(); // Deliberately ignores AbortSignal.
      return Response.json(mediaFixture(capture));
    }) as typeof fetch });
  const reserved = await port.reserve(capture, intent, new AbortController().signal);
  const file = new File([new Uint8Array([1, 2, 3, 4])], "original.webm", { type: "video/webm" });
  const controller = new AbortController(); hold = true;
  const upload = port.upload(capture, reserved.id, file, controller.signal);
  const rejected = assert.rejects(upload, error => error instanceof Error && error.name === "AbortError");
  await pause.entered; controller.abort();
  assert.equal(sent[1]!.body, file); assert.equal(sent[1]!.signal?.aborted, true);
  pause.release(); await rejected;
  hold = false;
  await assert.rejects(port.reserve(successorCapture(capture), intent, new AbortController().signal), /target_changed/);
  assert.equal(sent.length, 2);
  await port.status(capture, reserved.id, new AbortController().signal);
  assert.equal(sent[2]!.url, `/api/media/${reserved.id}`); // GET-only recovery, no extra PUT.
});

test("Media2 pre-abort and private account/session rotation prevent dispatch and late body acceptance", async () => {
  const capture = captureFixture(), intent = adapterIntent(capture), pause = adapterPause();
  let active = structuredClone(scope), calls = 0;
  const port = createDancePrivateMediaPort({ scope, currentScope: () => active, csrf: () => "fixture_csrf",
    maximumBytes: 1024, fetcher: (async () => {
      calls++; await pause.wait(); return Response.json(mediaFixture(capture));
    }) as typeof fetch });
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(port.reserve(capture, intent, canceled.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(calls, 0);
  const pending = port.reserve(capture, intent, new AbortController().signal);
  const denied = assert.rejects(pending, /dance_account_changed/);
  await pause.entered; active = { ...active, accountId: "different_private_account", sessionKey: "next_session" };
  pause.release(); await denied;
  await assert.rejects(port.reserve(successorCapture(capture), intent, new AbortController().signal), /dance_account_changed/);
  assert.equal(calls, 1);
});

test("Media2 ignored reserve abort keeps original request witness for explicit same-capture recovery", async () => {
  const capture = captureFixture(), intent = adapterIntent(capture), pause = adapterPause();
  const bodies: string[] = [], ids: (string | null)[] = [];
  let hold = true;
  const port = createDancePrivateMediaPort({ scope, currentScope: () => scope, csrf: () => "fixture_csrf",
    maximumBytes: 1024, fetcher: (async (_url, init) => {
      bodies.push(String(init?.body)); ids.push(new Headers(init?.headers).get("x-dance-capture-id"));
      if (hold) await pause.wait();
      return Response.json(mediaFixture(capture));
    }) as typeof fetch });
  const controller = new AbortController(), pending = port.reserve(capture, intent, controller.signal);
  const canceled = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  await pause.entered; controller.abort(); pause.release(); await canceled;
  await assert.rejects(port.reserve(successorCapture(capture), intent, new AbortController().signal), /target_changed/);
  assert.equal(bodies.length, 1);
  hold = false;
  await port.reserve(capture, intent, new AbortController().signal);
  assert.deepEqual(ids, [capture.captureId, capture.captureId]); assert.equal(bodies[0], bodies[1]);
});
