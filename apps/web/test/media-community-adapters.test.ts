// Prepared only: actual adapters/controller/source machines, explicit native
// protocol simulation. No provider, chain, Worker or browser is started.
import test from "node:test";
import assert from "node:assert/strict";
import { createActor, waitFor } from "xstate";
import { createRoot } from "solid-js";
import {
  captureCommunityOwner,
  requireHost,
  fileHash,
  OWNER_RELEASE_POLICY,
  SINGLE_CURATED_RELEASE,
  type CommunityHostContext,
} from "../src/media/community-contracts.ts";
import { mediaClient } from "../src/media/client.ts";
import type { MediaAttemptStorage } from "../src/media/media-attempt.ts";
import { communityHttp } from "../src/media/community-http.ts";
import {
  CommunitySongController,
  type CommunitySongDraft,
  type SongReleaseInput,
} from "../src/media/community-song-controller.ts";
import { createCommunityVideoPorts } from "../src/media/community-video-ports.ts";
import { createScopedBrowserStorage } from "../src/media/community-browser-storage.ts";
import { createSongObservationMachine } from "../src/media/reference/src/features/posts/song-submission/song-observation-machine.ts";
import { createPostComposerController } from "../src/media/reference/src/features/posts/post-composer/controller.ts";
const community = "0x" + "1".repeat(64),
  author = "0x" + "2".repeat(64),
  postId = "0x" + "3".repeat(64);
const submissionId = "11111111-1111-4111-8111-111111111111",
  jobId = "publication:" + submissionId;
