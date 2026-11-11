// Prepared, not run by the source actor. Default strip-only node --test;
// real media HTTP adapter and exact adopted machines, explicit memory services.
import assert from "node:assert/strict";
import test from "node:test";
import { createActor, waitFor, type ActorRefFrom } from "xstate";
import { mediaClient, MediaHttpError } from "../src/media/client.ts";
import {
  MediaAttemptController,
  MEDIA_ATTEMPT_VERSION,
  digestBytes,
  mediaNeedsStartOver,
  type MediaAttempt,
  type MediaAttemptPorts,
  type MediaAttemptStorage,
} from "../src/media/media-attempt.ts";
import { createMediaOwnerLifetime } from "../src/media/media-owner-lifetime.ts";
import type {
  MediaStatus,
  ReadyMedia,
} from "../../../packages/community-media/contracts.ts";
import {
  createVideoComposerMachine,
  type ComposerOperations,
} from "../src/media/reference/src/features/posts/video-submission/video-composer-machine.ts";
import { createTextSubmissionMachine } from "../src/media/reference/src/features/posts/text-submission/text-submission-machine.ts";
import {
  IdempotencyConflictError,
  TextSubmissionAuthenticationRequiredError,
} from "../src/media/reference/src/features/posts/post-composer/text-submission-transport.ts";
import type { PendingSubmissionEnvelopeV1 } from "../src/media/reference/src/features/posts/post-composer/pending-submission.ts";
import { createPendingSubmissionEnvelope } from "../src/media/reference/src/features/posts/post-composer/pending-submission.ts";
import type { TextContentSubmissionV1 } from "../src/media/reference/src/features/posts/post-composer/text-submission-contract.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const status = (
  state: MediaStatus["state"],
  extra: Partial<MediaStatus> = {},
): MediaStatus => ({
  id: "media-fixture",
  purpose: "public-feed",
  state,
  canRetry: false,
  expiresAt: 2000000000000,
  ...extra,
});
async function seed(
  pending: MediaAttempt["pending"] = null,
  state: MediaStatus["state"] = "uploading",
): Promise<MediaAttempt> {
  const file = new File(["fixture recording bytes"], "fixture.mp4", {
    type: "video/mp4",
  });
  const intent = {
    requestId: "request-fixture",
    songKey: "song-fixture",
    songRevision: 7,
    recordingSha256: await digestBytes(await file.arrayBuffer()),
    bytes: file.size,
    startSample: 48000,
    durationSamples: 480000,
    purpose: "public-feed" as const,
    publicConsent: true,
  };
  return {
    version: MEDIA_ATTEMPT_VERSION,
    accountId: "account-fixture",
    communityId: "community-fixture",
    file,
    rating: "general",
    song: {
      communityId: "community-fixture",
      songKey: intent.songKey,
      songRevision: 7,
      audioSha256: "a".repeat(64),
      durationSamples: 960000,
      title: "Fixture",
    },
    intent,
    intentDigest: await digestBytes(
      new TextEncoder().encode(JSON.stringify(intent)),
    ),
    status: pending === "reserve" ? null : status(state),
    pending,
  };
}
function ready(record: MediaAttempt): ReadyMedia {
  return {
    version: "pirate.community-media/1",
    id: "media-fixture",
    revision: 9,
    accountId: record.accountId,
    communityId: record.communityId,
    songKey: record.intent.songKey,
    songRevision: record.intent.songRevision,
    audioSha256: record.song.audioSha256,
    recordingSha256: record.intent.recordingSha256,
    startSample: record.intent.startSample,
    durationSamples: record.intent.durationSamples,
    mediaPolicyVersion: "fixture-policy/1",
    purpose: "public-feed",
    readyAt: 1900000000000,
    expiresAt: 2000000000000,
    rendition: {
      sha256: "b".repeat(64),
      bytes: 120,
      durationMs: 10000,
      width: 720,
      height: 1280,
      videoCodec: "h264",
      audioCodec: "aac",
    },
  };
}
function memory(
  record: MediaAttempt,
  onSave?: (record: MediaAttempt) => Promise<void> | void,
  afterSave?: (record: MediaAttempt) => void,
) {
  let value: MediaAttempt | null = record,
    lock: Promise<unknown> = Promise.resolve();
  const history: MediaAttempt[] = [];
  const storage: MediaAttemptStorage = {
    exclusive<T>(work: () => Promise<T>) {
      const next = lock.then(work);
      lock = next.catch(() => {});
      return next;
    },
    load: async () => value,
    save: async (next) => {
      await onSave?.(next);
      value = next;
      history.push(next);
      afterSave?.(next);
    },
    remove: async () => {
      value = null;
    },
  };
  return { storage, history, value: () => value };
}
function make(
  store: ReturnType<typeof memory>,
  wire: typeof fetch,
  extra: Partial<MediaAttemptPorts> = {},
) {
  return new MediaAttemptController({
    storage: store.storage,
    accountId: "account-fixture",
    communityId: "community-fixture",
    client: mediaClient(() => "csrf-fixture", wire),
    ...extra,
  });
}

