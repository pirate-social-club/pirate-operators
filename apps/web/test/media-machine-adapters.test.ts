// Prepared only; coordinator owns dependency custody and execution gates.
import assert from "node:assert/strict";
import test from "node:test";
import { createActor, waitFor } from "xstate";
import { mediaClient, MediaHttpError } from "../src/media/client.ts";
import {
  digestBytes,
  MEDIA_ATTEMPT_VERSION,
  MediaAttemptController,
  type MediaAttempt,
  type MediaAttemptStorage,
} from "../src/media/media-attempt.ts";
import type { MediaStatus } from "../../../packages/community-media/contracts.ts";
import { createTextSubmissionMachine } from "../src/media/reference/src/features/posts/text-submission/text-submission-machine.ts";
import {
  TextSubmissionAuthenticationRequiredError,
  TextSubmissionServerRejectionError,
} from "../src/media/reference/src/features/posts/post-composer/text-submission-transport.ts";
import { createSongObservationMachine } from "../src/media/reference/src/features/posts/song-submission/song-observation-machine.ts";
import {
  createVideoComposerMachine,
  type ComposerOperations,
} from "../src/media/reference/src/features/posts/video-submission/video-composer-machine.ts";
import type { TextContentSubmissionV1 } from "../src/media/reference/src/features/posts/post-composer/text-submission-contract.ts";
import type { PendingSubmissionEnvelopeV1 } from "../src/media/reference/src/features/posts/post-composer/pending-submission.ts";

// Protocol simulation: real HTTP adapter, explicit in-memory server responses.
// These fixtures are never imported by product code or backed by a provider.
async function retained(pending: MediaAttempt["pending"] = "reserve") {
  const file = new File(["recording bytes"], "recording.mp4", {
    type: "video/mp4",
  });
  const intent = {
    requestId: "request-fixture",
    songKey: "song-fixture",
    songRevision: 1,
    recordingSha256: await digestBytes(await file.arrayBuffer()),
    bytes: file.size,
    startSample: 0,
    durationSamples: 480000,
    purpose: "public-feed" as const,
    publicConsent: true,
  };
  return {
    version: MEDIA_ATTEMPT_VERSION,
    accountId: "account-fixture",
    communityId: "community-fixture",
    file,
    rating: "general" as const,
    song: {
      communityId: "community-fixture",
      songKey: intent.songKey,
      songRevision: 1,
      audioSha256: "a".repeat(64),
      durationSamples: 960000,
      title: "Fixture song",
    },
    intent,
    intentDigest: await digestBytes(
      new TextEncoder().encode(JSON.stringify(intent)),
    ),
    status:
      pending === "reserve"
        ? null
        : {
            id: "media-fixture",
            state: "uploading" as const,
            purpose: "public-feed" as const,
            expiresAt: 2000000000000,
            canRetry: false,
          },
    pending,
  } satisfies MediaAttempt;
}
function memory(
  seed: MediaAttempt,
): MediaAttemptStorage & { value: () => MediaAttempt | null } {
  let value: MediaAttempt | null = seed;
  return {
    exclusive: (work) => work(),
    load: async () => value,
    save: async (record) => {
      value = record;
    },
    remove: async () => {
      value = null;
    },
    value: () => value,
  };
}
const json = (status: MediaStatus) => Response.json(status);
const status = (state: MediaStatus["state"]): MediaStatus => ({
  id: "media-fixture",
  purpose: "public-feed",
  state,
  canRetry: state === "failed",
  expiresAt: 2000000000000,
});
function controller(storage: MediaAttemptStorage, transport: typeof fetch) {
  return new MediaAttemptController({
    storage,
    accountId: "account-fixture",
    communityId: "community-fixture",
    client: mediaClient(() => "csrf-fixture", transport),
  });
}

test(
  "lost reservation acknowledgement replays exact persisted identity through real HTTP adapter",
  { timeout: 2000 },
  async () => {
    const storage = memory(await retained());
    const bodies: string[] = [];
    let lose = true;
    const transport: typeof fetch = async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init.headers).get("x-csrf-token"),
        "csrf-fixture",
      );
      bodies.push(String(init.body));
      if (lose) {
        lose = false;
        throw new TypeError("Lost response after simulated canonical commit");
      }
      return json(status("uploading"));
    };
    await assert.rejects(controller(storage, transport).restore());
    assert.equal(storage.value()?.pending, "reserve");
    await controller(storage, transport).restore();
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(storage.value()?.status?.id, "media-fixture");
  },
);