const unavailableStorage: MediaAttemptStorage = {
  exclusive: async () => {
    throw new Error("Held media path must not access storage");
  },
  load: async () => {
    throw new Error("Held media path must not access storage");
  },
  save: async () => {
    throw new Error("Held media path must not access storage");
  },
  remove: async () => {
    throw new Error("Held media path must not access storage");
  },
};
function context(): CommunityHostContext {
  return {
    community: {
      id: community,
      name: "Fixture",
      origin: "https://fixture.invalid",
    },
    language: "en",
    owner: {
      accountId: "22222222-2222-4222-8222-222222222222",
      authorId: author,
      communityId: community,
      generation: "fixture-generation-1",
    },
    session: {
      authenticated: true,
      authorId: author,
      mossAddress: "moss-fixture",
      csrf: "csrf-fixture",
      creator: null,
      pendingConnection: null,
      publicResults: "off",
      publisher: true,
    },
    capabilities: {
      schema: "pirate.community-capabilities/1",
      upload: true,
      publication: true,
      signIn: true,
      creatorConnection: false,
      policyVersion: OWNER_RELEASE_POLICY,
    },
    feed: {
      schema: "pirate.community-feed/1",
      communityId: community,
      posts: [],
    },
  };
}
function memory() {
  let value: CommunitySongDraft | null = null,
    tail: Promise<unknown> = Promise.resolve();
  return {
    value: () => value,
    store: {
      exclusive<T>(work: () => Promise<T>) {
        const next = tail.then(work);
        tail = next.catch(() => {});
        return next;
      },
      load: async () => value,
      save: async (next: CommunitySongDraft) => {
        value = next;
      },
      remove: async () => {
        value = null;
      },
    },
  };
}
function input(): SongReleaseInput {
  return {
    title: "Fixture song",
    lyrics: "Fixture lyrics",
    language: "en",
    file: new File(["master"], "master.mp3", { type: "audio/mpeg" }),
    instrumental: new File(["instrumental"], "instrumental.mp3", {
      type: "audio/mpeg",
    }),
    vocals: new File(["vocals"], "vocals.mp3", { type: "audio/mpeg" }),
    originalConsent: true,
    rating: "general",
  };
}
function server() {
  let reserved = false,
    master = false,
    sealed = false,
    phase = "admission",
    foreign = false;
  const stems: Record<
    string,
    { slot: string; state: string; sha256: string; byteLength: number }
  > = {};
  const calls: {
    method: string;
    path: string;
    body?: string;
    key: string | null;
  }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url),
      method = init?.method ?? "GET",
      headers = new Headers(init?.headers);
    assert.equal(init?.credentials, "same-origin");
    if (method !== "GET")
      assert.equal(headers.get("x-csrf-token"), "csrf-fixture");
    calls.push({
      method,
      path,
      body: typeof init?.body === "string" ? init.body : undefined,
      key: headers.get("idempotency-key"),
    });
    if (path === "/api/uploads" && method === "POST") {
      reserved = true;
      return Response.json({ submissionId, postId, state: "reserved" });
    }
    if (path === "/api/uploads")
      return Response.json({
        uploads: reserved
          ? [
              {
                submissionId,
                postId,
                title: "Fixture song",
                state: sealed ? phase : master ? "uploaded" : "reserved",
                jobId: sealed ? jobId : null,
              },
            ]
          : [],
      });
    if (path.endsWith("/audio")) {
      assert.equal(method, "PUT");
      master = true;
      return Response.json({ uploaded: true });
    }
    if (path.endsWith("/stems"))
      return Response.json({ stems: Object.values(stems) });
    if (path.includes("/stems/")) {
      const slot = path.split("/").at(-1)!;
      if (method === "POST") {
        const body = JSON.parse(String(init?.body));
        stems[slot] = { slot, ...body, state: "reserved" };
        return Response.json({ stem: stems[slot] });
      }
      stems[slot].state = "sealed";
      return Response.json({ sealed: true });
    }
    if (path.endsWith("/seal")) {
      sealed = true;
      return Response.json({ jobId, postId });
    }
    if (path.endsWith("/resume")) {
      phase = "admission";
      return Response.json({ resuming: true });
    }
    if (path.startsWith("/api/jobs/"))
      return Response.json({
        schema: "pirate.publication-job-view/1",
        jobId,
        submissionId,
        postId: foreign ? "0x" + "9".repeat(64) : postId,
        phase,
        errorCode: phase === "uncertain" ? "external_result_uncertain" : null,
        resumable: phase === "uncertain",
      });
    if (path === "/api/feed")
      return Response.json({
        schema: "pirate.community-feed/1",
        communityId: community,
        posts:
          phase === "published"
            ? [
                {
                  manifest: {
                    schema: "pirate.community-post/3",
                    postId,
                    authorId: author,
                    title: "Fixture song",
                    language: "en",
                    rating: "general",
                  },
                  audioUrl: `/api/public/posts/${postId}/audio`,
                  postUrl: `/#song-${postId}`,
                  transactionHash: "0x" + "4".repeat(64),
                },
              ]
            : [],
      });
    if (path.endsWith("/proof"))
      return Response.json({
        schema: "pirate.community-publication-proof/1",
        transactionHash: "0x" + "4".repeat(64),
        post: {
          postId,
          communityId: community,
          authorId: author,
          revision: 5,
          media: [],
        },
      });
    throw new Error("Unexpected fixture request: " + method + " " + path);
  };
  return {
    transport,
    calls,
    phase(value: string) {
      phase = value;
    },
    foreign() {
      foreign = true;
    },
  };
}

test(
  "real reserve/master/stems/seal/job/feed/proof sequence preserves request and only confirms genuine publication",
  { timeout: 4000 },
  async () => {
    const current = context(),
      owner = captureCommunityOwner(() => current),
      saved = memory(),
      api = server();
    const controller = new CommunitySongController({
      owner,
      store: saved.store,
      http: communityHttp(owner, api.transport),
    });
    await controller.prepare(input());
    const frozen = saved.value()!;
    const reserve = api.calls.find(
      (call) => call.path === "/api/uploads" && call.method === "POST",
    )!;
    assert.equal(reserve.key, frozen.requestId);
    assert.equal(JSON.parse(reserve.body!).rating, "general");
    assert.equal(frozen.master, true);
    assert.deepEqual(frozen.stems, { instrumental: true, vocals: true });
    assert.equal((await controller.publish()).status, "processing");
    api.phase("uncertain");
    assert.equal((await controller.observe()).status, "reconciling");
    await controller.resume();
    assert.equal(
      api.calls.filter((call) => call.path.endsWith("/resume")).length,
      1,
    );
    api.phase("published");
    const published = await controller.observe();
    assert.deepEqual(published, {
      status: "published",
      submissionId,
      postId,
      postHref: `/#song-${postId}`,
    });
    assert.equal(saved.value()?.requestId, frozen.requestId);
    assert.equal(saved.value()?.bodyDigest, frozen.bodyDigest);
    await controller.close();
    assert.equal(saved.value(), null);
    owner.dispose();
  },
);