test(
  "MediaHttpError loads under the unchanged strip-only Node entry and retains its fields",
  { timeout: 2000 },
  () => {
    const failure = new MediaHttpError(401, "media_authentication_required");
    assert.equal(failure.status, 401);
    assert.equal(failure.code, "media_authentication_required");
    assert.ok(failure instanceof Error);
    assert.equal(failure.name, "MediaHttpError");
  },
);

test(
  "interrupted-upload withdrawal persists DELETE intent and sends DELETE only",
  { timeout: 2000 },
  async () => {
    const store = memory(await seed("upload"));
    const order: string[] = [];
    const lane = make(store, async (url, init) => {
      order.push(`${init?.method ?? "GET"} ${url}`);
      assert.equal(store.value()?.pending, "withdraw");
      assert.equal(init?.method, "DELETE");
      assert.equal(init.body, undefined);
      return Response.json(status("withdrawn"));
    });
    await lane.withdraw();
    assert.deepEqual(order, ["DELETE /api/media/media-fixture"]);
    assert.equal(store.history[0].pending, "withdraw");
    assert.equal(lane.playbackUrl, undefined);
    await lane.discard();
    assert.equal(store.value(), null);
  },
);

for (const late of ["failed", "ready"] as const)
  test(
    `withdrawal preempts ${late} late PUT without retransmission or stale ready callback`,
    { timeout: 2000 },
    async () => {
      const record = await seed("upload");
      const persisted = deferred<void>(),
        putEntered = deferred<void>(),
        put = deferred<Response>(),
        deleteEntered = deferred<void>(),
        deletion = deferred<Response>();
      const store = memory(record, undefined, (next) => {
        if (next.pending === "withdraw") persisted.resolve();
      });
      const order: string[] = [];
      let notified = 0,
        signal: AbortSignal | undefined;
      const lane = make(
        store,
        async (_url, init) => {
          const method = init?.method ?? "GET";
          order.push(method);
          if (method === "GET") return Response.json(status("uploading"));
          if (method === "PUT") {
            signal = init?.signal ?? undefined;
            putEntered.resolve();
            return put.promise;
          }
          assert.equal(method, "DELETE");
          assert.equal(store.value()?.pending, "withdraw");
          deleteEntered.resolve();
          return deletion.promise;
        },
        {
          onReady: () => {
            notified++;
          },
        },
      );
      const uploadOutcome = lane.restore().then(
        () => null,
        (error) => error,
      );
      await putEntered.promise;
      const closing = lane.withdraw();
      assert.equal(lane.playbackUrl, undefined);
      await persisted.promise;
      assert.equal(store.value()?.pending, "withdraw");
      assert.equal(signal?.aborted, true);
      if (late === "failed")
        put.reject(new TypeError("Late PUT failed after abort"));
      else
        put.resolve(
          Response.json(
            status("ready", {
              ready: ready(record),
              playbackUrl: "/api/media/media-fixture/playback",
            }),
          ),
        );
      await deleteEntered.promise;
      assert.ok(await uploadOutcome);
      assert.equal(notified, 0);
      assert.equal(store.value()?.pending, "withdraw");
      if (late === "ready")
        assert.ok(
          store.history.some(
            (next) =>
              next.status?.ready?.revision === 9 && next.pending === "withdraw",
          ),
        );
      assert.deepEqual(order, ["GET", "PUT", "DELETE"]);
      deletion.resolve(Response.json(status("withdrawn")));
      await closing;
      assert.equal(store.value()?.status?.state, "withdrawn");
    },
  );

