/** UNRUN. Actual client + production journal operations + original controllers.
 * Only transport, transaction persistence/lifetime and media authority ports are
 * named simulations. These cases do not establish native/runtime acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDanceClient,
  DanceClientError,
  privateAccessLost,
} from "../src/dance/client.ts";
import {
  sameOriginalCommand,
  type DanceJournalEntry,
} from "../src/dance/journal.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import {
  createDanceRecordingController,
  danceRecordingDigest,
} from "../src/dance/source/dance-recording.ts";
import { danceTargetKey, type DanceScope } from "../src/dance/source/ports.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import {
  simulatedSource,
  simulatedRecordingStorage,
  captureFixture,
  reviewFixture,
  simulatedCanonicalReview,
  mediaFixture,
  scope,
  consent,
  sha,
  hash,
} from "./dance-source-fixtures.ts";
const signal = () => new AbortController().signal;
const acceptedConsent = {
  accepted: true as const,
  version: consent.version,
  termsHash: consent.termsHash,
  publicityPolicyHash: consent.publicityPolicyHash,
};
const upload = {
  requestId: "original_media_request",
  recordingSha256: sha(16),
  bytes: 4,
  mediaId: "media",
  put: "acknowledged" as const,
  status: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function actualClientSimulation() {
  const f = simulatedSource(),
    durable = simulatedCommandStorage();
  const requests: { path: string; body: string | null }[] = [];
  const reviews = new Map([[f.c.captureId, reviewFixture(f.c)]]);
  let active = true,
    chosenCapture = f.c;
  const transport = {
    reply: async (path: string, init?: RequestInit): Promise<Response> => {
      if (!init?.method) {
        const id = decodeURIComponent(path.split("/").at(-1)!);
        return Response.json(reviews.get(id));
      }
      const b = JSON.parse(String(init.body));
      if (path.endsWith("/captures")) {
        chosenCapture.consent = {
          ...chosenCapture.consent!,
          receiptId: b.commandId,
        };
        return Response.json(chosenCapture);
      }
      return Response.json({
        version: "pirate.dance/1",
        commandId: b.commandId,
        reviewId: b.captureId ?? decodeURIComponent(path.split("/").at(-2)!),
        revision: 1,
        state: path.endsWith("/withdraw")
          ? "withdrawal_pending"
          : "awaiting_review",
        intentId: null,
      });
    },
  };
  const makeClient = () =>
    createDanceClient({
      communityId: scope.communityId,
      accountId: scope.accountId,
      csrf: "simulated_fresh_csrf",
      isCurrent: () => active,
      journal: durable.journal(),
      fetcher: (async (url, init) => {
        const path = String(url);
        requests.push({ path, body: init?.body ? String(init.body) : null });
        return transport.reply(path, init);
      }) as typeof fetch,
    });
  const client = makeClient();
  const ports = { ...f.ports, client };
  return {
    f,
    ports,
    client,
    durable,
    requests,
    reviews,
    transport,
    makeClient,
    lifetime: (value: boolean) => {
      active = value;
    },
    choose: (c: typeof f.c) => {
      chosenCapture = c;
    },
  };
}

for (const submittedB of [false, true])
  test(`explicit A never reads or acts on retained ${submittedB ? "submitted" : "local"} B`, async () => {
    const x = actualClientSimulation(),
      b = x.f.c,
      a = captureFixture();
    a.captureId = "review_A";
    a.captureHash = hash(71);
    a.consent = {
      ...a.consent!,
      captureId: a.captureId,
      captureHash: a.captureHash,
    };
    x.reviews.set(a.captureId, reviewFixture(a));
    await x.f.seed({ upload, submission: submittedB ? "accepted" : "none" });
    const controller = createDanceReviewController({
      ...x.ports,
      reviewId: a.captureId,
    });
    const view = await controller.observe(signal());
    assert.equal(view.result.kind, "review");
    if (view.result.kind !== "review") throw Error("expected A");
    assert.equal(view.result.review.reviewId, a.captureId);
    await assert.rejects(
      controller.act(view.result, { operation: "submit" }, signal()),
    );
    const receipt = await controller.act(
      view.result,
      { operation: "withdraw" },
      signal(),
    );
    assert.equal(receipt.receipt?.reviewId, a.captureId);
    assert.equal(
      x.requests.some(
        (r) =>
          r.path.includes(b.captureId) ||
          r.body?.includes('"captureId":"capture"'),
      ),
      false,
    );
    assert.equal(
      (await x.f.journey.store.read(scope, () => {})).capture?.captureId,
      b.captureId,
    );
  });
test("explicit A rejects returned B, forged action B and unrelated outstanding recovery without sending B", async () => {
  const x = actualClientSimulation();
  await x.f.seed({ upload });
  x.reviews.set("A", reviewFixture(x.f.c));
  const c = createDanceReviewController({ ...x.ports, reviewId: "A" });
  await assert.rejects(c.observe(signal()), /target_mismatch|route_mismatch/);
  await assert.rejects(
    c.act(
      {
        kind: "review",
        state: "awaiting_review",
        review: reviewFixture(x.f.c),
      },
      { operation: "withdraw" },
      signal(),
    ),
    /route_mismatch/,
  );
  const original = await x.client.prepareSubmission!(
    danceTargetKey(scope),
    x.f.c.captureId,
    "media",
    hash(16),
  );
  const before = x.requests.length;
  await assert.rejects(c.load(signal()), /other_original_pending/);
  assert.equal(x.requests.length, before);
  assert.equal((await x.client.retained!())?.commandId, original.commandId);
});

for (const revisionOnly of [false, true])
  test(`safely completed A retires for deliberate ${revisionOnly ? "new immutable revision" : "different target"} B`, async () => {
    const x = actualClientSimulation();
    await createDancePreparationController(x.ports).start(
      consent.termsHash,
      signal(),
    );
    const original = await x.client.acceptedCapture!();
    assert.ok(original);
    x.reviews.set(
      x.f.c.captureId,
      simulatedCanonicalReview(x.f.c, "not_passed"),
    );
    const target: DanceScope = {
      ...scope,
      songKey: revisionOnly ? scope.songKey : hash(80),
      songRevision: revisionOnly ? scope.songRevision + 1 : scope.songRevision,
    };
    const b = captureFixture();
    b.captureId = "new_B";
    b.songKey = target.songKey;
    b.songRevision = target.songRevision;
    b.captureHash = hash(81);
    b.consent = {
      ...b.consent!,
      captureId: b.captureId,
      captureHash: b.captureHash,
    };
    x.choose(b);
    const ports = { ...x.ports, scope: target, currentScope: () => target };
    const p = createDancePreparationController(ports);
    assert.equal(
      (await p.prepare(consent.termsHash, signal())).kind,
      "objectives",
    );
    assert.equal(
      (await x.f.journey.store.read(target, () => {})).captureUnknown,
      false,
    );
    const result = await p.start(consent.termsHash, signal());
    assert.equal(result.session?.session_id, b.captureId);
    assert.notEqual(
      (await x.client.acceptedCapture!())?.commandId,
      original.commandId,
    );
    assert.equal(
      (await x.client.command!(original.commandId))?.receiptJson,
      original.receiptJson,
    );
  });
test("B cannot clear active, uncertain or non-safe A to free the constant capture subject", async () => {
  for (const phase of [
    "prepared",
    "accepted_pending",
    "reorg",
    "removed",
  ] as const) {
    const x = actualClientSimulation(),
      a = await x.client.prepareCapture!(
        danceTargetKey(scope),
        scope.songKey,
        scope.offerId,
        scope.reference!.id,
        acceptedConsent,
      );
    if (phase !== "prepared") await x.client.dispatchPrepared!(a);
    if (phase === "reorg" || phase === "removed") {
      const r = simulatedCanonicalReview(x.f.c, "pass");
      r.canonical!.canonical = false;
      if (phase === "removed") Object.assign(r.canonical!, { removed: true });
      x.reviews.set(x.f.c.captureId, r);
    }
    const target = { ...scope, songKey: hash(90) },
      p = createDancePreparationController({
        ...x.ports,
        scope: target,
        currentScope: () => target,
      });
    await assert.rejects(p.start(consent.termsHash, signal()));
    assert.equal(
      (await x.f.journey.store.read(target, () => {})).captureUnknown,
      false,
    );
    assert.equal(
      (await x.client.command!(a.commandId))?.commandId,
      a.commandId,
    );
    assert.equal(
      x.requests.filter((r) => r.path.endsWith("captures") && r.body).length,
      phase === "prepared" ? 0 : 1,
    );
  }
});

for (const kind of ["capture", "submit"] as const) {
  for (const boundary of [
    "command_rollback",
    "command_commit_ack_lost",
    "journey_rollback",
    "journey_commit_lifetime_loss",
    "dispatch_lifetime_loss",
    "dispatch_admission_rollback",
    "dispatch_admission_ack_lost",
    "http_ack_lost",
    "receipt_rollback",
    "receipt_commit_ack_lost",
    "receipt_commit_lifetime_loss",
    "journey_receipt_rollback",
    "journey_receipt_lifetime_loss",
    "ack_rollback",
    "ack_commit_lifetime_loss",
  ] as const) {
    test(`${kind}: ${boundary} recovers exact durable original without automatic replacement/replay`, async () => {
      const x = actualClientSimulation();
      if (kind === "submit") await x.f.seed({ upload });
      const oldStore = x.f.journey.store,
        plainExclusive = oldStore.exclusive.bind(oldStore);
      let armed = true,
        chosen: DanceJournalEntry | null = null;
      const fail = () => {
        if (armed) {
          armed = false;
          throw Error("simulated_boundary_loss");
        }
      };
      if (boundary === "command_rollback")
        x.durable.boundary.beforeCommit = fail;
      if (boundary === "command_commit_ack_lost")
        x.durable.boundary.afterCommit = fail;
      if (boundary.startsWith("journey_"))
        oldStore.exclusive = (s, guard, use) =>
          plainExclusive(s, guard, (h) =>
            use({
              ...h,
              save: async (patch) => {
                const uncertainty =
                  patch.captureUnknown === true ||
                  patch.submission === "unknown";
                const accepted =
                  (patch.captureUnknown === false && !!patch.capture) ||
                  patch.submission === "accepted";
                if (boundary === "journey_rollback" && uncertainty) fail();
                if (boundary === "journey_receipt_rollback" && accepted) fail();
                const saved = await h.save(patch);
                if (
                  boundary === "journey_commit_lifetime_loss" &&
                  uncertainty &&
                  armed
                ) {
                  armed = false;
                  x.lifetime(false);
                  x.f.setScope(null);
                  guard();
                }
                if (
                  boundary === "journey_receipt_lifetime_loss" &&
                  accepted &&
                  armed
                ) {
                  armed = false;
                  x.lifetime(false);
                  x.f.setScope(null);
                  guard();
                }
                return saved;
              },
            }),
          );
      // Production operations remain real. Hook only the durable commit boundary
      // after the preparation and journey transactions have completed.
      const dispatch = x.client.dispatchPrepared!.bind(x.client);
      x.client.dispatchPrepared = async (e, sig) => {
        chosen = structuredClone(e);
        if (boundary === "dispatch_lifetime_loss" && armed) {
          armed = false;
          x.lifetime(false);
          x.f.setScope(null);
        }
        if (boundary === "dispatch_admission_rollback")
          x.durable.boundary.beforeCommit = fail;
        if (boundary === "dispatch_admission_ack_lost")
          x.durable.boundary.afterCommit = fail;
        return dispatch(e, sig);
      };
      const reply = x.transport.reply;
      x.transport.reply = async (path, init) => {
        const response = await reply(path, init);
        if (init?.method) {
          if (boundary === "http_ack_lost") fail();
          if (boundary === "receipt_rollback")
            x.durable.boundary.beforeCommit = fail;
          if (boundary === "receipt_commit_ack_lost")
            x.durable.boundary.afterCommit = fail;
          if (boundary === "receipt_commit_lifetime_loss")
            x.durable.boundary.afterCommit = () => {
              if (armed) {
                armed = false;
                x.lifetime(false);
                x.f.setScope(null);
              }
            };
        }
        return response;
      };
      if (boundary === "ack_rollback") {
        const ack = x.client.acknowledgeRecovery.bind(x.client);
        x.client.acknowledgeRecovery = async (id) => {
          fail();
          return ack(id);
        };
      }
      if (boundary === "ack_commit_lifetime_loss") {
        const ack = x.client.acknowledgeRecovery.bind(x.client);
        x.client.acknowledgeRecovery = async (id) => {
          x.durable.boundary.afterCommit = () => {
            if (armed) {
              armed = false;
              x.lifetime(false);
              x.f.setScope(null);
            }
          };
          return ack(id);
        };
      }
      const perform = async () => {
        if (kind === "capture")
          return createDancePreparationController(x.ports).start(
            consent.termsHash,
            signal(),
          );
        const c = createDanceReviewController(x.ports),
          view = await c.observe(signal());
        return c.act(view.result, { operation: "submit" }, signal());
      };
      await assert.rejects(perform());
      x.durable.boundary.beforeCommit = () => {};
      x.durable.boundary.afterCommit = () => {};
      armed = false;
      x.lifetime(true);
      x.f.setScope(scope);
      oldStore.exclusive = plainExclusive;
      const reload = x.makeClient(),
        entry = await oldStore.read(scope, () => {});
      const original =
        (await reload.retained!()) ??
        (kind === "capture"
          ? await reload.acceptedCapture!()
          : entry.commands?.submit
            ? await reload.command!(entry.commands.submit.commandId)
            : null);
      if (boundary === "command_rollback") {
        assert.equal(original, null);
        assert.equal(entry.captureUnknown, false);
        assert.equal(entry.submission, "none");
        assert.equal(
          x.requests.some((r) => r.body),
          false,
        );
        return;
      }
      assert.ok(original);
      chosen ??= original;
      assert.equal(sameOriginalCommand(original, chosen), true);
      assert.ok(original.requestJson);
      assert.equal(
        JSON.parse(original.requestJson).commandId,
        original.commandId,
      );
      const before = x.requests.filter((r) => r.body).length;
      const ports = { ...x.ports, client: reload };
      try {
        if (kind === "capture")
          await createDancePreparationController(ports).prepare(
            consent.termsHash,
            signal(),
          );
        else await createDanceReviewController(ports).observe(signal());
      } catch {
        /* Read-only hold is expected for uncertainty. */
      }
      assert.equal(
        x.requests.filter((r) => r.body).length,
        before,
        "loading replayed an original automatically",
      );
      if (kind === "capture")
        await createDancePreparationController(ports).recover(
          consent.termsHash,
          signal(),
        );
      else await createDanceReviewController(ports).load(signal());
      const sent = x.requests.filter((r) => r.body).map((r) => r.body);
      assert.equal(
        sent.every((body) => body === original.requestJson),
        true,
      );
      assert.equal(
        (await reload.command!(original.commandId))?.commandId,
        original.commandId,
      );
      assert.equal(
        (await oldStore.read(scope, () => {})).captureUnknown,
        false,
      );
      if (kind === "submit")
        assert.equal(
          (await oldStore.read(scope, () => {})).submission,
          "accepted",
        );
    });
  }
}

