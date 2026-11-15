// Real bundled Worker exports, D1 and queue/scheduled dispatch. UNRUN.
import assert from "node:assert/strict";
import test from "node:test";
import { managedServicesFixture } from "./fixtures/managed-first-song-services.ts";

test("bundled fetch, queue and scheduled use the admitted journal and awaited recovery", async () => {
  const f = await managedServicesFixture();
  try {
    const worker = await f.recognitionWorker();
    assert.equal((await worker.fetch("https://recognition.web2.example/not-found")).status, 404);
    const original = await f.seedDueRecording();
    const first = await worker.scheduled({ cron: "* * * * *" });
    assert.equal(first.outcome, "ok");
    assert.deepEqual(await f.recordingIdentity(), { recording_id: original.recording_id, audio_sha256: original.audio_sha256 });
    // This durable original has no accepted application source. A real
    // canonical refusal must not turn a scheduler wake into a paid success.
    const queued = await worker.queue("recognition", [{ id: "original-delivery", timestamp: new Date(), attempts: 1,
      body: { kind: "recording", recordingId: original.recording_id } }]);
    assert.equal(queued.outcome, "ok");
    await worker.queue("recognition", [{ id: "duplicate-delivery", timestamp: new Date(), attempts: 2,
      body: { kind: "recording", recordingId: original.recording_id } }]);
    assert.equal(await f.providerReceiptCount(), 0);
    assert.deepEqual(await f.recordingIdentity(), {
      recording_id: original.recording_id, audio_sha256: original.audio_sha256,
    });
    await f.restartRecognition();
    assert.equal((await (await f.recognitionWorker()).scheduled()).outcome, "ok");
    assert.equal(await f.providerReceiptCount(), 0);
    await f.artifact("bundled-recognition-original-recovery");
  } finally { await f.close(); }
});

test("bundled handlers refuse missing/mismatched installation, profile, schema and credential bindings", async () => {
  const f = await managedServicesFixture();
  try {
    for (const fault of ["installation", "profile", "schema", "database-schema", "credentials", "issuer"] as const) {
      await f.recognitionFault(fault, async worker => {
        assert.equal((await worker.fetch("https://recognition.web2.example/not-found")).status, 503, fault);
        assert.notEqual((await worker.scheduled()).outcome, "ok", fault);
      });
    }
    assert.equal(await f.providerReceiptCount(), 0);
    await f.artifact("recognition-configuration-refusals");
  } finally { await f.close(); }
});


test("a delayed scheduler and duplicate delivery advance one real accepted original without duplicate catalog effects", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach();
    await f.setWakeDelivery(false);
    const intent = await f.acceptCanonicalIntent();
    await assert.rejects(f.recognitionClient().reserve(intent)); // accepted, still pending
    const original = await f.reservationOriginal(intent);
    assert.ok(original);
    await f.restartRecognition();
    await f.setWakeDelivery(true);
    assert.equal((await (await f.recognitionWorker()).scheduled()).outcome, "ok");
    const ready = await f.waitRecognitionReady(intent);
    assert.equal(ready.state, "ready");
    assert.equal(ready.recordingState, "ready");
    assert.deepEqual(await f.reservationIdentity(intent), { reservation_id: original.reservation_id, intent_json: original.intent_json });
    const worker = await f.recognitionWorker();
    await worker.queue("recognition", [{ id: "duplicate-ready", timestamp: new Date(), attempts: 2,
      body: { kind: "reservation", reservationId: original.reservation_id } }]);
    assert.equal(f.providerEffects().uploads, 1);
    assert.equal(f.providerEffects().identifies, 2); // original identification + catalog verification
    await f.artifact("real-accepted-original-ready");
  } finally { await f.close(); }
});

test("lost provider upload reply reconciles the same recording after restart without another upload", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach();
    const intent = await f.acceptCanonicalIntent(); f.loseNextUploadReply();
    await assert.rejects(f.recognitionClient().reserve(intent));
    await f.waitForUploadCall();
    await f.restartRecognition();
    assert.equal((await (await f.recognitionWorker()).scheduled()).outcome, "ok");
    const ready = await f.waitRecognitionReady(intent);
    assert.equal(ready.recordingState, "ready");
    assert.equal(f.providerEffects().uploads, 1);
    await f.artifact("catalog-upload-unknown-reconciliation");
  } finally { await f.close(); }
});


test("an unknown original identification reply survives duplicate delivery and restart without another purchase", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach();
    const intent = await f.acceptCanonicalIntent(); f.loseNextIdentifyReply();
    await assert.rejects(f.recognitionClient().reserve(intent));
    await f.waitForIdentifyCall();
    const original = await f.reservationOriginal(intent); assert(original);
    await f.restartRecognition();
    const worker = await f.recognitionWorker();
    await worker.scheduled();
    await worker.queue("recognition", [{ id: "unknown-original-replay", timestamp: new Date(), attempts: 2,
      body: { kind: "reservation", reservationId: original.reservation_id } }]);
    assert.equal((await f.recognitionClient().status(intent)).recordingState === "ready", false);
    assert.equal(f.providerEffects().identifies, 1);
    assert.equal(f.providerEffects().uploads, 0);
    assert.deepEqual(await f.reservationIdentity(intent), original);
    await f.artifact("unknown-identification-restart");
  } finally { await f.close(); }
});

test("provider outage cannot turn an accepted original into catalog readiness", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach();
    const intent = await f.acceptCanonicalIntent(); f.setProviderOutage(true);
    await assert.rejects(f.recognitionClient().reserve(intent));
    await f.waitForIdentifyCall();
    const before = await f.reservationOriginal(intent); assert(before);
    await f.restartRecognition(); await (await f.recognitionWorker()).scheduled();
    assert.notEqual((await f.recognitionClient().status(intent)).recordingState, "ready");
    assert.equal(f.providerEffects().uploads, 0);
    assert.deepEqual(await f.reservationIdentity(intent), before);
    await f.artifact("provider-outage-original");
  } finally { await f.close(); }
});