for (const lost of ["reserve", "audio", "seal"] as const)
  test(
    `lost ${lost} acknowledgement retains exact identity and restore performs reads only`,
    { timeout: 4000 },
    async () => {
      const current = context(),
        owner = captureCommunityOwner(() => current),
        saved = memory(),
        api = server();
      let lose = true;
      const transport: typeof fetch = async (url, init) => {
        const reply = await api.transport(url, init);
        const path = String(url),
          target =
            lost === "reserve"
              ? path === "/api/uploads" && init?.method === "POST"
              : path.endsWith("/" + lost);
        if (lose && target) {
          lose = false;
          throw new TypeError("Committed acknowledgement lost");
        }
        return reply;
      };
      const ports = {
        owner,
        store: saved.store,
        http: communityHttp(owner, transport),
      };
      let controller = new CommunitySongController(ports);
      if (lost === "seal") {
        await controller.prepare(input());
        await assert.rejects(controller.publish());
      } else await assert.rejects(controller.prepare(input()));
      const original = saved.value()!,
        before = api.calls.length;
      controller = new CommunitySongController(ports);
      await controller.restore();
      assert.ok(api.calls.slice(before).every((call) => call.method === "GET"));
      if (lost === "seal") await controller.publish();
      else {
        await controller.prepare();
        await controller.publish();
      }
      assert.equal(saved.value()?.requestId, original.requestId);
      assert.equal(saved.value()?.bodyDigest, original.bodyDigest);
      const reservations = api.calls.filter(
        (call) => call.path === "/api/uploads" && call.method === "POST",
      );
      assert.ok(
        reservations.every(
          (call) =>
            call.body === reservations[0].body &&
            call.key === reservations[0].key,
        ),
      );
      if (lost === "audio")
        assert.equal(
          api.calls.filter((call) => call.path.endsWith("/audio")).length,
          1,
        );
      assert.equal(
        api.calls.filter((call) => call.path.endsWith("/seal")).length,
        1,
      );
      owner.dispose();
    },
  );

test(
  "owner/route generation change after ignored PUT abort persists late receipt without next command or stale notification",
  { timeout: 4000 },
  async () => {
    let current = context();
    const owner = captureCommunityOwner(() => current),
      saved = memory(),
      api = server();
    let release!: () => void, entered!: () => void;
    const pause = new Promise<void>((resolve) => {
        release = resolve;
      }),
      start = new Promise<void>((resolve) => {
        entered = resolve;
      });
    let notifications = 0;
    const controller = new CommunitySongController({
      owner,
      store: saved.store,
      http: communityHttp(owner, async (url, init) => {
        const result = await api.transport(url, init);
        if (String(url).endsWith("/audio")) {
          entered();
          await pause;
        }
        return result;
      }),
      onChange: () => {
        notifications++;
      },
    });
    const outcome = controller.prepare(input()).then(
      () => null,
      (error) => error,
    );
    await start;
    current = {
      ...current,
      owner: { ...current.owner, generation: "next-route" },
    };
    owner.dispose();
    const before = notifications;
    release();
    assert.ok(await outcome);
    assert.equal(saved.value()?.master, true);
    assert.equal(notifications, before);
    assert.equal(
      api.calls.some((call) => call.path.includes("/stems/")),
      false,
    );
  },
);