test(
  "lost reserve identity is reconciled with the same POST only before DELETE; deletion survives reload",
  { timeout: 2000 },
  async () => {
    const record = await seed("reserve"),
      store = memory(record);
    const order: string[] = [],
      bodies: string[] = [];
    let deleteAttempts = 0;
    const wire: typeof fetch = async (_url, init) => {
      order.push(init?.method ?? "GET");
      assert.equal(store.value()?.pending, "withdraw");
      if (init?.method === "POST") {
        bodies.push(String(init.body));
        return Response.json(status("uploading"));
      }
      assert.equal(init?.method, "DELETE");
      if (++deleteAttempts === 1)
        throw new TypeError("Lost DELETE acknowledgement");
      return Response.json(status("revoked"));
    };
    const lane = make(store, wire);
    await assert.rejects(lane.withdraw());
    assert.equal(store.value()?.pending, "withdraw");
    assert.equal(lane.playbackUrl, undefined);
    await assert.rejects(
      lane.begin({
        file: record.file,
        rating: "general",
        song: record.song,
        startSample: 48000,
        durationSamples: 480000,
      }),
    );
    assert.deepEqual(order, ["POST", "DELETE"]);
    assert.equal(bodies[0], JSON.stringify(record.intent));
    const reloaded = make(store, wire);
    await reloaded.restore();
    await reloaded.discard();
    assert.deepEqual(order, ["POST", "DELETE", "DELETE"]);
    assert.equal(store.value(), null);
  },
);

test(
  "withdrawal during canonical GET prevents its late uploading reply from starting PUT",
  { timeout: 2000 },
  async () => {
    const entered = deferred<void>(),
      response = deferred<Response>(),
      persisted = deferred<void>();
    const store = memory(await seed("upload"), undefined, (record) => {
      if (record.pending === "withdraw") persisted.resolve();
    });
    const order: string[] = [];
    const lane = make(store, async (_url, init) => {
      const method = init?.method ?? "GET";
      order.push(method);
      if (method === "GET") {
        entered.resolve();
        return response.promise;
      }
      assert.equal(method, "DELETE");
      return Response.json(status("withdrawn"));
    });
    const prior = lane.restore().then(
      () => null,
      (error) => error,
    );
    await entered.promise;
    const closing = lane.withdraw();
    await persisted.promise;
    response.resolve(Response.json(status("uploading")));
    assert.ok(await prior);
    await closing;
    assert.deepEqual(order, ["GET", "DELETE"]);
    assert.equal(store.value()?.status?.state, "withdrawn");
  },
);

test(
  "auth during identity-only withdrawal keeps the delete marker through reauthentication",
  { timeout: 2000 },
  async () => {
    const record = await seed("reserve"),
      store = memory(record);
    let held = true;
    const order: string[] = [],
      bodies: string[] = [];
    const wire: typeof fetch = async (_url, init) => {
      order.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        bodies.push(String(init.body));
        if (held)
          return Response.json(
            { error: "media_authentication_required" },
            { status: 401 },
          );
        return Response.json(status("uploading"));
      }
      assert.equal(init?.method, "DELETE");
      return Response.json(status("withdrawn"));
    };
    await assert.rejects(make(store, wire).withdraw());
    assert.equal(store.value()?.pending, "withdraw");
    assert.equal(store.value()?.authenticationHold, true);
    held = false;
    const reloaded = make(store, wire);
    await reloaded.restore();
    await reloaded.discard();
    assert.deepEqual(order, ["POST", "POST", "DELETE"]);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(store.value(), null);
  },
);