test("accepted recovered submit is acknowledged only after exact review confirmation; terminal reset permits a fresh original", async () => {
  const x = actualClientSimulation();
  await createDancePreparationController(x.ports).start(
    consent.termsHash,
    signal(),
  );
  await x.f.seed({ upload });
  const c = createDanceReviewController(x.ports),
    view = await c.observe(signal()),
    reply = x.transport.reply;
  let lose = true;
  x.transport.reply = async (path, init) => {
    const r = await reply(path, init);
    if (init?.method && path.endsWith("/reviews") && lose) {
      lose = false;
      throw Error("simulated_lost_accepted_reply");
    }
    return r;
  };
  await assert.rejects(c.act(view.result, { operation: "submit" }, signal()));
  const original = await x.client.retained!();
  assert.ok(original);
  await createDanceReviewController(x.ports).load(signal());
  assert.equal(await x.client.retained!(), null);
  x.reviews.set(x.f.c.captureId, simulatedCanonicalReview(x.f.c, "not_passed"));
  await createDancePreparationController(x.ports).closeTerminal(signal());
  assert.equal((await x.f.journey.store.read(scope, () => {})).capture, null);
  assert.equal(
    (await x.client.command!(original.commandId))?.receiptJson !== undefined,
    true,
  );
  const next = captureFixture();
  next.captureId = "deliberate_new";
  next.captureHash = hash(91);
  next.consent = {
    ...next.consent!,
    captureId: next.captureId,
    captureHash: next.captureHash,
  };
  x.choose(next);
  assert.equal(
    (
      await createDancePreparationController(x.ports).prepare(
        consent.termsHash,
        signal(),
      )
    ).kind,
    "objectives",
  );
  assert.equal(
    (
      await createDancePreparationController(x.ports).start(
        consent.termsHash,
        signal(),
      )
    ).session?.session_id,
    next.captureId,
  );
});