test(
  "lost upload acknowledgement reads canonical queued job without uploading again",
  { timeout: 2000 },
  async () => {
    const storage = memory(await retained("upload"));
    let uploads = 0;
    await controller(storage, async (_input, init) => {
      if (init?.method === "PUT") uploads++;
      return json(status("queued"));
    }).restore();
    assert.equal(uploads, 0);
    assert.equal(storage.value()?.status?.state, "queued");
    assert.equal(storage.value()?.pending, null);
  },
);

test(
  "cancel during upload aborts bytes and preserves receipt for reload reconciliation",
  { timeout: 2000 },
  async () => {
    const storage = memory(await retained("upload"));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lane = controller(storage, async (_input, init) => {
      if (init?.method !== "PUT") return json(status("uploading"));
      entered();
      return new Promise((_resolve, reject) =>
        init.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Paused", "AbortError")),
          { once: true },
        ),
      );
    });
    const work = lane.restore();
    await started;
    lane.pause();
    await assert.rejects(work);
    assert.equal(storage.value()?.pending, "upload");
    await controller(storage, async () => json(status("processing"))).restore();
    assert.equal(storage.value()?.status?.state, "processing");
  },
);

test(
  "pending failed withdrawal denies playback immediately and survives reload",
  { timeout: 2000 },
  async () => {
    const record = await retained(null);
    const storage = memory({
      ...record,
      status: {
        ...status("ready"),
        playbackUrl: "/api/media/media-fixture/playback",
      },
    });
    let fail = false;
    const lane = controller(storage, async (_input, init) => {
      if (init?.method === "DELETE") {
        fail = true;
        throw new TypeError("Lost erasure acknowledgement");
      }
      return json({
        ...status("ready"),
        playbackUrl: "/api/media/media-fixture/playback",
      });
    });
    await lane.restore();
    await assert.rejects(lane.withdraw());
    assert.ok(fail);
    assert.equal(lane.playbackUrl, undefined);
    assert.equal(storage.value()?.pending, "withdraw");
    await controller(storage, async () => json(status("withdrawn"))).restore();
    assert.equal(storage.value()?.status?.state, "withdrawn");
  },
);

test(
  "server denial is a refusal; a fresh public attempt remains capability refused",
  { timeout: 2000 },
  async () => {
    const storage = memory(await retained());
    await assert.rejects(
      controller(storage, async () =>
        Response.json(
          { error: "media_public_posting_not_permitted" },
          { status: 403 },
        ),
      ).restore(),
      MediaHttpError,
    );
    assert.equal(
      storage.value()?.rejection,
      "media_public_posting_not_permitted",
    );
    const fresh = memory(await retained());
    await fresh.remove();
    let calls = 0;
    const record = await retained();
    await assert.rejects(
      controller(fresh, async () => {
        calls++;
        throw new Error("Must not dispatch");
      }).begin({
        file: record.file,
        rating: "general",
        song: record.song,
        startSample: 0,
        durationSamples: 480000,
      }),
      MediaHttpError,
    );
    assert.equal(calls, 0);
    assert.equal(fresh.value(), null);
  },
);

