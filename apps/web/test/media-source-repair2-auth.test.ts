// Prepared only. No source-actor execution; unchanged default strip-only Node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { createActor, waitFor, type ActorRefFrom } from "xstate";
import {
  MediaAttemptController,
  mediaNeedsStartOver,
} from "../src/media/media-attempt.ts";
import { mediaClient } from "../src/media/client.ts";
import { createMediaOwnerLifetime } from "../src/media/media-owner-lifetime.ts";
// Import the actual device controller normally, before the Solid-only harness.
import { VideoComposerMedia } from "../src/media/reference/src/features/posts/video-submission/video-composer-media.ts";
import { createVideoComposerMachine } from "../src/media/reference/src/features/posts/video-submission/video-composer-machine.ts";
import { createMemoryExcerptDraftStore } from "../src/media/reference/src/features/posts/post-composer/song-excerpt-draft.ts";
import {
  clipFitMessage,
  fitClipToExcerpt,
} from "../src/media/reference/src/features/posts/video-submission/clip-duration.ts";
import { PUBLIC_POSTING_UNDECIDED } from "../../../packages/community-media/contracts.ts";
import type {
  useCommunityVideoFlow,
  VideoFlowProps,
} from "../src/media/video-flow.ts";
import {
  retained,
  memory,
  ready,
  status,
} from "./media-source-repair2-helpers.ts";

for (const authStatus of [401, 403])
  test(
    `lost upload acknowledgement then canonical GET ${authStatus} preserves uncertainty and suspends background recovery`,
    { timeout: 2000 },
    async () => {
      const record = await retained(),
        store = memory(record),
        order: string[] = [];
      let csrf = "old-session",
        reads = 0,
        reauthenticated = false;
      const tokens: (string | null)[] = [];
      const client = mediaClient(
        () => csrf,
        async (_url, init) => {
          const method = init?.method ?? "GET";
          order.push(method);
          if (method === "PUT") {
            assert.equal(init?.body, record.file);
            tokens.push(new Headers(init.headers).get("x-csrf-token"));
            throw new TypeError("Canonical upload accepted; response lost");
          }
          assert.equal(method, "GET");
          if (++reads === 1) return Response.json(status("uploading"));
          if (!reauthenticated)
            return Response.json(
              { error: "media_authentication_required" },
              { status: authStatus },
            );
          return Response.json(status("queued"));
        },
      );
      const lane = new MediaAttemptController({
        client,
        storage: store.storage,
        accountId: record.accountId,
        communityId: record.communityId,
      });
      await assert.rejects(lane.restore());
      assert.deepEqual(order, ["GET", "PUT"]);
      const beforeAuth = store.value()!;
      await assert.rejects(lane.restore());
      const held = store.value()!;
      assert.equal(held.authenticationHold, true);
      assert.equal(held.pending, beforeAuth.pending);
      assert.equal(held.commandDispatched, beforeAuth.commandDispatched);
      assert.equal(held.file, record.file);
      assert.equal(held.intent, record.intent);
      assert.equal(held.intentDigest, record.intentDigest);
      assert.equal(held.status, beforeAuth.status);
      assert.deepEqual(tokens, ["old-session"]);
      await lane.refresh();
      await lane.refresh();
      await assert.rejects(lane.discard());
      const reloaded = new MediaAttemptController({
        client,
        storage: store.storage,
        accountId: record.accountId,
        communityId: record.communityId,
      });
      await reloaded.restore({ reconcileHeld: false });
      await reloaded.refresh();
      assert.deepEqual(order, ["GET", "PUT", "GET"]);
      reauthenticated = true;
      csrf = "reauthenticated-session";
      await reloaded.submit();
      assert.equal(store.value()?.authenticationHold, undefined);
      assert.equal(store.value()?.pending, null);
      assert.equal(store.value()?.status?.state, "queued");
      assert.equal(store.value()?.intentDigest, record.intentDigest);
      assert.deepEqual(order, ["GET", "PUT", "GET", "GET"]);
    },
  );

test(
  "a status auth hold with no pending command preserves null rather than inventing a mutation",
  { timeout: 2000 },
  async () => {
    const record = {
      ...(await retained()),
      pending: null,
      commandDispatched: false,
      status: status("processing"),
    } as const;
    const store = memory(record);
    let reads = 0;
    const lane = new MediaAttemptController({
      accountId: record.accountId,
      communityId: record.communityId,
      storage: store.storage,
      client: mediaClient(
        () => "csrf-fixture",
        async () => {
          reads++;
          return Response.json(
            { error: "media_authentication_required" },
            { status: 401 },
          );
        },
      ),
    });
    await assert.rejects(lane.restore());
    await lane.refresh();
    assert.equal(reads, 1);
    assert.equal(store.value()?.authenticationHold, true);
    assert.equal(store.value()?.pending, null);
    assert.equal(store.value()?.commandDispatched, false);
  },
);