for (const status of [401, 403])
  for (const body of [
    "valid",
    "empty",
    "html",
    "malformed",
    "rejected",
    "stalled",
  ] as const) {
    test(`${status}/${body}: header refusal precedes body completion and fences late private responses`, async () => {
      const durable = simulatedCommandStorage(),
        headers = deferred<Response>(),
        late = deferred<unknown>(),
        denied = deferred<void>();
      let calls = 0,
        notifications = 0;
      const client = createDanceClient({
        communityId: scope.communityId,
        accountId: scope.accountId,
        csrf: "simulated",
        isCurrent: () => true,
        journal: durable.journal(),
        fetcher: (async () =>
          ++calls === 1
            ? ({ status: 200, ok: true, json: () => late.promise } as Response)
            : headers.promise) as typeof fetch,
      });
      const old = client.observe!("old");
      const oldRejected = assert.rejects(old, privateAccessLost);
      client.onAccessLost!(() => {
        notifications++;
        denied.resolve();
      });
      const refusal = client.observe!("denied");
      const settled =
        body === "stalled"
          ? null
          : assert.rejects(
              refusal,
              (e) =>
                e instanceof DanceClientError &&
                e.status === status &&
                (body !== "valid" || e.code === "policy_denied"),
            );
      const response =
        body === "stalled" || body === "rejected"
          ? ({
              status,
              ok: false,
              json: () =>
                body === "stalled"
                  ? new Promise(() => {})
                  : Promise.reject(Error("decode_failed")),
            } as Response)
          : new Response(
              body === "valid"
                ? JSON.stringify({ error: "policy_denied" })
                : body === "empty"
                  ? ""
                  : body === "html"
                    ? "<html>denied</html>"
                    : "{",
              { status },
            );
      headers.resolve(response);
      await denied.promise;
      assert.equal(notifications, 1);
      late.resolve(reviewFixture(captureFixture()));
      await oldRejected;
      await assert.rejects(client.observe!("late"), privateAccessLost);
      if (settled) await settled;
      else void refusal;
      client.dispose();
    });
  }

