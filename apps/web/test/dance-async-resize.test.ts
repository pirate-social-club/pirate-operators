/** UNRUN. Actual controllers/client/journal operations. HTTP, memory storage,
 * presentation eligibility, camera and guide are explicitly simulated ports.
 * No native viewport/device/provider/canonical acceptance is claimed. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { createDanceRecorder } from "../src/dance/source/dance-recorder.ts";
import { createDanceRecordingController, danceRecordingDigest } from "../src/dance/source/dance-recording.ts";
import type { DanceRecordedTake } from "../src/dance/source/dance-capture.ts";
import { simulatedTerminalJourney, terminalSignal as signal } from "./dance-terminal-recovery-fixtures.ts";
import { simulatedSource, simulatedRecordingStorage, mediaFixture, scope, consent } from "./dance-source-fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function simulatedEligibility() {
  let allowed = true;
  return {
    deny: () => { allowed = false; },
    assertFreshPosting: () => { if (!allowed) throw Error("dance_posting_unavailable"); },
  };
}

for (const boundary of ["retained", "media_status"] as const)
  test(`submit: ${boundary} pending before phone-to-desktop creates no fresh command`, async () => {
    const x = simulatedTerminalJourney(), { ports } = await x.prepareTake();
    const eligibility = simulatedEligibility();
    const controller = createDanceReviewController({ ...ports, ...eligibility });
    const view = await controller.observe(signal());
    const beforeJourney = await x.f.journey.store.read(scope, () => {});
    const beforeCommands = structuredClone(x.durable.rows);
    const waiting = deferred<void>(), release = deferred<void>();
    let prepared = 0;
    const prepare = ports.client.prepareSubmission!;
    ports.client.prepareSubmission = (...args) => { prepared++; return prepare(...args); };
    if (boundary === "retained") {
      const retained = ports.client.retained!;
      ports.client.retained = async () => {
        const original = await retained(); waiting.resolve(); await release.promise; return original;
      };
    } else {
      const status = ports.media.status;
      ports.media.status = async (...args) => {
        const original = await status(...args); waiting.resolve(); await release.promise; return original;
      };
    }
    const pending = controller.act(view.result, { operation: "submit" }, signal());
    await waiting.promise;
    eligibility.deny(); release.resolve();
    await assert.rejects(pending, /dance_posting_unavailable/);
    assert.equal(prepared, 0);
    assert.equal(x.requests.filter(r => r.body && r.path.endsWith("/reviews")).length, 0);
    assert.deepEqual(x.durable.rows, beforeCommands);
    assert.deepEqual(await x.f.journey.store.read(scope, () => {}), beforeJourney);
  });

for (const boundary of ["retained", "accepted_capture"] as const)
  test(`admission: ${boundary} pending before eligibility loss creates no reservation`, async () => {
    const x = simulatedTerminalJourney(), ports = x.select(scope);
    const eligibility = simulatedEligibility();
    const waiting = deferred<void>(), release = deferred<void>();
    let prepared = 0;
    const prepare = ports.client.prepareCapture!;
    ports.client.prepareCapture = (...args) => { prepared++; return prepare(...args); };
    if (boundary === "retained") {
      const retained = ports.client.retained!;
      ports.client.retained = async () => { const v = await retained(); waiting.resolve(); await release.promise; return v; };
    } else {
      const accepted = ports.client.acceptedCapture!;
      let first = true;
      ports.client.acceptedCapture = async () => {
        const v = await accepted();
        if (first) { first = false; waiting.resolve(); await release.promise; }
        return v;
      };
    }
    const pending = createDancePreparationController({ ...ports, ...eligibility }).start(consent.termsHash, signal());
    await waiting.promise;
    eligibility.deny(); release.resolve();
    await assert.rejects(pending, /dance_posting_unavailable/);
    assert.equal(prepared, 0);
    assert.equal(x.requests.some(r => r.body !== null), false);
    assert.equal(x.durable.rows.size, 0);
    assert.equal((await x.f.journey.store.read(scope, () => {})).captureUnknown, false);
  });

test("phone-created submission settles after resize without stranding or replacing its preimage", async () => {
  const x = simulatedTerminalJourney(), { ports } = await x.prepareTake();
  const eligibility = simulatedEligibility(), waiting = deferred<void>(), release = deferred<void>();
  const prepare = ports.client.prepareSubmission!;
  let preparations = 0, original: Awaited<ReturnType<typeof prepare>> | undefined;
  ports.client.prepareSubmission = async (...args) => {
    preparations++;
    const command = await prepare(...args);
    original = command; waiting.resolve(); await release.promise; return command;
  };
  const controller = createDanceReviewController({ ...ports, ...eligibility });
  const view = await controller.observe(signal());
  const pending = controller.act(view.result, { operation: "submit" }, signal());
  await waiting.promise;
  const bytes = original!.requestJson;
  eligibility.deny(); release.resolve();
  const accepted = await pending;
  assert.equal(accepted.receipt?.commandId, original!.commandId);
  assert.equal(preparations, 1);
  assert.deepEqual(x.requests.filter(r => r.path.endsWith("/reviews") && r.body).map(r => r.body), [bytes]);
  assert.equal((await ports.client.command!(original!.commandId))?.requestJson, bytes);
  assert.equal((await x.f.journey.store.read(scope, () => {})).submission, "accepted");
});

test("phone-created capture reservation settles after resize and remains recoverable", async () => {
  const x = simulatedTerminalJourney(), ports = x.select(scope);
  const eligibility = simulatedEligibility(), waiting = deferred<void>(), release = deferred<void>();
  const prepare = ports.client.prepareCapture!;
  let original: Awaited<ReturnType<typeof prepare>> | undefined;
  ports.client.prepareCapture = async (...args) => {
    const command = await prepare(...args);
    original = command; waiting.resolve(); await release.promise; return command;
  };
  const pending = createDancePreparationController({ ...ports, ...eligibility }).start(consent.termsHash, signal());
  await waiting.promise;
  eligibility.deny(); release.resolve();
  assert.equal((await pending).kind, "capture_ready");
  assert.deepEqual(x.requests.filter(r => r.body).map(r => r.body), [original!.requestJson]);
  const saved = await x.f.journey.store.read(scope, () => {});
  assert.equal(saved.captureUnknown, false);
  assert.equal(saved.capture?.consent?.receiptId, original!.commandId);
  await createDancePreparationController({ ...ports, ...eligibility }).recover(consent.termsHash, signal());
  assert.deepEqual((await x.f.journey.store.read(scope, () => {})).capture, saved.capture);
  assert.equal(x.requests.filter(r => r.body).length, 1);
});

test("desktop recovery dispatches the retained original only and preserves upload/capture identity", async () => {
  const x = simulatedTerminalJourney(), { ports } = await x.prepareTake();
  const controller = createDanceReviewController(ports);
  x.transport.mode = "lost_before_acceptance";
  const view = await controller.observe(signal());
  await assert.rejects(controller.act(view.result, { operation: "submit" }, signal()), /response_unknown/);
  const original = await ports.client.retained!();
  assert.ok(original?.requestJson);
  const held = await x.f.journey.store.read(scope, () => {});
  x.transport.mode = "accepted";
  let freshChecks = 0;
  const recovered = await createDanceReviewController({
    ...ports, assertFreshPosting: () => { freshChecks++; throw Error("dance_posting_unavailable"); },
  }).load(signal());
  assert.equal(recovered.result.kind, "review");
  assert.equal(freshChecks, 0);
  assert.deepEqual(x.requests.filter(r => r.path.endsWith("/reviews") && r.body).map(r => r.body), [original.requestJson, original.requestJson]);
  const saved = await x.f.journey.store.read(scope, () => {});
  assert.deepEqual(saved.capture, held.capture);
  assert.deepEqual(saved.upload, held.upload);
  assert.equal(saved.commands?.submit?.commandId, original.commandId);
  assert.equal(saved.submission, "accepted");
});

function simulatedRecorder() {
  const f = simulatedSource(), stored = simulatedRecordingStorage(), eligibility = simulatedEligibility();
  const activation = { run: async () => {} };
  const camera = { run: async (): Promise<void> => {} };
  const native = { allow: false };
  const result = deferred<DanceRecordedTake>(), created = deferred<void>();
  let opens = 0, captures = 0, releases = 0, stopped = 0;
  const recorder = createDanceRecorder({
    ...f.ports, ...eligibility, storage: stored.storage,
    claimCapture: async () => ({ assertCurrent: () => {}, release: async () => { releases++; } }),
    openCamera: async () => {
      opens++; await camera.run();
      return { getTracks: () => [{ stop: () => { stopped++; } }] } as unknown as MediaStream;
    },
    prepareGuide: async ({ context }) => ({
      sessionId: context.session.session_id, termsHash: context.session.terms_hash,
      activate: () => activation.run(), start: () => {}, dispose: () => {},
    }),
    capture: () => {
      captures++; created.resolve();
      if (!native.allow) throw Error("unexpected_native_capture");
      return { result: result.promise, cancel: () => {} };
    },
  });
  return { f, stored, eligibility, activation, camera, native, result, created, recorder, counts: () => ({ opens, captures, releases, stopped }) };
}

test("camera admission deferred access loses eligibility before native request; accepted capture remains", async () => {
  const x = simulatedRecorder(), waiting = deferred<void>(), release = deferred<void>();
  const deferredAccess = async () => { waiting.resolve(); await release.promise; };
  let opens = 0, released = 0;
  const recorder = createDanceRecorder({
    ...x.f.ports, ...x.eligibility, captureAccess: deferredAccess, storage: x.stored.storage,
    claimCapture: async () => ({ assertCurrent: () => {}, release: async () => { released++; } }),
    openCamera: async () => { opens++; throw Error("must_not_open"); },
  });
  try {
    const pending = recorder.enter(consent.termsHash, signal());
    await waiting.promise;
    const original = structuredClone(await x.f.journey.store.read(scope, () => {}));
    x.eligibility.deny(); release.resolve();
    await assert.rejects(pending, /dance_posting_unavailable/);
    assert.equal(opens, 0);
    assert.equal(released, 1);
    assert.deepEqual(await x.f.journey.store.read(scope, () => {}), original);
    assert.equal(original.capture?.captureId, x.f.c.captureId);
  } finally { recorder.dispose(); x.recorder.dispose(); }
});

test("deferred guide activation then resize creates zero native capture and retains reservation", async () => {
  const x = simulatedRecorder(), waiting = deferred<void>(), release = deferred<void>();
  try {
    assert.equal((await x.recorder.enter(consent.termsHash, signal())).kind, "camera");
    const retained = await x.f.journey.store.read(scope, () => {});
    x.activation.run = async () => { waiting.resolve(); await release.promise; };
    const pending = x.recorder.record(signal(), () => {}, () => {});
    await waiting.promise;
    x.eligibility.deny(); release.resolve();
    await assert.rejects(pending, /dance_posting_unavailable/);
    assert.equal(x.counts().captures, 0);
    assert.equal(x.counts().stopped > 0, true);
    assert.deepEqual(await x.f.journey.store.read(scope, () => {}), retained);
    assert.equal(x.stored.records.size, 0);
  } finally { x.recorder.dispose(); }
});

test("camera request already opened on phone may settle on desktop; late account loss still vetoes", async () => {
  for (const loseAccount of [false, true]) {
    const x = simulatedRecorder(), waiting = deferred<void>(), release = deferred<void>();
    try {
      x.camera.run = async () => { waiting.resolve(); await release.promise; };
      const pending = x.recorder.enter(consent.termsHash, signal());
      await waiting.promise;
      x.eligibility.deny();
      if (loseAccount) x.f.setScope({ ...scope, sessionKey: "replaced" });
      release.resolve();
      if (loseAccount) { await assert.rejects(pending, /session_changed/); assert.equal(x.counts().stopped > 0, true); }
      else assert.equal((await pending).kind, "camera");
      assert.equal(x.counts().opens, 1);
      assert.equal(x.counts().captures, 0);
    } finally { x.recorder.dispose(); }
  }
});

test("already-created recording survives resize and retains exact original bytes before upload", async () => {
  const x = simulatedRecorder();
  try {
    await x.recorder.enter(consent.termsHash, signal());
    x.native.allow = true;
    const pending = x.recorder.record(signal(), () => {}, () => {});
    await x.created.promise;
    const file = new File(["simulated original encoded take"], "take.mp4", { type: "video/mp4" });
    const digest = await danceRecordingDigest(file);
    x.f.setStatus(mediaFixture(x.f.c, digest));
    x.eligibility.deny();
    x.result.resolve({ sessionId: x.f.c.captureId, termsHash: x.f.c.termsHash, durationMs: x.f.c.durationSamples / 48, file });
    assert.equal((await pending).kind, "upload");
    const original = await createDanceRecordingController({ ...x.f.ports, storage: x.stored.storage }).restore(x.f.c.captureId, signal());
    assert.equal(await original?.blob.text(), await file.text());
    assert.equal(original?.metadata.sha256, digest);
    assert.equal(x.counts().captures, 1);
    assert.equal(x.f.calls.includes("put"), false);
  } finally { x.recorder.dispose(); }
});