for (const authStatus of [401, 403])
  test(
    `lost reserve then ${authStatus} retains immutable envelope until same-account reconciliation`,
    { timeout: 2000 },
    async () => {
      const record = await seed("reserve"),
        store = memory(record);
      let attempt = 0,
        csrf = "old-session";
      const bodies: string[] = [],
        tokens: (string | null)[] = [];
      const client = mediaClient(
        () => csrf,
        async (_url, init) => {
          assert.equal(init?.method, "POST");
          bodies.push(String(init.body));
          tokens.push(new Headers(init.headers).get("x-csrf-token"));
          if (++attempt === 1)
            throw new TypeError("Reservation committed, acknowledgement lost");
          if (attempt === 2)
            return Response.json(
              { error: "media_authentication_required" },
              { status: authStatus },
            );
          return Response.json(status("uploading"));
        },
      );
      const lane = make(
        store,
        async () => {
          throw new Error("Unused transport");
        },
        { client },
      );
      await assert.rejects(lane.restore());
      await assert.rejects(lane.restore());
      assert.equal(store.value()?.pending, "reserve");
      assert.equal(store.value()?.authenticationHold, true);
      assert.equal(store.value()?.intentDigest, record.intentDigest);
      assert.equal(store.value()?.file, record.file);
      await assert.rejects(lane.discard());
      await assert.rejects(
        lane.begin({
          file: record.file,
          rating: "general",
          song: record.song,
          startSample: 48000,
          durationSamples: 480000,
        }),
      );
      assert.equal(attempt, 2);
      csrf = "reauthenticated-session";
      await lane.restore();
      assert.equal(store.value()?.pending, null);
      assert.equal(store.value()?.authenticationHold, undefined);
      assert.equal(store.value()?.status?.id, "media-fixture");
      assert.ok(bodies.every((body) => body === JSON.stringify(record.intent)));
      assert.deepEqual(tokens, [
        "old-session",
        "old-session",
        "reauthenticated-session",
      ]);
    },
  );

test(
  "only a first-dispatch definitive refusal allows discard; an uncertain prior dispatch does not",
  { timeout: 2000 },
  async () => {
    for (const previouslyDispatched of [false, true]) {
      const store = memory({
        ...(await seed("reserve")),
        commandDispatched: previouslyDispatched,
      });
      const lane = make(store, async () =>
        Response.json({ error: "media_invalid_intent" }, { status: 400 }),
      );
      await assert.rejects(lane.restore());
      if (previouslyDispatched) {
        assert.equal(store.value()?.pending, "reserve");
        await assert.rejects(lane.discard());
      } else {
        assert.equal(store.value()?.pending, null);
        await lane.discard();
        assert.equal(store.value(), null);
      }
    }
  },
);

for (const obsolete of ["pause", "dispose", "account", "community"] as const)
  test(
    `late canonical ready is durable without ${obsolete} host notification`,
    { timeout: 2000 },
    async () => {
      const record = await seed(null, "processing"),
        store = memory(record),
        response = deferred<Response>(),
        entered = deferred<void>();
      let current = {
        accountId: record.accountId,
        communityId: record.communityId,
      };
      const lifetime = createMediaOwnerLifetime(
        record.accountId,
        record.communityId,
        () => current,
      );
      let readyCalls = 0,
        changes = 0;
      const lane = make(
        store,
        async () => {
          entered.resolve();
          return response.promise;
        },
        {
          isCurrentOwner: lifetime.current,
          onReady: () => {
            readyCalls++;
          },
          onChange: () => {
            changes++;
          },
        },
      );
      const outcome = lane.restore().then(
        () => null,
        (error) => error,
      );
      await entered.promise;
      const before = changes;
      if (obsolete === "pause") lane.pause();
      if (obsolete === "dispose") {
        lifetime.dispose();
        lane.dispose();
      }
      if (obsolete === "account")
        current = { ...current, accountId: "successor-account" };
      if (obsolete === "community")
        current = { ...current, communityId: "successor-community" };
      response.resolve(
        Response.json(
          status("ready", {
            ready: ready(record),
            playbackUrl: "/api/media/media-fixture/playback",
          }),
        ),
      );
      assert.ok(await outcome);
      assert.equal(store.value()?.status?.ready?.revision, 9);
      assert.equal(readyCalls, 0);
      assert.equal(changes, before);
      // Positive control: a new, current owner can reconcile that durable receipt.
      let resumed = 0;
      await make(
        store,
        async () => Response.json(status("ready", { ready: ready(record) })),
        {
          onReady: () => {
            resumed++;
          },
        },
      ).restore();
      assert.equal(resumed, 1);
      let foreignReads = 0;
      await assert.rejects(
        make(
          store,
          async () => {
            foreignReads++;
            return Response.json(status("ready"));
          },
          { accountId: "successor-account" },
        ).restore(),
      );
      assert.equal(foreignReads, 0);
    },
  );