// Source transition fixtures follow c7 text-submission-machine.test.ts.
const envelope: PendingSubmissionEnvelopeV1 = {
  version: "pending-submission-v1",
  pending_request_id: "pending-fixture",
  idempotency_key: "key-fixture",
  method: "POST",
  same_origin_path: "/api/fixture/text",
  content_type: "application/json",
  body_utf8_base64url: "e30",
  body_sha256: "digest-fixture",
  submission_id: null,
  created_at: "2026-11-11T00:00:00Z",
};
const published: TextContentSubmissionV1 = {
  submission_id: "submission-fixture",
  href: "/submissions/fixture",
  surface: "text_post",
  status: "published",
  result: { decision: "allow", reason_code: null },
  published_resource: {
    kind: "post",
    post_id: "post-fixture",
    href: "/posts/fixture",
  },
  review_ref: null,
  created_at: envelope.created_at,
  updated_at: envelope.created_at,
};
test(
  "actual text machine holds auth and replays the original envelope after lost acknowledgement",
  { timeout: 2000 },
  async () => {
    const seen: PendingSubmissionEnvelopeV1[] = [];
    let replies = 0;
    const actor = createActor(
      createTextSubmissionMachine({
        read: async () => null,
        dispatch: async (next) => {
          seen.push(next);
          replies++;
          if (replies === 1)
            throw new TextSubmissionAuthenticationRequiredError();
          if (replies === 2) throw new TypeError("Unconfirmed");
          return published;
        },
      }),
      { input: { envelope } },
    ).start();
    try {
      await waitFor(actor, (next) => next.matches("signInRequired"), {
        timeout: 500,
      });
      actor.send({ type: "RESUME" });
      await waitFor(
        actor,
        (next) => next.context.attempts === 2 && !next.matches("sending"),
        { timeout: 500 },
      );
      actor.send({ type: "RETRY" });
      await waitFor(actor, (next) => next.matches("published"), {
        timeout: 500,
      });
      assert.ok(seen.every((next) => next === envelope));
      assert.equal(actor.getSnapshot().context.postId, "post-fixture");
    } finally {
      actor.stop();
    }
  },
);
test(
  "actual text machine reports a definitive service refusal",
  { timeout: 2000 },
  async () => {
    const actor = createActor(
      createTextSubmissionMachine({
        read: async () => null,
        dispatch: async () => {
          throw new TextSubmissionServerRejectionError(
            403,
            "membership_required",
          );
        },
      }),
      { input: { envelope } },
    ).start();
    try {
      await waitFor(actor, (next) => next.matches("rejected"), {
        timeout: 500,
      });
      assert.equal(actor.getSnapshot().context.rejection, "not_allowed");
    } finally {
      actor.stop();
    }
  },
);
test(
  "actual song observer resumes canonical observation after auth pause",
  { timeout: 2000 },
  async () => {
    let retry = 0;
    let reads = 0;
    const actor = createActor(
      createSongObservationMachine(
        {
          refresh: async () => {
            reads++;
            return {
              status: "processing",
              submissionId: "song-fixture",
              phase: "analysis",
            };
          },
          retry: async () => {
            retry++;
            throw new TypeError("Lost retry reply");
          },
        },
        100000,
      ),
      {
        input: {
          view: {
            status: "processing_failed",
            submissionId: "song-fixture",
            reasonCode: "unconfirmed",
            retryable: true,
          },
        },
      },
    ).start();
    try {
      actor.send({ type: "PAUSE" });
      assert.ok(actor.getSnapshot().matches("held"));
      actor.send({ type: "RESUME" });
      await waitFor(
        actor,
        (next) => next.context.view.status === "processing",
        { timeout: 500 },
      );
      assert.equal(reads, 1);
      assert.equal(retry, 0);
    } finally {
      actor.stop();
    }
  },
);

test(
  "actual song observer reads after a lost retry and replays retained original binding explicitly",
  { timeout: 2000 },
  async () => {
    let retry = 0,
      original = 0,
      pending = true;
    const view = {
      status: "action_required" as const,
      submissionId: "song-fixture",
      expiresAt: "2099-01-01T00:00:00Z",
      referenceRequestRef: "original-fixture",
    };
    const actor = createActor(
      createSongObservationMachine(
        {
          refresh: async () => view,
          retry: async () => {
            retry++;
            throw new TypeError("Lost retry response");
          },
          hasPendingOriginal: () => pending,
          retryOriginal: async () => {
            original++;
            pending = false;
            return {
              status: "processing",
              submissionId: "song-fixture",
              phase: "analysis",
            };
          },
        },
        100000,
      ),
      {
        input: {
          view: {
            status: "processing_failed",
            submissionId: "song-fixture",
            reasonCode: "retryable",
            retryable: true,
          },
        },
      },
    ).start();
    try {
      actor.send({ type: "RETRY" });
      await waitFor(
        actor,
        (next) => next.context.view.status === "action_required",
        { timeout: 500 },
      );
      assert.equal(retry, 1);
      actor.send({ type: "PAUSE" });
      actor.send({ type: "RESUME" });
      await waitFor(actor, (next) => next.matches("waitingForAuthor"), {
        timeout: 500,
      });
      actor.send({ type: "RETRY_ORIGINAL" });
      await waitFor(
        actor,
        (next) => next.context.view.status === "processing",
        { timeout: 500 },
      );
      assert.equal(original, 1);
      assert.equal(pending, false);
    } finally {
      actor.stop();
    }
  },
);