test(
  "capabilities, curated policy, consent, rating and account aliases deny before reservation",
  { timeout: 4000 },
  async () => {
    for (const kind of [
      "publisher",
      "curated",
      "consent",
      "rating",
      "length",
    ] as const) {
      const current = context(),
        value = input(),
        saved = memory();
      let calls = 0;
      if (kind === "publisher") current.session.publisher = false;
      if (kind === "curated")
        current.capabilities.policyVersion = SINGLE_CURATED_RELEASE;
      if (kind === "consent") value.originalConsent = false;
      if (kind === "rating") value.rating = null;
      if (kind === "length") value.title = "x".repeat(201);
      const owner = captureCommunityOwner(() => current),
        controller = new CommunitySongController({
          owner,
          store: saved.store,
          http: communityHttp(owner, async () => {
            calls++;
            throw new Error("Denied before network");
          }),
        });
      await assert.rejects(controller.prepare(value));
      assert.equal(calls, 0);
      assert.equal(saved.value(), null);
      owner.dispose();
    }
    const bad = context();
    bad.owner.accountId = bad.session.authorId;
    assert.throws(() => requireHost(bad));
  },
);

test(
  "foreign job receipt is never adopted; original copied observer sees actual controller job transitions",
  { timeout: 4000 },
  async () => {
    const current = context(),
      owner = captureCommunityOwner(() => current),
      saved = memory(),
      api = server();
    const controller = new CommunitySongController({
      owner,
      store: saved.store,
      http: communityHttp(owner, api.transport),
    });
    await controller.prepare(input());
    const view = await controller.publish();
    const actor = createActor(
      createSongObservationMachine(controller.source(), 100000),
      { input: { view } },
    ).start();
    try {
      api.phase("published");
      actor.send({ type: "CHECK" });
      await waitFor(actor, (snap) => snap.context.view.status === "published", {
        timeout: 1000,
      });
      assert.equal(actor.getSnapshot().context.view.status, "published");
      api.foreign();
      await assert.rejects(controller.observe());
      assert.equal(saved.value()?.postId, postId);
      assert.equal(saved.value()?.jobId, jobId);
    } finally {
      actor.stop();
      owner.dispose();
    }
  },
);

test(
  "actual copied composer controller carries real file/stem/title edits without a persona substitute",
  { timeout: 4000 },
  async () => {
    const values = input();
    let song = {
      title: values.title,
      primaryAudioUpload: values.file,
      instrumentalAudioUpload: values.instrumental,
      vocalAudioUpload: values.vocals,
    };
    let dispose!: () => void;
    const controller = createRoot((cleanup) => {
      dispose = cleanup;
      return createPostComposerController(
        {
          mode: "song",
          availableCapabilities: ["song"],
          canCreateSongPost: true,
          get song() {
            return song;
          },
          onSongChange: (next) => {
            song = next as typeof song;
          },
          lyricsValue: values.lyrics,
        },
        { isMobile: () => false },
      );
    });
    try {
      controller.song.update((previous) => ({
        ...previous,
        title: "Edited fixture",
      }));
      assert.equal(controller.song.state.title, "Edited fixture");
      assert.equal(controller.song.state.primaryAudioUpload, values.file);
      assert.equal(controller.royaltySplit.state.allocations.length, 1);
      assert.equal(
        controller.royaltySplit.state.allocations[0].recipientId,
        undefined,
      );
    } finally {
      dispose();
    }
  },
);

