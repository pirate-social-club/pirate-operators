// UNRUN native browser entry for coordinator's pinned owner-UI harness.
// Real IDB/Web Locks, scope/host/source cards/controller/XState; HTTP is an
// explicit protocol simulation. No remote provider, wallet or public chain.
import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import {
  CommunityComposerHost,
  CommunityPendingSongs,
} from "../src/media/community-host.tsx";
import {
  createCommunityComposerScope,
  type CommunityComposerScope,
} from "../src/media/community-composer-scope.ts";
import {
  captureCommunityOwner,
  type CommunityHostContext,
} from "../src/media/community-contracts.ts";
import {
  createBrowserSongStorage,
  CommunitySongController,
  type CommunitySongDraft,
} from "../src/media/community-song-controller.ts";
import { communityHttp } from "../src/media/community-http.ts";
import { shellFixture, latch } from "./media-community-shell-fixture.ts";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(condition: () => boolean) {
  const deadline = performance.now() + 6000;
  while (!condition()) {
    if (performance.now() > deadline)
      throw new Error("Shell lifetime fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
async function seed(f: ReturnType<typeof shellFixture>) {
  const owner = captureCommunityOwner(() => f.context),
    storage = createBrowserSongStorage(owner);
  const controller = new CommunitySongController({
    owner,
    store: storage,
    http: communityHttp(owner, f.transport),
  });
  await controller.prepare(f.input);
  await controller.publish();
  owner.dispose();
}
async function readSaved(f: ReturnType<typeof shellFixture>) {
  const owner = captureCommunityOwner(() => f.context),
    storage = createBrowserSongStorage(owner);
  try {
    return await storage.exclusive(() => storage.load());
  } finally {
    owner.dispose();
  }
}
// Observe the committed native cell while the replacement owner's read holds
// its Web Lock. This read never changes the cell or bypasses a product write.
async function readCommitted(f: ReturnType<typeof shellFixture>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pirate-community-composer-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<CommunitySongDraft | null>((resolve, reject) => {
      const tx = db.transaction("records", "readonly");
      const request = tx
        .objectStore("records")
        .get(
          JSON.stringify([
            f.context.community.id,
            f.context.owner.accountId,
            "song",
          ]),
        );
      tx.oncomplete = () => resolve(request.result?.value ?? null);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
async function clean(f: ReturnType<typeof shellFixture>) {
  const owner = captureCommunityOwner(() => f.context),
    storage = createBrowserSongStorage(owner);
  try {
    await storage.exclusive(async () => {
      await storage.load();
      await storage.remove();
    });
  } finally {
    owner.dispose();
  }
}
function mount(
  root: HTMLElement,
  f: ReturnType<typeof shellFixture>,
  refresh: () => Promise<void>,
) {
  let authority: CommunityHostContext | null = f.context;
  const [tick, setTick] = createSignal(0, { ownedWrite: true });
  const [route, setRoute] = createSignal("publish", { ownedWrite: true });
  let scope!: CommunityComposerScope;
  const dispose = render(() => {
    scope = createCommunityComposerScope({
      current: () => {
        tick();
        return authority;
      },
      refreshFeed: refresh,
      transport: f.transport,
      observeIntervalMs: 20,
      requestTimeoutMs: 200,
    });
    return (
      <>
        <Show when={route() === "publish"}>
          <CommunityComposerHost
            scope={scope}
            open
            onOpenChange={(open) => {
              if (!open) setRoute("home");
            }}
          />
        </Show>
        <Show when={route() === "home"}>
          <CommunityPendingSongs
            scope={scope}
            onOpenStatus={() => setRoute("publish")}
          />
        </Show>
        <Show when={route() === "songs" || route() === "account"}>
          <div data-fixture-route={route()} />
        </Show>
      </>
    );
  }, root);
  return {
    scope: () => scope,
    route: setRoute,
    authority(next: CommunityHostContext | null) {
      authority = next;
      setTick((value) => value + 1);
    },
    dispose,
  };
}

export async function runCommunityShellLifetimeBrowserCases(root: HTMLElement) {
  const results: string[] = [];
  {
    const f = shellFixture(location.origin);
    await seed(f);
    let refreshed = 0;
    const original = await readSaved(f),
      app = mount(root, f, async () => {
        refreshed++;
      });
    try {
      await until(() => app.scope().count() === 1);
      const before = f.calls.length,
        writes = f.calls.filter((call) => call.method !== "GET").length;
      const close = root.querySelector<HTMLButtonElement>(
        '[aria-label="Close song status"]',
      );
      check(close, "original PostedSong close missing");
      close.click();
      await settle();
      check(
        root.querySelector(`[data-pending-song="${f.submissionId}"]`),
        "original PendingSongs missing after close",
      );
      for (const route of ["songs", "account", "home"]) {
        const reads = f.calls.filter((call) =>
          call.path.startsWith("/api/jobs/"),
        ).length;
        app.route(route);
        await until(
          () =>
            f.calls.filter((call) => call.path.startsWith("/api/jobs/"))
              .length > reads,
        );
      }
      f.phase("published");
      await until(() => refreshed === 1);
      await settle();
      check(
        root.querySelector('[data-pending-song-status="published"]'),
        "native publication did not reach original card",
      );
      check(
        f.calls.slice(before).some((call) => call.path.endsWith("/proof")),
        "publication skipped actual proof adapter",
      );
      check(
        f.calls.filter((call) => call.method !== "GET").length === writes,
        "navigation replayed a publication command",
      );
      const status = root.querySelector<HTMLButtonElement>(
        `[data-pending-song-open-status="${f.submissionId}"]`,
      );
      check(status, "source Status action missing");
      status.click();
      await settle();
      check(
        app.scope().runtime()?.record()?.requestId === original?.requestId &&
          app.scope().runtime()?.record()?.bodyDigest === original?.bodyDigest,
        "reopen changed request envelope",
      );
      const saved = await readSaved(f);
      check(
        saved?.files.audio.name === original?.files.audio.name &&
          (await saved!.files.audio.text()) ===
            (await original!.files.audio.text()),
        "native reopen changed File",
      );
      results.push(
        "accepted job polls/publishes after close and home/songs/profile; original Status reopens same native Files/envelope without POST",
      );
    } finally {
      app.dispose();
      await clean(f);
    }
  }
  {
    const f = shellFixture(location.origin);
    await seed(f);
    const app = mount(root, f, async () => {});
    try {
      await until(() => app.scope().count() === 1);
      f.phase("uncertain");
      await until(
        () => app.scope().runtime()?.record()?.job?.phase === "uncertain",
      );
      app.route("home");
      await settle();
      const writes = f.calls.filter((call) => call.method !== "GET").length;
      app.scope().retry(f.submissionId);
      await settle();
      check(
        f.calls.filter((call) => call.method !== "GET").length === writes,
        "original retry guard invented retryable state",
      );
      root
        .querySelector<HTMLButtonElement>(
          `[data-pending-song-open-status="${f.submissionId}"]`,
        )!
        .click();
      await settle();
      const resume = Array.from(root.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Check and resume",
      );
      check(resume, "existing native recovery action missing");
      resume.click();
      await until(() => f.calls.some((call) => call.path.endsWith("/resume")));
      f.failReads(true);
      app.route("home");
      await until(() => app.scope().items()[0]?.slow === true);
      await settle();
      const checks = f.calls.length,
        checkNow = Array.from(root.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Check now",
        );
      check(checkNow, "source Check now missing");
      checkNow.click();
      await until(() => f.calls.length > checks);
      const stop = Array.from(root.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Stop watching here",
      );
      check(stop, "source stop-watching missing");
      stop.click();
      await settle();
      check(
        app.scope().count() === 0 && (await readSaved(f))?.requestId,
        "card dismissal erased durable unknown",
      );
      f.failReads(false);
      app.route("publish");
      await until(() => app.scope().count() === 1);
      results.push(
        "source check/retry guard/status/stop-watching; native uncertain resume keeps same job; unknown dismissal retains draft",
      );
    } finally {
      app.dispose();
      await clean(f);
    }
  }
  for (const change of [
    "account",
    "community",
    "csrf",
    "private-owner-loss",
    "unknown-authority",
    "403-headers",
  ] as const) {
    const f = shellFixture(location.origin);
    await seed(f);
    let refreshed = 0;
    const app = mount(root, f, async () => {
      refreshed++;
    });
    let gate: ReturnType<typeof f.delay> | undefined;
    let replacement: ReturnType<typeof f.delay> | undefined;
    try {
      await until(() => app.scope().count() === 1);
      const old = app.scope().runtime();
      f.phase("published");
      gate = f.delay(change === "403-headers" ? "auth-headers" : "job-body");
      app.scope().check(f.submissionId);
      await until(() => gate!.entered.done);
      if (change !== "403-headers") {
        const next = structuredClone(f.context);
        if (change === "account") next.owner.accountId = crypto.randomUUID();
        if (change === "community") {
          next.community.id = "0x" + "a".repeat(64);
          next.owner.communityId = next.community.id;
          next.feed.communityId = next.community.id;
        }
        if (change === "csrf") next.session.csrf = "fixture-next-csrf";
        // Same account/namespace with fresh CSRF legitimately recovers the
        // saved job. Hold that owner's independent response so it cannot be
        // mistaken for the old runtime's late notification.
        if (change === "csrf") replacement = f.delay("job-body");
        app.authority(
          change === "private-owner-loss" || change === "unknown-authority"
            ? null
            : next,
        );
      }
      check(
        app.scope().count() === 0 && app.scope().runtime() === null,
        "old authority not immediately masked",
      );
      await settle();
      check(
        old?.owner.signal.aborted,
        "old authority did not abort its captured owner",
      );
      check(
        !root.querySelector('[aria-label="Close song status"]') &&
          !root.querySelector("[data-pending-song]"),
        "obsolete accepted-job UI survived authority loss",
      );
      const before = f.calls.length;
      gate.release.resolve();
      if (replacement) await until(() => replacement!.entered.done);
      await settle();
      const late = replacement ? await readCommitted(f) : await readSaved(f);
      if (change !== "403-headers")
        check(
          late?.job?.phase === "published",
          "late canonical receipt was not saved under original lock",
        );
      check(
        Number(refreshed) === 0,
        "late old receipt notified new owner during " + change,
      );
      check(
        f.calls
          .slice(before)
          .every(
            (call) =>
              call.method === "GET" &&
              !call.path.endsWith("/proof") &&
              call.path !== "/api/feed",
          ),
        "old authority dispatched a follow-on command/proof",
      );
      check(!old?.active(), "old captured owner survived invalidation");
      if (replacement) {
        const writes = f.calls.filter((call) => call.method !== "GET").length;
        replacement.release.resolve();
        await until(() => refreshed === 1);
        await settle();
        check(
          app.scope().runtime()?.active() &&
            app.scope().runtime()?.record()?.requestId === late?.requestId &&
            f.calls.filter((call) => call.method !== "GET").length === writes,
          "replacement owner did not recover the same job without a POST",
        );
        check(refreshed === 1, "replacement owner refreshed more than once");
      }
      results.push(
        change +
          " masks/invalidates before late body; no stale callback, publication or next command",
      );
    } finally {
      gate?.release.resolve();
      replacement?.release.resolve();
      app.dispose();
      await clean(f);
    }
  }
  {
    const f = shellFixture(location.origin),
      gate = f.delay("audio-ack"),
      app = mount(root, f, async () => {});
    try {
      await until(
        () => !!app.scope().runtime() && !app.scope().runtime()?.busy(),
      );
      const runtime = app.scope().runtime()!;
      runtime.setSong({
        title: f.input.title,
        primaryAudioUpload: f.input.file,
        instrumentalAudioUpload: f.input.instrumental,
        vocalAudioUpload: f.input.vocals,
      });
      runtime.setLyrics(f.input.lyrics);
      await settle();
      const next = () =>
        Array.from(root.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Next",
        );
      check(next(), "source Song Next missing");
      next()!.click();
      await settle();
      const consent = root.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
        rating = root.querySelector<HTMLInputElement>(
          'input[type="radio"][value="general"]',
        );
      check(consent && rating, "source backend policy inputs missing");
      consent.click();
      rating.click();
      await settle();
      check(next(), "source policy Next missing");
      next()!.click();
      await until(() => gate.entered.done);
      await until(() => runtime.record()?.pending === "audio");
      const original = runtime.record()!;
      app.route("home");
      await settle();
      const before = f.calls.length;
      gate.release.resolve();
      await until(() => !runtime.busy());
      const saved = await readSaved(f);
      check(
        saved?.requestId === original.requestId &&
          saved.bodyDigest === original.bodyDigest &&
          saved.files.audio instanceof File,
        "close lost original intent/File",
      );
      check(
        f.calls.slice(before).every((call) => call.method === "GET"),
        "late PUT dispatched another stem/POST after close",
      );
      const writes = f.calls.filter((call) => call.method !== "GET").length;
      app.route("publish");
      await settle();
      await until(() => !runtime.busy());
      check(
        f.calls.filter((call) => call.method !== "GET").length === writes,
        "reopen automatically continued upload",
      );
      await runtime.prepare(f.input);
      const resumed = await readSaved(f);
      check(
        resumed?.requestId === original.requestId &&
          resumed.bodyDigest === original.bodyDigest &&
          f.calls.filter((call) => call.path.endsWith("/audio")).length === 1,
        "explicit continuation changed UUID/body or retransmitted committed master",
      );
      results.push(
        "actual source policy Next preparation/history disposal pauses ignored PUT, retains intent/Files, reconciles reads only; explicit continuation uses same UUID/body and remaining stems",
      );
    } finally {
      gate.release.resolve();
      app.dispose();
      await clean(f);
    }
  }
  {
    const f = shellFixture(location.origin),
      entered = latch();
    let scope!: CommunityComposerScope;
    const dispose = render(() => {
      scope = createCommunityComposerScope({
        current: () => f.context,
        refreshFeed: async () => {},
        transport: f.transport,
        platform: () => {
          entered.resolve();
          throw new Error("Explicit unsupported native capability fixture");
        },
      });
      return (
        <CommunityComposerHost scope={scope} open onOpenChange={() => {}} />
      );
    }, root);
    try {
      await until(() => entered.done);
      await settle();
      check(
        root.textContent?.includes("cannot safely save your release"),
        "native unsupported state missing",
      );
      check(
        scope.count() === 0 && f.calls.length === 0,
        "unsupported storage fell back or dispatched HTTP",
      );
      results.push(
        "unsupported native storage is concrete unavailable state; no memory fallback or HTTP",
      );
    } finally {
      dispose();
    }
  }
  return {
    cases: results,
    execution:
      "native harness required; all HTTP explicit simulation; no acceptance beyond these cases",
  };
}
