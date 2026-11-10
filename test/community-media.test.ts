import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { communityRuntime } from "./community-runtime.ts";
import { CommunityMedia } from "../services/community-media.ts";
import { communityMediaApi } from "../services/community-media-api.ts";
import {
  MediaRepository,
  MEDIA_COMMIT_GUARD,
  mediaCommitValues,
} from "../packages/community-media/repository.ts";
import {
  sha256,
  SAMPLE_RATE,
  validateIntent,
} from "../packages/community-media/validation.ts";
import { FFmpegMediaProcessor } from "../packages/community-media/ffmpeg.ts";
import {
  BoundMediaProcessor,
  communityMediaRender,
} from "../packages/community-media/processor-transport.ts";
import type {
  MediaIntent,
  MediaProcessor,
  PublishedMediaSong,
} from "../packages/community-media/contracts.ts";

import { actor, reviewer, fixture, exec } from "./community-media-fixture.ts";

test("private media HTTP upload, immutable binding, review witness and public isolation", async (t) => {
  const f = await fixture(t);
  const a = await f.reserve();
  assert.equal((await f.reserve()).id, a.id);
  await assert.rejects(f.reserve({ bytes: 12 }), /media_idempotency_conflict/);
  const upload = await f.http(`/api/media/${a.id}/upload`, actor, {
    method: "PUT",
    headers: { origin: "https://community.example" },
    body: f.source,
  });
  assert.equal(upload?.status, 200);
  await f.service.process(a.id);
  const record = await f.repository.get(a.id);
  const witness = await f.service.readyForReview(a.id, record, reviewer);
  assert.equal(witness.media.rendition.sha256, f.hash);
  assert.deepEqual((await f.service.feed()).items, []);
  assert.equal(
    (await f.http(`/api/media/${a.id}/playback`, null))?.status,
    401,
  );
  assert.equal(
    (await f.http(`/api/media/${a.id}/playback`, { accountId: "stranger" }))
      ?.status,
    404,
  );
  assert.equal(
    (await f.http(`/api/media/${a.id}/playback`, reviewer))?.status,
    200,
  );
  await assert.rejects(
    f.service.readyForReview(a.id, record, actor),
    /media_review_forbidden/,
  );
  await assert.rejects(
    f.service.readyForReview(a.id, { ...record, songRevision: 1 }, reviewer),
    /media_binding_mismatch/,
  );
  f.revokeReview();
  assert.equal(
    (await f.http(`/api/media/${a.id}/playback`, reviewer))?.status,
    404,
  );
  await assert.rejects(
    f.service.readyForReview(a.id, record, reviewer),
    /media_review_forbidden/,
  );
});

test("public policy is denied by default; explicit capability, consent and range delivery", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.reserve({ purpose: "public-feed", publicConsent: true }),
    /media_public_posting_not_permitted/,
  );
  f.allowPublic();
  await assert.rejects(
    f.reserve({ purpose: "public-feed" }),
    /media_public_consent_required/,
  );
  const record = await f.ready({ purpose: "public-feed", publicConsent: true });
  const page = await f.service.feed(1);
  assert.equal(page.items[0]?.id, record.id);
  assert.equal(JSON.stringify(page).includes("learner-a"), false);
  assert.equal((await f.service.feed(1, page.cursor!)).items.length, 0);
  const range = await f.http(`/api/media/${record.id}/playback`, null, {
    headers: { range: "bytes=2-6" },
  });
  assert.equal(range?.status, 206);
  assert.equal(
    range?.headers.get("content-range"),
    `bytes 2-6/${f.source.length}`,
  );
  assert.deepEqual(
    new Uint8Array(await range!.arrayBuffer()),
    f.source.slice(2, 7),
  );
  const head = await f.http(`/api/media/${record.id}/playback`, null, {
    method: "HEAD",
  });
  assert.equal(head?.status, 200);
  assert.equal(await head!.text(), "");
  const suffix = await f.http(`/api/media/${record.id}/playback`, null, {
    headers: { range: "bytes=-5" },
  });
  assert.deepEqual(
    new Uint8Array(await suffix!.arrayBuffer()),
    f.source.slice(-5),
  );
  for (const range of ["bytes=9999-", "bytes=0-2,5-7", "bytes=-0", "bytes=7-2"])
    assert.equal(
      (
        await f.http(`/api/media/${record.id}/playback`, null, {
          headers: { range },
        })
      )?.status,
      416,
    );
  f.deactivate();
  assert.equal((await f.service.feed()).items.length, 0);
  assert.equal(
    (await f.http(`/api/media/${record.id}/playback`, null))?.status,
    403,
  );
});

