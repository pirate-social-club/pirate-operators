// UNRUN proposal. Real Solid 2 owner/DOM + actual createSavedStudyHistory and
// learningRequest. Only fetch/Blob download delivery are controlled fixtures.
// This is component lifetime evidence when run, not full App/browser evidence.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  createSavedStudyHistory,
  type StudyHistoryOwner,
  type StudyHistorySession,
} from "../src/study/saved-history.ts";

const wallet = `0x${"a".repeat(40)}`;
const otherWallet = `0x${"b".repeat(40)}`;
const privateUUID = "11111111-1111-4111-8111-111111111111";
const otherUUID = "22222222-2222-4222-8222-222222222222";
const lessonId = "33333333-3333-4333-8333-333333333333";
const nextLessonId = "44444444-4444-4444-8444-444444444444";
const session: StudyHistorySession = {
  communityId: `0x${"c".repeat(64)}`,
  wallet,
  authorId: `0x${"d".repeat(64)}`,
  csrf: "session-generation-a",
};
const privateOwner: StudyHistoryOwner = { ...session, accountId: privateUUID };
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let cookieWallet = wallet;
  const started = deferred<void>();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
    },
  });
  const requests: {
    path: string;
    method: string;
    headers: Headers;
    body: BodyInit | null | undefined;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input),
        method = init?.method ?? "GET";
      requests.push({
        path,
        method,
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      if (path === "/api/session")
        return new Response(JSON.stringify({ mossAddress: cookieWallet }), {
          status: 200,
        });
      expect(path).toBe(`/api/study/lessons/${lessonId}/history`);
      expect(method).toBe("POST");
      expect(new Headers(init?.headers).get("x-study-account")).toBe(wallet);
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe(session.csrf);
      expect(init?.credentials).toBe("same-origin");
      expect(init?.body).toBe("{}");
      started.resolve();
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const files: Blob[] = [],
    clicks: { href: string; download: string }[] = [],
    revoked: string[] = [];
  // jsdom does not implement browser Blob download navigation. Keep all actual
  // producer/HTTP work; record the exact file creation/delivery side effects.
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(blob: Blob) {
        files.push(blob);
        return `blob:history-${files.length}`;
      }
      static revokeObjectURL(url: string) {
        revoked.push(url);
      }
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download });
  });
  const history = {
    schema: "pirate.study-private-history/1",
    communityId: session.communityId,
    lesson: { lessonId },
    retention: { expiresAt: 1700000000 },
    attempts: [
      { heardTranscript: "private retained answer", attemptId: "same-attempt" },
    ],
  };
  return {
    requests,
    files,
    clicks,
    revoked,
    history,
    started: started.promise,
    switchCookie(value: string) {
      cookieWallet = value;
    },
    finish(value: unknown = history) {
      body.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      body.close();
    },
    posts() {
      return requests.filter((request) => request.method === "POST");
    },
  };
}
function mount(initialOwner: StudyHistoryOwner | null = privateOwner) {
  const [auth, setAuth] = createSignal<StudyHistorySession | null>({
    ...session,
  });
  const [owner, setOwner] = createSignal<StudyHistoryOwner | null>(
    initialOwner,
  );
  let history!: ReturnType<typeof createSavedStudyHistory>;
  function AppHistoryOwner() {
    history = createSavedStudyHistory(auth, owner);
    return (
      <button disabled={!history.available()}>Download private history</button>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  let disposed = false;
  const cleanup = render(() => <AppHistoryOwner />, host);
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      cleanup();
    }
  };
  disposers.push(dispose);
  const button = () => host.querySelector("button")!;
  return { host, history, setAuth, setOwner, dispose, button };
}
function observe(promise: Promise<void>) {
  // Install both handlers before releasing a deferred body (no unhandled rejection).
  return promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
function expectNoFiles(api: ReturnType<typeof fixture>) {
  expect(api.files).toEqual([]);
  expect(api.clicks).toEqual([]);
  expect(api.revoked).toEqual([]);
}

test("delayed genuine private UUID binds once, then current owner downloads the complete server envelope", async () => {
  const api = fixture(),
    app = mount(null);
  app.history.remember(lessonId, "post-a");
  expect(app.history.available()).toBe(false);
  await expect(app.history.download()).rejects.toThrow(
    "Private history is unavailable",
  );
  expect(api.requests).toEqual([]); // no authority while the private profile is unresolved
  expectNoFiles(api);
  app.setOwner({
    ...privateOwner,
    accountId: "public-author-is-not-a-private-uuid",
  });
  expect(app.history.available()).toBe(false);
  app.setOwner({ ...privateOwner });
  await vi.waitFor(() => expect(app.button().disabled).toBe(false));
  expect(app.history.available()).toBe(true);
  const pending = app.history.download();
  await api.started;
  expectNoFiles(api);
  api.finish();
  await pending;
  expect(api.files).toHaveLength(1);
  expect(JSON.parse(await readBlob(api.files[0]!))).toEqual(api.history);
  expect(api.clicks).toEqual([
    { href: "blob:history-1", download: `study-history-${lessonId}.json` },
  ]);
  expect(api.revoked).toEqual(["blob:history-1"]);
  expect(api.posts().map((request) => request.path)).toEqual([
    `/api/study/lessons/${lessonId}/history`,
  ]);
  expect(api.requests.map((request) => request.path)).toEqual([
    "/api/session",
    `/api/study/lessons/${lessonId}/history`,
    "/api/session",
  ]);
});

test.each([
  "session-generation",
  "selection",
  "disposed",
  "private-owner",
  "community",
  "account",
] as const)(
  "a delayed history body after %s creates/delivers no obsolete file and never starts another lesson",
  async (boundary) => {
    const api = fixture(),
      app = mount();
    app.history.remember(lessonId, "post-a");
    await vi.waitFor(() => expect(app.button().disabled).toBe(false));
    const pending = observe(app.history.download());
    await api.started; // actual POST dispatched, Response.json still waits for bytes
    expectNoFiles(api);
    if (boundary === "session-generation") {
      app.setAuth({ ...session, csrf: "session-generation-b" });
      app.setOwner({ ...privateOwner, csrf: "session-generation-b" });
    } else if (boundary === "selection")
      app.history.remember(nextLessonId, "post-b");
    else if (boundary === "disposed") app.dispose();
    else if (boundary === "private-owner")
      app.setOwner({ ...privateOwner, accountId: otherUUID });
    else if (boundary === "community") {
      const communityId = `0x${"e".repeat(64)}`;
      app.setAuth({ ...session, communityId });
      app.setOwner({ ...privateOwner, communityId });
    } else {
      app.setAuth({ ...session, wallet: otherWallet });
      app.setOwner({
        ...privateOwner,
        wallet: otherWallet,
        accountId: otherUUID,
      });
      api.switchCookie(otherWallet);
    }
    api.finish();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expectNoFiles(api);
    expect(api.posts().map((request) => request.path)).toEqual([
      `/api/study/lessons/${lessonId}/history`,
    ]);
    expect(
      api.requests.some((request) =>
        /enrollment|abandon|attempts/.test(request.path),
      ),
    ).toBe(false);
    if (boundary === "disposed") {
      expect(app.host.querySelector("button")).toBeNull();
      await expect(app.history.download()).rejects.toThrow(
        "Private history is unavailable",
      );
      expect(api.posts()).toHaveLength(1);
    }
    if (boundary === "selection") expect(app.history.available()).toBe(true);
  },
);

test("same wallet with replaced private UUID cannot rebind or dispatch the old saved selection", async () => {
  const api = fixture(),
    app = mount();
  app.history.remember(lessonId, "post-a");
  await vi.waitFor(() => expect(app.button().disabled).toBe(false));
  app.setOwner({ ...privateOwner, accountId: otherUUID });
  await vi.waitFor(() => expect(app.history.available()).toBe(false));
  await expect(app.history.download()).rejects.toThrow(
    "Private history is unavailable",
  );
  expect(api.requests).toEqual([]);
  expectNoFiles(api);
});

test("a foreign lesson envelope cannot create a file despite a live current account", async () => {
  const api = fixture(),
    app = mount();
  app.history.remember(lessonId, "post-a");
  await vi.waitFor(() => expect(app.history.available()).toBe(true));
  const pending = observe(app.history.download());
  await api.started;
  api.finish({ ...api.history, lesson: { lessonId: nextLessonId } });
  expect((await pending).ok).toBe(false);
  expectNoFiles(api);
  expect(api.posts()).toHaveLength(1);
});