test(
  "pause while canonical receipt is saving fences callbacks after the durable save completes",
  { timeout: 2000 },
  async () => {
    const record = await seed(null, "processing"),
      saving = deferred<void>(),
      saved = deferred<void>();
    const store = memory(record, async (next) => {
      if (next.status?.ready) {
        saving.resolve();
        await saved.promise;
      }
    });
    let notified = 0;
    const lane = make(
      store,
      async () => Response.json(status("ready", { ready: ready(record) })),
      {
        onReady: () => {
          notified++;
        },
      },
    );
    const outcome = lane.restore().then(
      () => null,
      (error) => error,
    );
    await saving.promise;
    lane.pause();
    saved.resolve();
    assert.ok(await outcome);
    assert.equal(notified, 0);
    assert.equal(store.value()?.status?.ready?.revision, 9);
  },
);

test(
  "flow lifetime fences queued work and cannot resurrect after an observed owner switch",
  { timeout: 2000 },
  () => {
    let owner = {
      accountId: "account-fixture",
      communityId: "community-fixture",
    };
    const life = createMediaOwnerLifetime(
        owner.accountId,
        owner.communityId,
        () => owner,
      ),
      pending = life.capture();
    assert.equal(pending(), true);
    owner = { ...owner, communityId: "other-community" };
    assert.equal(pending(), false);
    owner = { ...owner, communityId: "community-fixture" };
    assert.equal(pending(), false);
    const fresh = createMediaOwnerLifetime(
        owner.accountId,
        owner.communityId,
        () => owner,
      ),
      queued = fresh.capture();
    assert.equal(queued(), true);
    fresh.dispose();
    assert.equal(queued(), false);
  },
);