test("expiry and withdrawal invalidate a witness atomically with verdict insertion", async (t) => {
  const f = await fixture(t),
    record = await f.ready();
  const { witness } = await f.service.readyForReview(
    record.id,
    record,
    reviewer,
  );
  await f.db.prepare("CREATE TABLE verdict_fixture(id TEXT PRIMARY KEY)").run();
  const commit = () =>
    f.db
      .prepare(
        `INSERT INTO verdict_fixture SELECT ? WHERE ${MEDIA_COMMIT_GUARD}`,
      )
      .bind(crypto.randomUUID(), ...mediaCommitValues(witness, f.now()))
      .run();
  assert.equal((await commit()).meta.changes, 1);
  await f.service.withdraw(record.id, actor);
  assert.equal((await commit()).meta.changes, 0);
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(record.id) })).objects
      .length,
    0,
  );
  assert.equal(
    (await f.http(`/api/media/${record.id}/playback`, actor))?.status,
    410,
  );
  const second = await f.ready({ requestId: "request_0002" });
  f.setNow(second.expiresAt);
  assert.equal(
    (await f.http(`/api/media/${second.id}/playback`, actor))?.status,
    410,
  );
  await f.service.recover();
  assert.equal((await f.repository.get(second.id)).state, "expired");
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(second.id) })).objects
      .length,
    0,
  );
});

test("digest, song revision, origin and streamed size fences fail closed", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  await assert.rejects(
    f.service.upload(item.id, actor, new Uint8Array([1])),
    /media_recording_mismatch/,
  );
  assert.equal(
    (
      await f.http(`/api/media/${item.id}/upload`, actor, {
        method: "PUT",
        body: f.source,
      })
    )?.status,
    403,
  );
  assert.equal(
    (
      await f.http(`/api/media/${item.id}/upload`, actor, {
        method: "PUT",
        headers: { origin: "https://community.example" },
        body: new Uint8Array(1000),
      })
    )?.status,
    413,
  );
  f.changeSong();
  await assert.rejects(
    f.service.upload(item.id, actor, f.source),
    /media_song_revision_changed/,
  );
});

test("interval endpoints use exact integer samples", () => {
  const song: PublishedMediaSong = {
    communityId: "c",
    songKey: "s",
    songRevision: 1,
    audioSha256: "a".repeat(64),
    durationSamples: 15 * SAMPLE_RATE,
    title: "Fixture",
  };
  const intent: MediaIntent = {
    requestId: "abcdefgh",
    songKey: "s",
    songRevision: 1,
    recordingSha256: "b".repeat(64),
    bytes: 1,
    startSample: 0,
    durationSamples: 15 * SAMPLE_RATE,
    purpose: "private-review",
    publicConsent: false,
  };
  validateIntent(intent, song);
  for (const durationSamples of [
    3 * SAMPLE_RATE - 1,
    15 * SAMPLE_RATE + 1,
    NaN,
  ])
    assert.throws(() => validateIntent({ ...intent, durationSamples }, song));
  assert.throws(
    () => validateIntent({ ...intent, startSample: 1 }, song),
    /media_song_interval_uncovered/,
  );
});