test("direct local review restores real retained Blob with two current-permission checks and no camera", async () => {
  const f = simulatedSource(),
    storage = simulatedRecordingStorage(),
    file = new File(["retained original preview bytes"], "take.mp4", {
      type: "video/mp4",
    });
  await f.seed();
  await createDanceRecordingController({
    ...f.ports,
    storage: storage.storage,
  }).retain(
    f.ready,
    {
      sessionId: f.c.captureId,
      termsHash: f.c.termsHash,
      durationMs: f.session.body_end_ms,
      file,
    },
    signal(),
  );
  const digest = await danceRecordingDigest(file);
  f.setStatus(mediaFixture(f.c, digest));
  await f.seed({
    upload: { ...upload, recordingSha256: digest, bytes: file.size },
  });
  const p = createDanceReviewController({
    ...f.ports,
    recordingStorage: storage.storage,
  });
  const before = f.calls.filter((s) => s === "capture_access").length,
    result = await p.localPreview(signal());
  assert.equal(await result.blob.text(), await file.text());
  assert.equal(result.expiresAtMs, f.c.expiresAtMs);
  assert.equal(
    f.calls.filter((s) => s === "capture_access").length - before,
    2,
  );
  for (const deniedAt of [1, 2]) {
    let n = 0;
    const denied = createDanceReviewController({
      ...f.ports,
      recordingStorage: storage.storage,
      captureAccess: async () => {
        if (++n === deniedAt)
          throw new DanceClientError("private_denied", false, 403);
      },
    });
    await assert.rejects(denied.localPreview(signal()), privateAccessLost);
  }
  await assert.rejects(
    createDanceReviewController({
      ...f.ports,
      recordingStorage: storage.storage,
      nowMs: () => f.c.expiresAtMs,
    }).localPreview(signal()),
    /unavailable/,
  );
  await assert.rejects(
    createDanceReviewController({
      ...f.ports,
      recordingStorage: simulatedRecordingStorage().storage,
    }).localPreview(signal()),
    /unavailable/,
  );
});