test(
  "video ports preserve public denial and refuse missing canonical timing rather than guessing revisions",
  { timeout: 4000 },
  async () => {
    const current = context(),
      owner = captureCommunityOwner(() => current);
    const ports = createCommunityVideoPorts({
      owner,
      http: communityHttp(owner, async () => {
        throw new Error("No invented producer");
      }),
      media: mediaClient(
        () => current.session.csrf,
        async () => {
          throw new Error("Denied public policy must not call media API");
        },
      ),
      storage: unavailableStorage,
    }).ports;
    await assert.rejects(
      ports.songPreflight({
        path: { communityId: community },
        body: { song_post_id: postId },
      }),
      /media_public_posting_not_permitted/,
    );
    await assert.rejects(
      ports.resolveSong(
        {
          songPostId: postId,
          audioRevision: 1,
          clipStartSamples: 0,
          clipDurationSamples: 480000,
          selectedFrom: { kind: "library" },
        },
        new AbortController().signal,
      ),
      /timing is unavailable/,
    );
    owner.dispose();
  },
);

test(
  "real canonical proof/audio guide verifies digest/bytes and releases owned Blob URL; changed audio never becomes a guide",
  { timeout: 4000 },
  async () => {
    const current = context(),
      api = server(),
      owner = captureCommunityOwner(() => current),
      tx = "0x" + "4".repeat(64),
      bytes = new TextEncoder().encode("canonical guide fixture");
    api.phase("published");
    current.feed = await (await api.transport("/api/feed")).json();
    let corrupt = false;
    const transport: typeof fetch = async (url) =>
      String(url).endsWith("/proof")
        ? Response.json({
            schema: "pirate.community-publication-proof/1",
            transactionHash: tx,
            post: {
              communityId: community,
              postId,
              authorId: author,
              revision: 5,
              media: [
                {
                  role: "audio",
                  sha256: await fileHash(new Blob([bytes])),
                  byteLength: bytes.byteLength,
                },
              ],
            },
          })
        : new Response(
            corrupt ? new Uint8Array(bytes.byteLength).fill(0) : bytes,
            { headers: { "content-type": "audio/mpeg" } },
          );
    const ports = createCommunityVideoPorts({
      owner,
      http: communityHttp(owner, transport),
      media: mediaClient(() => current.session.csrf, transport),
      storage: unavailableStorage,
      transport,
    }).ports;
    const guide = await ports.prepareGuideSource(
      postId,
      new AbortController().signal,
    );
    assert.equal(await guide.blob!.text(), "canonical guide fixture");
    assert.match(guide.url, /^blob:/);
    guide.release();
    guide.release();
    corrupt = true;
    await assert.rejects(
      ports.prepareGuideSource(postId, new AbortController().signal),
      /digest changed/,
    );
    owner.dispose();
  },
);

test(
  "missing Web Locks fails closed instead of degrading to an unsafe browser draft",
  { timeout: 2000 },
  () => {
    assert.throws(() =>
      createScopedBrowserStorage({
        accountId: "private-fixture",
        communityId: community,
        kind: "song",
        validate() {},
        platform: { indexedDB: {} as IDBFactory, locks: undefined as never },
      }),
    );
  },
);