test(
  "non-auth status failures preserve the prior state without creating a reconnect hold",
  { timeout: 2000 },
  async () => {
    const record = await retained(),
      store = memory(record);
    const lane = new MediaAttemptController({
      accountId: record.accountId,
      communityId: record.communityId,
      storage: store.storage,
      client: mediaClient(
        () => "csrf-fixture",
        async () =>
          Response.json({ error: "fixture-unavailable" }, { status: 503 }),
      ),
    });
    await assert.rejects(lane.restore());
    assert.equal(store.value(), record);
    assert.equal(store.value()?.authenticationHold, undefined);
  },
);

test(
  "withdrawal from a canonical GET hold transmits DELETE only and cannot resume recording bytes",
  { timeout: 2000 },
  async () => {
    const record = await retained(),
      store = memory(record),
      order: string[] = [];
    const lane = new MediaAttemptController({
      accountId: record.accountId,
      communityId: record.communityId,
      storage: store.storage,
      client: mediaClient(
        () => "fresh-csrf",
        async (_url, init) => {
          const method = init?.method ?? "GET";
          order.push(method);
          if (method === "GET")
            return Response.json(
              { error: "media_authentication_required" },
              { status: 403 },
            );
          assert.equal(method, "DELETE");
          assert.equal(store.value()?.pending, "withdraw");
          assert.equal(init?.body, undefined);
          return Response.json(status("withdrawn"));
        },
      ),
    });
    await assert.rejects(lane.restore());
    await lane.withdraw();
    await lane.discard();
    assert.deepEqual(order, ["GET", "DELETE"]);
    assert.equal(store.value(), null);
  },
);

/** Same in-process pinned Solid browser-runtime pattern as the preserved
 * community-media-capture case. Only the actual Solid-owned flow/hook bodies
 * are type-erased for dependency binding; the device module above is imported
 * directly by unchanged strip-only Node. No browser, DOM rendering or build. */