test("local preview cannot return private Blob after account loss at the actual storage await", async () => {
  const f = simulatedSource(),
    storage = simulatedRecordingStorage(),
    file = new File(["retained original"], "take.mp4", { type: "video/mp4" });
  await f.seed();
  await createDanceRecordingController({
    ...f.ports,
    storage: storage.storage,
  }).retain(
    f.ready,
    {
      sessionId: f.c.captureId,
      termsHash: f.c.termsHash,
      durationMs: f.session.body_end_ms,
      file,
    },
    signal(),
  );
  const digest = await danceRecordingDigest(file);
  f.setStatus(mediaFixture(f.c, digest));
  await f.seed({ upload: { ...upload, recordingSha256: digest } });
  const blocked = deferred<void>(),
    proceed = deferred<void>(),
    load = storage.storage.load.bind(storage.storage);
  storage.storage.load = async (...args) => {
    blocked.resolve();
    await proceed.promise;
    return load(...args);
  };
  const pending = createDanceReviewController({
    ...f.ports,
    recordingStorage: storage.storage,
  }).localPreview(signal());
  const refused = assert.rejects(pending, /session_changed/);
  await blocked.promise;
  f.setScope({ ...scope, sessionKey: "next_session" });
  proceed.resolve();
  await refused;
  assert.equal(
    storage.records.size,
    1,
    "account loss discarded the protected original",
  );
});

