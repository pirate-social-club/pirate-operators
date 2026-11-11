/** UNRUN. Actual preparation/upload/review controllers over named simulated ports. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { createDanceUploadController } from "../src/dance/source/dance-upload-controller.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import { createDanceRecorder } from "../src/dance/source/dance-recorder.ts";
import { DanceClientError } from "../src/dance/client.ts";
import {
  danceResultPresentation,
  assertDanceReview,
} from "../src/dance/source/dance-review-api.ts";
import {
  simulatedSource,
  simulatedRecordingStorage,
  mediaFixture,
  reviewFixture,
  hash,
  sha,
  scope,
  consent,
} from "./dance-source-fixtures.ts";
const signal = () => new AbortController().signal;
const uploadEntry = {
  requestId: "original_request",
  recordingSha256: sha(16),
  bytes: 4,
  mediaId: "media",
  put: "acknowledged" as const,
  status: null,
};

test("prepare is read-only; explicit Start persists uncertainty before the exact consent/capture dispatch", async () => {
  const f = simulatedSource(),
    p = createDancePreparationController(f.ports);
  assert.equal(
    (await p.prepare(consent.termsHash, signal())).kind,
    "objectives",
  );
  assert.equal(f.calls.includes("capture"), false);
  f.client.capture = async (song, offer, reference, accepted) => {
    assert.equal(
      (await f.journey.store.read(scope, () => {})).captureUnknown,
      true,
    );
    assert.equal(song, scope.songKey);
    assert.equal(offer, scope.offerId);
    assert.equal(reference, scope.reference!.id);
    assert.deepEqual(accepted, {
      accepted: true,
      version: consent.version,
      termsHash: consent.termsHash,
      publicityPolicyHash: consent.publicityPolicyHash,
    });
    f.calls.push("capture");
    return f.c;
  };
  const v = await p.start(consent.termsHash, signal());
  assert.equal(v.kind, "capture_ready");
  assert.equal(f.c.reservedAtMs <= f.c.consent!.acceptedAtMs, true);
  assert.equal(
    (await f.journey.store.read(scope, () => {})).captureUnknown,
    false,
  );
});
test("unknown reservation survives reload, blocks retarget/reset, and recovers the same accepted capture", async () => {
  const f = simulatedSource();
  f.client.capture = async () => {
    throw Error("unknown_ack");
  };
  await assert.rejects(
    createDancePreparationController(f.ports).start(
      consent.termsHash,
      signal(),
    ),
    /unknown_ack/,
  );
  const reload = createDancePreparationController(f.ports);
  await assert.rejects(
    reload.prepare(consent.termsHash, signal()),
    /response_unknown/,
  );
  await assert.rejects(reload.closeTerminal(signal()), /resolution_unproven/);
  f.setRetained({
    version: 1,
    scope: { accountId: scope.accountId, communityId: scope.communityId },
    commandId: "original_capture_command",
    path: "captures",
    subject: "capture",
    bodyJson: "{}",
    receiptJson: JSON.stringify(f.c),
  });
  const restored = await reload.recover(consent.termsHash, signal());
  assert.equal(restored.kind, "objectives");
  assert.equal(
    (await f.journey.store.read(scope, () => {})).capture?.captureHash,
    f.c.captureHash,
  );
  assert.equal(f.calls.includes("reset"), false);
});
test("definite cancellation permits a fresh reset only before any upload/submission and archives the original", async () => {
  const f = simulatedSource();
  await f.seed();
  const p = createDancePreparationController(f.ports);
  await p.cancelBeforeTake(signal());
  await p.closeTerminal(signal());
  assert.equal(
    f.journey.archives.get(f.c.captureId)?.capture?.captureHash,
    f.c.captureHash,
  );
  assert.equal((await f.journey.store.read(scope, () => {})).capture, null);
  await f.seed({ captureUnknown: true });
  await assert.rejects(p.cancelBeforeTake(signal()), /response_unknown/);
});
test("late native camera permission after disposal/account change cannot return a camera and stops all tracks", async () => {
  const f = simulatedSource();
  let opened!: (s: MediaStream) => void, announce!: () => void;
  const started = new Promise<void>((r) => {
    announce = r;
  });
  let stopped = 0;
  const recorder = createDanceRecorder({
    ...f.ports,
    storage: simulatedRecordingStorage().storage,
    claimCapture: async () => ({ assertCurrent: () => {}, release: () => {} }),
    openCamera: async () => {
      announce();
      return new Promise((r) => {
        opened = r;
      });
    },
  });
  const pending = recorder.enter(consent.termsHash, signal());
  await started;
  f.setScope({ ...scope, sessionKey: "replacement" });
  opened({
    getTracks: () => [
      {
        stop: () => {
          stopped++;
        },
      },
    ],
  } as unknown as MediaStream);
  await assert.rejects(pending, /session_changed/);
  assert.equal(stopped > 0, true);
  recorder.dispose();
});
test("media reserve acknowledgement loss replays the immutable original requestId and no replacement file", async () => {
  const f = simulatedSource();
  await f.seed();
  const requests: string[] = [];
  const recordings = {
    cleanupExpired: async () => {},
    restore: async () => ({
      metadata: { sha256: sha(16) },
      blob: new Blob(["take"]),
    }),
  };
  f.ports.media.reserve = async (_capture, intent) => {
    requests.push(intent.requestId);
    if (requests.length === 1) throw Error("reserve_ack_lost");
    return mediaFixture(f.c);
  };
  const make = () =>
    createDanceUploadController({
      ...f.ports,
      recordings: recordings as never,
      commandKey: () => "chosen_once",
    });
  await assert.rejects(make().resume(f.session, signal()), /reserve_ack_lost/);
  assert.equal(
    (await f.journey.store.read(scope, () => {})).upload?.requestId,
    "chosen_once",
  );
  assert.equal((await make().resume(f.session, signal())).kind, "review");
  assert.deepEqual(requests, ["chosen_once", "chosen_once"]);
  assert.equal(f.calls.includes("put"), false);
});
test("unknown PUT recovery first reads current state and does not upload/bill again after queued acceptance", async () => {
  const f = simulatedSource();
  await f.seed({ upload: { ...uploadEntry, put: "unknown" } });
  f.setStatus({
    id: "media",
    purpose: "private-review",
    state: "queued",
    canRetry: false,
    expiresAt: f.c.expiresAtMs,
  });
  const upload = createDanceUploadController({
    ...f.ports,
    recordings: {
      cleanupExpired: async () => {},
      restore: async () => {
        throw Error("must_not_need_bytes");
      },
    },
  });
  assert.equal((await upload.resume(f.session, signal())).kind, "processing");
  assert.deepEqual(f.calls, ["status"]);
  await upload.observe(f.session, signal());
  assert.deepEqual(f.calls, ["status", "status"]);
});
test("an observation of retryable failure cannot dispatch retry/PUT/reserve/submit", async () => {
  const f = simulatedSource();
  await f.seed({ upload: uploadEntry });
  f.setStatus({
    id: "media",
    purpose: "private-review",
    state: "failed",
    canRetry: true,
    expiresAt: f.c.expiresAtMs,
  });
  const c = createDanceUploadController({
    ...f.ports,
    recordings: { cleanupExpired: async () => {}, restore: async () => null },
  });
  assert.equal((await c.observe(f.session, signal())).kind, "unavailable");
  assert.deepEqual(f.calls, ["status"]);
});
test("ready media binding changes in account, revision, source audio or interval are refused", async () => {
  for (const change of [
    { accountId: "other" },
    { songRevision: 5 },
    { audioSha256: hash(99) },
    { startSample: 1 },
  ]) {
    const f = simulatedSource();
    await f.seed({ upload: uploadEntry });
    const status = mediaFixture(f.c);
    status.ready = { ...status.ready!, ...change };
    f.setStatus(status);
    const c = createDanceUploadController({
      ...f.ports,
      recordings: { cleanupExpired: async () => {}, restore: async () => null },
    });
    await assert.rejects(c.observe(f.session, signal()), /target_changed/);
  }
});
test("only explicit submit creates an accepted review; actual accepted timestamp owns exact seven-day expiry", async () => {
  const f = simulatedSource();
  await f.seed({ upload: uploadEntry });
  const c = createDanceReviewController(f.ports),
    before = await c.observe(signal());
  assert.equal(before.result.state, "uploaded");
  assert.equal(f.calls.includes("submit"), false);
  f.client.submit = async (_captureId, _mediaId, digest) => {
    assert.equal(digest, hash(16));
    assert.equal(
      (await f.journey.store.read(scope, () => {})).submission,
      "unknown",
    );
    f.calls.push("submit");
    return {
      version: "pirate.dance/1",
      commandId: "original_submit",
      reviewId: f.c.captureId,
      revision: 1,
      state: "awaiting_review",
      intentId: null,
    };
  };
  const after = await c.act(before.result, { operation: "submit" }, signal());
  assert.equal(after.result.kind, "review");
  const r = reviewFixture(f.c);
  assertDanceReview(r, scope);
  r.receipt.reviewDeadlineMs--;
  assert.throws(() => assertDanceReview(r, scope), /target_mismatch/);
});
test("old unknown submit recovers before opposite withdrawal; D1 decision is not a verdict", async () => {
  const f = simulatedSource();
  await f.seed({ upload: uploadEntry, submission: "unknown" });
  const r = reviewFixture(f.c);
  r.state = "decision_pending";
  f.setReview(r);
  f.setRetained({
    version: 1,
    scope,
    commandId: "old_submit",
    subject: "submission:capture",
    path: "reviews",
    bodyJson: "{}",
  });
  const c = createDanceReviewController(f.ports),
    v = await c.observe(signal());
  await c.act(v.result, { operation: "withdraw" }, signal());
  assert.equal(f.calls.includes("recover"), true);
  assert.equal(f.calls.includes("withdraw"), false);
  assert.equal(danceResultPresentation(v.result).title, "Decision pending");
});
test("only definite expired submission permits reset; unknown transport remains latched across reload", async () => {
  for (const definite of [false, true]) {
    const f = simulatedSource();
    await f.seed({ upload: uploadEntry });
    const c = createDanceReviewController(f.ports),
      v = await c.observe(signal());
    f.client.submit = async () => {
      throw definite
        ? new DanceClientError("dance_capture_expired", false, 410)
        : new TypeError("lost reply");
    };
    await assert.rejects(c.act(v.result, { operation: "submit" }, signal()));
    const entry = await f.journey.store.read(scope, () => {});
    assert.equal(entry.submission, definite ? "none" : "unknown");
    assert.equal(entry.terminal, definite ? "expired" : null);
    const prep = createDancePreparationController(f.ports);
    if (definite) await prep.closeTerminal(signal());
    else
      await assert.rejects(prep.closeTerminal(signal()), /resolution_unproven/);
  }
});

test("actual recorder command recovery retains original capture and returns consent view without opening camera", async () => {
  const f = simulatedSource();
  await f.seed({ captureUnknown: true });
  f.setRetained({
    version: 1,
    scope: { accountId: scope.accountId, communityId: scope.communityId },
    commandId: "original_capture_command",
    path: "captures",
    subject: "capture",
    bodyJson: "{}",
    receiptJson: JSON.stringify(f.c),
  });
  let cameraCalls = 0;
  const recorder = createDanceRecorder({
    ...f.ports,
    storage: simulatedRecordingStorage().storage,
    openCamera: async () => {
      cameraCalls++;
      throw new Error("recovery cannot request a camera");
    },
  });
  try {
    const result = await recorder.recover(
      consent.termsHash,
      signal(),
      () => {},
    );
    assert.equal(result.kind, "objectives");
    assert.equal(cameraCalls, 0);
    assert.equal(
      (await f.journey.store.read(scope, () => {})).capture?.captureHash,
      f.c.captureHash,
    );
    assert.equal(f.calls.includes("reset"), false);
  } finally {
    recorder.dispose();
  }
});
