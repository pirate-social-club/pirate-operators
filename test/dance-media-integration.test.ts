import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { bytes32, hashJson } from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import { mediaSubmissionReceipt } from "../packages/community-media/submission.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { mediaBinding } from "../packages/dance/validation.ts";
import {
  danceMediaBinding,
  danceMediaId,
} from "../packages/dance-chain/wire.ts";
import {
  dancePrivatePlaybackAuthority,
  integratedDanceMedia,
} from "../services/dance-media-integration.ts";
import { actor, fixture, reviewer } from "./community-media-fixture.ts";
import { danceFixture, dh, dw } from "./dance-fixture.ts";

test("real media and Dance D1 share one retention transaction and fence all private byte reads", async (t) => {
  const model = danceFixture();
  const template = await model.service.capture(
    "learner",
    "capture_binding_fixture",
    { songKey: dh(10), offerId: null, referenceId: null },
    model.consent,
  );
  const f = await fixture(t, {
    communityId: template.communityId,
    songKey: template.songKey,
    songRevision: template.songRevision,
    audioSha256: template.audioSha256.slice(2),
    durationSamples: template.songDurationSamples,
  });
  const dance = await readFile(
    new URL(
      "../apps/community-wizard/infra/migrations/0016_dance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await f.db.batch(
    dance
      .replace(/^--[^\n]*\n/gm, "")
      .trim()
      .split(/;\n+/)
      .map((statement) => f.db.prepare(statement)),
  );
  const store = new DanceStore(f.db);
  const clock = await store.now();
  const capture = {
    ...template,
    reservedAtMs: clock - 1000,
    expiresAtMs: clock + 300000,
    learner: { ...template.learner, accountId: actor.accountId },
    consent: null,
  };
  await store.reserveCapture(
    capture,
    actor.accountId,
    "capture_real_d1",
    dh(90),
    [],
  );
  const accepted = await store.acceptConsent(
    capture,
    model.consent,
    "capture_real_d1",
    [],
  );
  f.setNow(Date.now() - 30000);
  const record = await f.ready({
    startSample: accepted.startSample,
    durationSamples: accepted.durationSamples,
  });
  f.setNow(Date.now());
  const recording = `0x${f.hash}` as const;
  const port = integratedDanceMedia(f.service);
  const binding = mediaBinding(accepted, recording);
  const ready = await port.readyForSubmission(record.id, binding, actor);
  assert.equal(
    port.projectDanceMedia(ready.media, ready.witness).recordingSha256,
    recording,
  );
  assert.equal(ready.media.audioSha256, accepted.audioSha256);
  await assert.rejects(
    port.readyForSubmission(record.id, binding, reviewer),
    /media_not_found/,
  );
  await assert.rejects(
    port.readyForReview(record.id, binding, actor),
    /media_review_forbidden/,
  );

  const domain = {
    chainId: 6343n,
    verifier: address(dw(20)),
    communityId: bytes32(dh(1)),
  };
  const commitment = danceMediaBinding(
    domain,
    accepted.captureHash as `0x${string}`,
    danceMediaId(domain, record.id),
    BigInt(ready.witness.revision + 1),
    recording,
  );
  const args = {
    capture: accepted,
    media: binding,
    witness: ready.witness,
    bindingCommitment: commitment,
    commandId: "submit_real_d1",
    requestHash: hashJson(binding),
    fences: [port.commitFence(ready.witness)],
    mediaPort: port,
  };
  await f.db
    .prepare(
      "CREATE TRIGGER test_dance_receipt_failure BEFORE INSERT ON dance_receipts BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END",
    )
    .run();
  await assert.rejects(store.acceptSubmission(args), /fixture_receipt_failure/);
  assert.equal((await f.repository.get(record.id)).revision, record.revision);
  await assert.rejects(
    mediaSubmissionReceipt(f.repository, accepted.captureId),
    /media_submission_not_found/,
  );
  await f.db.prepare("DROP TRIGGER test_dance_receipt_failure").run();
  const receipt = await store.acceptSubmission(args);
  assert.equal(receipt.reviewId, accepted.captureId);
  const acceptedReview = await store.review(receipt.reviewId);
  const retained = await mediaSubmissionReceipt(f.repository, receipt.reviewId);
  assert.deepEqual(acceptedReview.receipt, retained);
  assert.equal(retained.bindingCommitment, commitment);
  assert.equal(
    retained.reviewDeadlineMs - retained.trustedSubmittedAtMs,
    604800000,
  );
  assert.equal(retained.mediaRevision, ready.witness.revision + 1);
  await assert.rejects(store.acceptSubmission(args), /dance_fence_changed/);
  assert.deepEqual(
    await mediaSubmissionReceipt(f.repository, receipt.reviewId),
    retained,
  );

  let calls = 0,
    allowed = true,
    denyAfter: number | undefined;
  f.ports.privatePlaybackAuthority = dancePrivatePlaybackAuthority({
    async inspect(accountId, reviewId) {
      assert.ok([actor.accountId, reviewer.accountId].includes(accountId));
      assert.equal(reviewId, receipt.reviewId);
      calls++;
      return {
        reviewId,
        mediaId: allowed && calls !== denyAfter ? record.id : "withdrawn",
      };
    },
  });
  const path = `/api/media/${record.id}/playback`;
  assert.equal((await f.http(path, actor, { method: "HEAD" }))?.status, 200);
  assert.equal(calls, 2);
  const ranged = await f.http(path, reviewer, {
    headers: { range: "bytes=0-4" },
  });
  assert.equal(ranged?.status, 206);
  assert.equal((await ranged?.arrayBuffer())?.byteLength, 5);
  denyAfter = calls + 2; // Access is revoked while the R2 read is awaited.
  assert.equal(
    (await f.http(path, actor, { headers: { range: "bytes=0-4" } }))?.status,
    404,
  );
  allowed = false;
  assert.equal((await f.http(path, actor))?.status, 404);
  assert.equal((await f.http(path, reviewer, { method: "HEAD" }))?.status, 404);
});