test("receipt acknowledgement is scoped and a safe capture reset cannot clear another active original", async () => {
  const x = actualClientSimulation();
  const capture = await x.client.prepareCapture!(
    danceTargetKey(scope),
    scope.songKey,
    null,
    scope.reference!.id,
    acceptedConsent,
  );
  await x.client.dispatchPrepared!(capture);
  x.reviews.set(x.f.c.captureId, simulatedCanonicalReview(x.f.c, "pass"));
  const submission = await x.client.prepareSubmission!(
    danceTargetKey(scope),
    x.f.c.captureId,
    "media",
    hash(16),
  );
  await x.client.dispatchPrepared!(submission);
  await x.client.acknowledgeRecovery(capture.commandId);
  assert.equal((await x.client.retained!())?.commandId, submission.commandId);
  const active = await x.durable.journal().reserve({
    version: 1,
    scope,
    commandId: "unrelated_original",
    subject: "withdraw:other",
    path: "reviews/other/withdraw",
    bodyJson: JSON.stringify({ revision: 1 }),
  });
  await assert.rejects(
    x.client.releaseCompletedCapture!(
      capture.commandId,
      x.f.c.captureId,
      signal(),
    ),
    /response_unknown/,
  );
  assert.equal((await x.client.retained!())?.commandId, active.commandId);
  assert.equal(
    (await x.client.acceptedCapture!())?.commandId,
    capture.commandId,
  );
});

test("immutable prepared bytes cannot be replaced at dispatch or receipt acceptance", async () => {
  const x = actualClientSimulation(),
    original = await x.client.prepareSubmission!(
      danceTargetKey(scope),
      x.f.c.captureId,
      "media",
      hash(16),
    );
  const changed = { ...original, requestJson: original.requestJson + " " };
  await assert.rejects(
    x.client.dispatchPrepared!(changed),
    /original_command_changed/,
  );
  await assert.rejects(
    x.durable
      .journal()
      .accept(changed, JSON.stringify({ commandId: original.commandId })),
    /journal_conflict/,
  );
  assert.equal(x.requests.length, 0);
  assert.equal((await x.client.retained!())?.requestJson, original.requestJson);
  await assert.rejects(
    x.client.withdraw("other", 1),
    /original_command_recovered/,
  );
  assert.equal(x.requests.length, 0);
});

test("legacy submission flag without original UUID/body stays held despite an existing review", async () => {
  const x = actualClientSimulation();
  await x.f.seed({ upload, submission: "unknown" });
  await assert.rejects(
    createDanceReviewController(x.ports).load(signal()),
    /legacy_original_missing/,
  );
  assert.equal(
    (await x.f.journey.store.read(scope, () => {})).submission,
    "unknown",
  );
  assert.equal(
    x.requests.some((r) => r.body),
    false,
  );
});