async function flowHarness(
  onActor: (
    actor: ActorRefFrom<ReturnType<typeof createVideoComposerMachine>>,
  ) => void,
) {
  const browserEntry = new URL(
    "../node_modules/solid-js/dist/solid.js",
    import.meta.url,
  );
  const pkg = JSON.parse(
    await readFile(
      new URL("../node_modules/solid-js/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pkg.version, "2.0.0-rc.0");
  const solid = await import(browserEntry.href);
  const actorSource = await readFile(
    new URL(
      "../src/media/reference/src/features/posts/video-submission/solid-actor.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const owned = await transform(
    actorSource
      .slice(actorSource.indexOf("export function useOwnedActor"))
      .replace("export function", "function"),
    { loader: "ts", target: "esnext" },
  );
  const useOwnedActor = new Function(
    "createSignal",
    "onCleanup",
    "isServer",
    owned.code + "; return useOwnedActor;",
  )(solid.createSignal, solid.onCleanup, false);
  const source = await readFile(
    new URL("../src/media/video-flow.ts", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("export function useCommunityVideoFlow"),
    end = source.indexOf("export interface VideoComposerSurfaceProps", begin);
  assert.ok(begin >= 0 && end > begin);
  const flow = await transform(
    source.slice(begin, end).replace("export function", "function"),
    { loader: "ts", target: "esnext" },
  );
  const dependencies = {
    createSignal: solid.createSignal,
    createEffect: solid.createEffect,
    onCleanup: solid.onCleanup,
    untrack: solid.untrack,
    isServer: false,
    document: {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
    createActor: (logic: ReturnType<typeof createVideoComposerMachine>) => {
      const actor = createActor(logic);
      onActor(actor);
      return actor;
    },
    createVideoComposerMachine,
    VideoComposerMedia,
    MediaAttemptController,
    mediaNeedsStartOver,
    createMediaOwnerLifetime,
    createMemoryExcerptDraftStore,
    clipFitMessage,
    fitClipToExcerpt,
    PUBLIC_POSTING_UNDECIDED,
    useOwnedActor,
  };
  const factory = new Function(
    ...Object.keys(dependencies),
    flow.code + "; return useCommunityVideoFlow;",
  )(...Object.values(dependencies)) as (
    props: VideoFlowProps,
  ) => ReturnType<typeof useCommunityVideoFlow>;
  return { solid, factory };
}

for (const authStatus of [401, 403])
  test(
    `actual VideoFlow interval guard holds GET ${authStatus} across remount and resumes after explicit reconciliation`,
    { timeout: 5000 },
    async (t) => {
      const intervals = new Map<ReturnType<typeof setInterval>, () => void>();
      t.mock.method(globalThis, "setInterval", ((callback: () => void) => {
        const token = {} as ReturnType<typeof setInterval>;
        intervals.set(token, callback);
        return token;
      }) as typeof setInterval);
      t.mock.method(globalThis, "clearInterval", ((
        token: ReturnType<typeof setInterval>,
      ) => {
        intervals.delete(token);
      }) as typeof clearInterval);
      const tick = () => {
        for (const callback of Array.from(intervals.values())) callback();
      };
      const record = await retained(),
        store = memory(record),
        order: string[] = [];
      let reauthenticated = false,
        stage: "uploading" | "queued" | "processing" | "ready" = "uploading",
        readyCalls = 0,
        exits = 0;
      const client = mediaClient(
        () => (reauthenticated ? "fresh-session" : "expired-session"),
        async (_url, init) => {
          const method = init?.method ?? "GET";
          order.push(method);
          if (method === "PUT") {
            stage = "queued";
            throw new TypeError("Lost upload acknowledgement");
          }
          assert.equal(method, "GET");
          if (order.length > 2 && !reauthenticated)
            return Response.json(
              { error: "media_authentication_required" },
              { status: authStatus },
            );
          const state = stage;
          if (reauthenticated && stage === "queued") stage = "processing";
          else if (reauthenticated && stage === "processing") stage = "ready";
          return Response.json(
            status(state, state === "ready" ? { ready: ready(record) } : {}),
          );
        },
      );
      const unavailable = async (): Promise<never> => {
        throw new Error(
          "No authoring/provider service is supplied in this retained-flow case",
        );
      };
      let actor!: ActorRefFrom<ReturnType<typeof createVideoComposerMachine>>;
      const { solid, factory } = await flowHarness((next) => {
        actor = next;
      });
      const props: VideoFlowProps = {
        accountId: record.accountId,
        communityId: record.communityId,
        client,
        onExit: () => {
          exits++;
        },
        onMediaReady: () => {
          readyCalls++;
        },
        ports: {
          storage: store.storage,
          songReader: unavailable,
          songPicker: unavailable,
          songPreflight: unavailable,
          resolveSong: unavailable,
          prepareGuideSource: unavailable,
        },
      };
      let dispose: (() => void) | undefined;
      const mount = () =>
        solid.createRoot((cleanup: () => void) => {
          dispose = cleanup;
          return factory(props);
        }) as ReturnType<typeof useCommunityVideoFlow>;
      let flow = mount();
      solid.flush();
      try {
        await waitFor(actor, (next) => next.matches("retained"), {
          timeout: 1000,
        });
        solid.flush();
        assert.deepEqual(order, ["GET", "PUT"]);
        tick();
        await waitFor(
          actor,
          (next) =>
            next.matches("retained") &&
            next.context.record?.authenticationHold === true,
          { timeout: 1000 },
        );
        solid.flush();
        assert.equal(
          flow.statusText(),
          "Reconnect your community account before continuing.",
        );
        assert.equal(flow.record()?.pending, "upload");
        assert.equal(flow.record()?.commandDispatched, true);
        tick();
        tick();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        solid.flush();
        assert.deepEqual(order, ["GET", "PUT", "GET"]);
        dispose?.();
        solid.flush();
        assert.equal(intervals.size, 0);
        flow = mount();
        solid.flush();
        await waitFor(actor, (next) => next.matches("retained"), {
          timeout: 1000,
        });
        solid.flush();
        tick();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        solid.flush();
        assert.deepEqual(order, ["GET", "PUT", "GET"]);
        assert.equal(flow.record()?.authenticationHold, true);
        reauthenticated = true;
        flow.publish();
        await waitFor(
          actor,
          (next) =>
            next.matches("retained") &&
            next.context.record?.status?.state === "queued" &&
            !next.context.record.authenticationHold,
          { timeout: 1000 },
        );
        solid.flush();
        assert.equal(store.value()?.intentDigest, record.intentDigest);
        assert.equal(store.value()?.file, record.file);
        tick();
        await waitFor(
          actor,
          (next) =>
            next.matches("retained") &&
            next.context.record?.status?.state === "processing",
          { timeout: 1000 },
        );
        solid.flush();
        tick();
        await waitFor(
          actor,
          (next) =>
            next.matches("retained") &&
            next.context.record?.status?.state === "ready",
          { timeout: 1000 },
        );
        solid.flush();
        assert.deepEqual(order, ["GET", "PUT", "GET", "GET", "GET", "GET"]);
        assert.equal(readyCalls, 1);
        assert.equal(exits, 0);
        assert.equal(store.value()?.pending, null);
      } finally {
        dispose?.();
        solid.flush();
      }
      assert.equal(intervals.size, 0);
    },
  );