test(
  "actual controller notification generation fences the flow queue when pause follows a canonical save",
  { timeout: 2000 },
  async () => {
    const record = await seed(null, "processing"),
      store = memory(record);
    const lifetime = createMediaOwnerLifetime(
      record.accountId,
      record.communityId,
      () => record,
    );
    let writes = 0,
      readyCalls = 0;
    let lane!: MediaAttemptController;
    lane = make(
      store,
      async () => Response.json(status("ready", { ready: ready(record) })),
      {
        onChange: (next, notificationCurrent) => {
          if (next?.status?.state !== "ready") return;
          lifetime.queue(notificationCurrent, () => {
            writes++;
          });
          lane.pause();
        },
        onReady: () => {
          readyCalls++;
        },
      },
    );
    await assert.rejects(lane.restore());
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(writes, 0);
    assert.equal(readyCalls, 0);
    assert.equal(store.value()?.status?.ready?.revision, 9);
    lifetime.queue(
      () => true,
      () => {
        writes++;
      },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(writes, 1);
  },
);

function videoOperations(lane: MediaAttemptController): ComposerOperations {
  const unavailable = async (): Promise<never> => {
    throw new Error("Device operation outside this retained-flow case");
  };
  return {
    restore: async () => ({
      record: await lane.restore(),
      released: false,
      resume: false,
    }),
    checkPlayback: unavailable,
    inspectFile: unavailable,
    prepareGuide: unavailable,
    startCapture: unavailable,
    startGuide: unavailable,
    finishCapture: unavailable,
    cancelCapture: unavailable,
    publish: async () => {
      await lane.submit();
      return { posted: false };
    },
    startOver: async () => {
      await lane.startOver();
    },
    refresh: async () => {
      await lane.refresh();
      return false;
    },
    canCapture: () => false,
    canPublish: (context) => Boolean(context.record),
    shouldRefresh: () => false,
    onPosted() {
      throw new Error("A media receipt is not publication");
    },
    onExit() {},
    onReset() {},
    syncPreview() {},
    closePreview() {},
    discardPrepared() {},
  };
}

for (const terminal of ["withdrawn", "revoked", "expired"] as const)
  test(
    `actual video chart Start over discards canonical ${terminal} without retransmitting or deleting again`,
    { timeout: 2000 },
    async () => {
      const store = memory(await seed(null, terminal));
      let actor:
        | ActorRefFrom<ReturnType<typeof createVideoComposerMachine>>
        | undefined;
      const order: string[] = [];
      const lane = make(
        store,
        async (_url, init) => {
          order.push(init?.method ?? "GET");
          return Response.json(status(terminal));
        },
        {
          onChange: (record) => actor?.send({ type: "RECORD_CHANGED", record }),
        },
      );
      actor = createActor(
        createVideoComposerMachine(videoOperations(lane), true),
      );
      actor.start();
      try {
        await waitFor(actor, (next) => next.matches("retained"), {
          timeout: 500,
        });
        assert.equal(
          mediaNeedsStartOver(actor.getSnapshot().context.record),
          true,
        );
        await assert.rejects(lane.submit());
        assert.deepEqual(order, ["GET"]);
        actor.send({ type: "START_OVER" });
        await waitFor(actor, (next) => next.matches("choosingSong"), {
          timeout: 500,
        });
        assert.equal(store.value(), null);
        assert.deepEqual(order, ["GET"]);
      } finally {
        actor.stop();
      }
    },
  );

test(
  "actual video chart exhausted failure requires remote closure; unknown/refused DELETE blocks discard and retries deletion only",
  { timeout: 2000 },
  async () => {
    const store = memory(await seed(null, "failed"));
    let deletes = 0;
    let actor:
      | ActorRefFrom<ReturnType<typeof createVideoComposerMachine>>
      | undefined;
    const order: string[] = [];
    const lane = make(
      store,
      async (_url, init) => {
        const method = init?.method ?? "GET";
        order.push(method);
        if (method === "GET") return Response.json(status("failed"));
        assert.equal(method, "DELETE");
        assert.equal(store.value()?.pending, "withdraw");
        if (++deletes === 1) throw new TypeError("Unconfirmed deletion");
        if (deletes === 2)
          return Response.json(
            { error: "media_authentication_required" },
            { status: 403 },
          );
        return Response.json(status("withdrawn"));
      },
      { onChange: (record) => actor?.send({ type: "RECORD_CHANGED", record }) },
    );
    actor = createActor(
      createVideoComposerMachine(videoOperations(lane), true),
    );
    actor.start();
    try {
      await waitFor(actor, (next) => next.matches("retained"), {
        timeout: 500,
      });
      assert.equal(
        mediaNeedsStartOver(actor.getSnapshot().context.record),
        true,
      );
      actor.send({ type: "START_OVER" });
      await waitFor(
        actor,
        (next) => next.matches("retained") && next.context.error !== "",
        { timeout: 500 },
      );
      assert.equal(store.value()?.pending, "withdraw");
      assert.equal(lane.playbackUrl, undefined);
      await assert.rejects(lane.discard());
      assert.equal(store.value()?.pending, "withdraw");
      assert.equal(store.value()?.authenticationHold, true);
      assert.equal(mediaNeedsStartOver(store.value()), true);
      actor.send({ type: "START_OVER" });
      await waitFor(actor, (next) => next.matches("choosingSong"), {
        timeout: 500,
      });
      assert.equal(store.value(), null);
      assert.deepEqual(order, ["GET", "DELETE", "DELETE", "DELETE"]);
    } finally {
      actor.stop();
    }
  },
);

test(
  "positive retryable failure keeps the existing resume path and never becomes a publication receipt",
  { timeout: 2000 },
  async () => {
    const store = memory({
      ...(await seed(null, "failed")),
      status: status("failed", { canRetry: true }),
    });
    const order: string[] = [];
    const lane = make(store, async (_url, init) => {
      order.push(init?.method ?? "GET");
      return Response.json(
        init?.method === "POST"
          ? status("queued")
          : status("failed", { canRetry: true }),
      );
    });
    await lane.restore();
    assert.equal(mediaNeedsStartOver(lane.current), false);
    assert.equal((await lane.submit())?.state, "queued");
    assert.deepEqual(order, ["GET", "GET", "POST"]);
    assert.equal(lane.current?.intent.requestId, "request-fixture");
  },
);

const createdAt = "2026-11-11T00:00:00Z";
const textEnvelope = () =>
  createPendingSubmissionEnvelope({
    sameOriginPath: "/api/fixture/text",
    pendingRequestId: "pending-fixture",
    createdAt,
    request: {
      path: { communityId: "community-fixture" },
      body: {
        idempotency_key: "immutable-key-fixture",
        persona_id: "fixture-profile",
        post_type: "text",
        authorship_mode: "human_direct",
        identity_mode: "public",
        visibility: "public",
        author_declared_rating: "general",
        title: "Fixture",
        body: "Original fixture body",
      },
    },
  });
const published = (id: string): TextContentSubmissionV1 => ({
  submission_id: `submission-${id}`,
  href: `/submissions/${id}`,
  surface: "text_post",
  status: "published",
  result: { decision: "allow", reason_code: null },
  published_resource: { kind: "post", post_id: id, href: `/posts/${id}` },
  review_ref: null,
  created_at: createdAt,
  updated_at: createdAt,
});
test(
  "actual text machine cannot publish a foreign conflict result through auth/retry and retains the original envelope",
  { timeout: 2000 },
  async () => {
    const envelope = await textEnvelope();
    let reads = 0,
      sends = 0;
    const seen: PendingSubmissionEnvelopeV1[] = [],
      observedPosts: (string | null)[] = [];
    const foreign = published("foreign-fixture"),
      own = published("original-fixture");
    const actor = createActor(
      createTextSubmissionMachine({
        read: async () => {
          reads++;
          return foreign;
        },
        dispatch: async (next) => {
          seen.push(next);
          if (++sends === 1 || sends === 3)
            throw new IdempotencyConflictError(foreign.submission_id);
          if (sends === 2)
            throw new TextSubmissionAuthenticationRequiredError();
          return own;
        },
      }),
      { input: { envelope } },
    );
    actor.subscribe((next) => observedPosts.push(next.context.postId));
    actor.start();
    try {
      await waitFor(actor, (next) => next.matches("waiting"), { timeout: 500 });
      assert.equal(actor.getSnapshot().context.submissionId, null);
      assert.equal(actor.getSnapshot().context.postId, null);
      actor.send({ type: "PAUSE" });
      actor.send({ type: "RESUME" });
      await waitFor(
        actor,
        (next) => next.matches("signInRequired") && next.context.attempts === 2,
        { timeout: 500 },
      );
      actor.send({ type: "RESUME" });
      await waitFor(
        actor,
        (next) => next.matches("waiting") && next.context.attempts === 3,
        { timeout: 500 },
      );
      assert.equal(actor.getSnapshot().context.postId, null);
      actor.send({ type: "RETRY" });
      await waitFor(actor, (next) => next.matches("published"), {
        timeout: 500,
      });
      assert.equal(reads, 0);
      assert.equal(actor.getSnapshot().context.postId, "original-fixture");
      assert.ok(!observedPosts.includes("foreign-fixture"));
      assert.ok(seen.every((next) => next === envelope));
      assert.equal(
        actor.getSnapshot().context.envelope.body_sha256,
        envelope.body_sha256,
      );
    } finally {
      actor.stop();
    }
  },
);

test(
  "a legacy retained text ID without hash proof cannot trigger a foreign read",
  { timeout: 2000 },
  async () => {
    const envelope = await textEnvelope();
    const retainedEnvelope = {
      ...envelope,
      submission_id: "foreign-submission-fixture",
    };
    let reads = 0;
    const actor = createActor(
      createTextSubmissionMachine({
        read: async () => {
          reads++;
          return published("foreign-fixture");
        },
        dispatch: async (next) => {
          assert.equal(next, retainedEnvelope);
          return published("original-fixture");
        },
      }),
      { input: { envelope: retainedEnvelope } },
    ).start();
    try {
      await waitFor(actor, (next) => next.matches("published"), {
        timeout: 500,
      });
      assert.equal(reads, 0);
      assert.equal(actor.getSnapshot().context.postId, "original-fixture");
    } finally {
      actor.stop();
    }
  },
);