for (const authStatus of [401, 403])
  test(
    `lost reservation plus auth ${authStatus} retains Files/body/key and explicit same-owner reauthentication replays only that envelope`,
    { timeout: 4000 },
    async () => {
      let current = context(),
        lose = true,
        denied = false;
      const saved = memory(),
        api = server(),
        owner = captureCommunityOwner(() => current);
      const keys: (string | null)[] = [],
        csrf: (string | null)[] = [];
      const transport: typeof fetch = async (url, init) => {
        const headers = new Headers(init?.headers);
        if (String(url) === "/api/uploads" && init?.method === "POST") {
          keys.push(headers.get("idempotency-key"));
          csrf.push(headers.get("x-csrf-token"));
          if (denied)
            return Response.json(
              { error: "authentication_required" },
              { status: authStatus },
            );
        }
        // The real adapter must read fresh csrf, while the captured request stays unchanged.
        const forwarded = { ...init, headers: new Headers(headers) };
        if (init?.method && init.method !== "GET")
          forwarded.headers.set("x-csrf-token", "csrf-fixture");
        const reply = await api.transport(url, forwarded);
        if (lose && String(url) === "/api/uploads" && init?.method === "POST") {
          lose = false;
          throw new TypeError("Lost committed reserve response");
        }
        return reply;
      };
      const ports = {
        owner,
        store: saved.store,
        http: communityHttp(owner, transport),
      };
      let controller = new CommunitySongController(ports);
      await assert.rejects(controller.prepare(input()));
      const original = saved.value()!;
      denied = true;
      controller = new CommunitySongController(ports);
      await controller.restore();
      await assert.rejects(controller.prepare(), /authentication_required/);
      assert.equal(saved.value()?.pending, "reserve");
      assert.equal(saved.value()?.requestId, original.requestId);
      assert.equal(saved.value()?.bodyDigest, original.bodyDigest);
      assert.equal(saved.value()?.files.audio, original.files.audio);
      const before = api.calls.length;
      current = {
        ...current,
        session: { ...current.session, csrf: "reconnected-csrf" },
      };
      denied = false;
      await controller.prepare();
      assert.equal(keys.length, 3);
      assert.ok(keys.every((key) => key === original.requestId));
      assert.deepEqual(csrf, [
        "csrf-fixture",
        "csrf-fixture",
        "reconnected-csrf",
      ]);
      assert.equal(
        api.calls
          .slice(before)
          .filter(
            (call) => call.method === "POST" && call.path === "/api/uploads",
          )[0].body,
        JSON.stringify(original.body),
      );
      assert.equal(saved.value()?.submissionId, submissionId);
      owner.dispose();
    },
  );

test(
  "same-owner pause retains ignored late master reply; explicit reload reads then continues only missing stems",
  { timeout: 4000 },
  async () => {
    const current = context(),
      owner = captureCommunityOwner(() => current),
      saved = memory(),
      api = server();
    let release!: () => void,
      entered!: () => void,
      changed = 0;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const ports = {
      owner,
      store: saved.store,
      http: communityHttp(owner, async (url, init) => {
        const reply = await api.transport(url, init);
        if (String(url).endsWith("/audio")) {
          entered();
          await barrier;
        }
        return reply;
      }),
      onChange: () => {
        changed++;
      },
    };
    let controller = new CommunitySongController(ports);
    const attempt = controller.prepare(input()).then(
      () => null,
      (error) => error,
    );
    await started;
    controller.pause();
    const notifications = changed;
    release();
    assert.ok(await attempt);
    assert.equal(changed, notifications);
    assert.equal(saved.value()?.master, true);
    const before = api.calls.length;
    controller = new CommunitySongController(ports);
    await controller.restore();
    assert.ok(api.calls.slice(before).every((call) => call.method === "GET"));
    await controller.prepare();
    assert.equal(
      api.calls.filter((call) => call.path.endsWith("/audio")).length,
      1,
    );
    assert.deepEqual(saved.value()?.stems, {
      instrumental: true,
      vocals: true,
    });
    owner.dispose();
  },
);

test(
  "canonical job alone is not publication; held/failed are nonretryable and unknown closure retains original record",
  { timeout: 4000 },
  async () => {
    const current = context(),
      owner = captureCommunityOwner(() => current),
      saved = memory(),
      api = server();
    let hideFeed = true;
    const controller = new CommunitySongController({
      owner,
      store: saved.store,
      http: communityHttp(owner, async (url, init) => {
        if (String(url) === "/api/feed" && hideFeed)
          return Response.json(current.feed);
        return api.transport(url, init);
      }),
    });
    await controller.prepare(input());
    await controller.publish();
    await assert.rejects(controller.close());
    assert.equal(saved.value()?.jobId, jobId);
    api.phase("published");
    assert.equal((await controller.observe()).status, "reconciling");
    hideFeed = false;
    assert.equal((await controller.observe()).status, "published");
    for (const phase of ["held", "failed"]) {
      api.phase(phase);
      assert.deepEqual(await controller.observe(), {
        status: "processing_failed",
        submissionId,
        reasonCode: phase,
        retryable: false,
      });
      await assert.rejects(controller.resume());
    }
    await controller.close();
    assert.equal(saved.value(), null);
    owner.dispose();
  },
);