test(
  "recovered ready receipt keeps exact binding and rejects a public object URL",
  { timeout: 2000 },
  async () => {
    const record = await retained("upload");
    const storage = memory(record);
    const ready = {
      version: "pirate.community-media/1" as const,
      id: "media-fixture",
      revision: 7,
      communityId: record.communityId,
      accountId: record.accountId,
      songKey: record.song.songKey,
      songRevision: record.song.songRevision,
      audioSha256: record.song.audioSha256,
      recordingSha256: record.intent.recordingSha256,
      startSample: 0,
      durationSamples: 480000,
      mediaPolicyVersion: "public-clip-fixture/1",
      purpose: "public-feed" as const,
      readyAt: 1000000000000,
      expiresAt: 2000000000000,
      rendition: {
        sha256: "b".repeat(64),
        bytes: 100,
        durationMs: 10000,
        width: 720,
        height: 1280,
        videoCodec: "h264" as const,
        audioCodec: "aac" as const,
      },
    };
    let receipt: unknown;
    const lane = new MediaAttemptController({
      storage,
      accountId: record.accountId,
      communityId: record.communityId,
      client: mediaClient(
        () => "csrf-fixture",
        async () =>
          json({
            ...status("ready"),
            ready,
            playbackUrl: "/api/media/media-fixture/playback",
          }),
      ),
      onReady: (next) => {
        receipt = next;
      },
    });
    await lane.restore();
    assert.deepEqual(receipt, ready);
    assert.equal(storage.value()?.status?.ready?.revision, 7);
    await assert.rejects(
      controller(storage, async () =>
        json({
          ...status("ready"),
          ready,
          playbackUrl: "https://public-object.invalid/video.mp4",
        }),
      ).refresh(),
    );
  },
);

test(
  "actual video machine cancels an interrupted take and returns to capture idle",
  { timeout: 2000 },
  async () => {
    let cancel = 0;
    const file = new File(["take"], "take.mp4");
    const operations: ComposerOperations = {
      restore: async () => ({ record: null, released: false, resume: false }),
      checkPlayback: async () => {},
      inspectFile: async (file) => ({
        file,
        durationMs: 10000,
        alignment: "none",
      }),
      prepareGuide: async (guide) => ({
        guide,
        audio: {
          currentTime: 0,
          play: async () => {},
          pause() {},
          addEventListener() {},
          removeEventListener() {},
        },
      }),
      startCapture: async (prepared) => ({
        prepared,
        session: {
          stream: Object.create(null),
          captureOriginMs: 0,
          stop: async () => file,
          cancel: async () => {},
        },
      }),
      startGuide: async () => ({ started: true, delayMs: 0 }),
      finishCapture: async () => ({
        file,
        durationMs: 10000,
        alignment: "aligned",
      }),
      cancelCapture: async () => {
        cancel++;
      },
      publish: async () => ({ posted: false }),
      startOver: async () => {},
      refresh: async () => false,
      canCapture: (context) => context.selection !== null,
      canPublish: (context) => context.file !== null,
      shouldRefresh: () => false,
      onPosted() {},
      onExit() {},
      onReset() {},
      syncPreview() {},
      closePreview() {},
      discardPrepared() {},
    };
    const actor = createActor(
      createVideoComposerMachine(operations, true),
    ).start();
    try {
      await waitFor(actor, (next) => next.matches("choosingSong"), {
        timeout: 500,
      });
      actor.send({
        type: "SELECTION",
        selection: {
          songPostId: "song-fixture",
          title: "Fixture",
          audioUrl: "/fixture/audio",
          bounds: { startMs: 0, endMs: 10000 },
        },
      });
      actor.send({ type: "CONTINUE" });
      await waitFor(actor, (next) => next.matches({ capture: "idle" }), {
        timeout: 500,
      });
      actor.send({ type: "RECORD" });
      await waitFor(actor, (next) => next.matches({ capture: "recording" }), {
        timeout: 500,
      });
      actor.send({ type: "INTERRUPT" });
      await waitFor(actor, (next) => next.matches({ capture: "idle" }), {
        timeout: 500,
      });
      assert.equal(cancel, 1);
      assert.equal(actor.getSnapshot().context.file, null);
    } finally {
      actor.stop();
    }
  },
);
