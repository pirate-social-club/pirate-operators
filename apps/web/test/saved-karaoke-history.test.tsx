// UNRUN. Actual Solid owner, source page/mount, saved producer and learningRequest.
// Only HTTP responses and Blob/file delivery are controlled local fixtures.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  LearningPageMount,
  type LearningPageRoute,
} from "../src/live/learning-pages.tsx";
import { createLearningActionOwner } from "../src/live/learning-action-owner.ts";
import {
  createSavedKaraokeHistory,
  type KaraokeHistorySession,
  type KaraokeHistoryTicket,
} from "../src/karaoke/saved-history.ts";
import { LearningServiceError } from "../src/karaoke/operator-learning-http.ts";
const hex = (digit: string, bytes = 32) => "0x" + digit.repeat(bytes * 2);
const wallet = hex("a", 20),
  communityId = hex("b"),
  postId = hex("c"),
  ticketId = hex("d"),
  sessionId = hex("e");
const auth: KaraokeHistorySession = {
  communityId,
  wallet,
  authorId: hex("f"),
  accountId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  csrf: "fixture-current-session",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
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
  let cookieWallet = wallet,
    sessionStatus = 200,
    endpointStatus = 200;
  const started = deferred<void>();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      body = value;
    },
  });
  const requests: { path: string; init?: RequestInit }[] = [];
  const deniedBodies = vi.fn();
  const history = {
    schema: "pirate.learner-history/1",
    activity: "karaoke",
    sessionId,
    communityId,
    source: { communityId, postId },
    expiresAt: 1800086400,
    observations: { recognizedWords: [{ text: "retained private words" }] },
    provider: { name: "elevenlabs", model: "scribe_v2_realtime" },
  };
  const finished = {
    state: "finished",
    result: {
      body: {
        communityId,
        ticketId,
        attemptId: sessionId,
        status: "completed",
        summary: { scoreBps: 8200 },
        lines: [],
        unmeasuredCount: 0,
      },
    },
    record: {
      consented: true,
      consent: null,
      publication: { state: "recorded" },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, init });
      if (path === "/api/session")
        return Response.json(
          { mossAddress: cookieWallet },
          { status: sessionStatus },
        );
      if (path === `/api/public/posts/${postId}/karaoke`)
        return Response.json({
          lines: [
            {
              lineId: hex("1"),
              ordinal: 0,
              text: "Fixture lyric",
              startMs: 0,
              endMs: 3000,
              words: [],
            },
          ],
          segments: [],
        });
      if (path === `/api/karaoke/attempt?postId=${postId}`)
        return Response.json(finished);
      expect(path).toBe("/api/karaoke/history");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-study-account")).toBe(wallet);
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe(auth.csrf);
      expect(init?.credentials).toBe("same-origin");
      expect(init?.body).toBe(JSON.stringify({ ticketId }));
      started.resolve();
      if (endpointStatus !== 200) {
        const response = new Response(new ReadableStream(), {
          status: endpointStatus,
        });
        vi.spyOn(response, "json").mockImplementation(async () => {
          deniedBodies();
          throw new Error("Denied body must not be read");
        });
        return response;
      }
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const files: Blob[] = [],
    clicks: string[] = [],
    revoked: string[] = [];
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(value: Blob) {
        files.push(value);
        return "blob:fixture-history";
      }
      static revokeObjectURL(value: string) {
        revoked.push(value);
      }
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.download);
  });
  return {
    requests,
    history,
    started: started.promise,
    files,
    clicks,
    revoked,
    deniedBodies,
    finish(value: unknown = history) {
      body.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      body.close();
    },
    cookie(value: string) {
      cookieWallet = value;
    },
    denySession(value: number) {
      sessionStatus = value;
    },
    denyEndpoint(value: number) {
      endpointStatus = value;
    },
  };
}
function mount() {
  const [session, setSession] = createSignal<KaraokeHistorySession | null>({
    ...auth,
  });
  const [route, setRoute] = createSignal<LearningPageRoute | null>({
    kind: "sing",
    postId,
    title: "Fixture song",
  });
  let history!: ReturnType<typeof createSavedKaraokeHistory>;
  const actions = createLearningActionOwner(() => {});
  const handedOff: KaraokeHistoryTicket[] = [];
  const signConsent = vi.fn(async () => {
    throw new Error("Export must not sign");
  });
  function AppOwner() {
    history = createSavedKaraokeHistory(session);
    return (
      <>
        <LearningPageMount
          communityId={session()?.communityId ?? communityId}
          route={route()}
          account={session()?.wallet ?? null}
          csrf={session()?.csrf ?? ""}
          historyGeneration={session()?.generation ?? 0}
          onKaraokeHistory={(ticket, generation) => {
            if (ticket) {
              handedOff.push(ticket);
              history.remember(ticket, generation);
            } else history.clear();
          }}
          wallet={{ signConsent }}
          signInPermission={true}
          actions={actions}
          onExit={() => setRoute(null)}
          onConnect={() => {
            throw new Error("Export must not connect");
          }}
          onLessonOpened={() => {
            throw new Error("No Study start");
          }}
        />
        <button disabled={!history.available()}>
          Download private history
        </button>
      </>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const cleanup = render(() => <AppOwner />, host);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      cleanup();
    }
  };
  cleanups.push(dispose);
  return {
    host,
    history,
    actions,
    setSession,
    close: () => setRoute(null),
    dispose,
    signConsent,
    handedOff,
  };
}
const observe = (value: Promise<void>) =>
  value.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );
async function heldDownload(
  api: ReturnType<typeof fixture>,
  app: ReturnType<typeof mount>,
) {
  const pending = observe(app.history.download());
  await Promise.race([
    api.started,
    pending.then((outcome) => {
      throw new Error("History finished before the held response body", {
        cause: outcome.ok ? undefined : outcome.error,
      });
    }),
  ]);
  return { pending };
}
function noFiles(api: ReturnType<typeof fixture>) {
  expect(api.files).toEqual([]);
  expect(api.clicks).toEqual([]);
  expect(api.revoked).toEqual([]);
}
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
async function leavePage(
  api: ReturnType<typeof fixture>,
  app: ReturnType<typeof mount>,
) {
  await vi.waitFor(() => expect(app.history.available()).toBe(true));
  expect(app.host.querySelector(".live-karaoke-overlay")).not.toBeNull();
  app.close();
  await vi.waitFor(() =>
    expect(app.host.querySelector(".live-karaoke-overlay")).toBeNull(),
  );
  const pageRequests = api.requests.filter(
    (request) =>
      request.path.includes("/karaoke") &&
      request.path !== "/api/karaoke/history",
  );
  expect(pageRequests.length).toBeGreaterThan(0);
  expect(pageRequests.every((request) => request.init?.signal?.aborted)).toBe(
    true,
  );
  expect(app.history.available()).toBe(true);
  expect(app.actions.current()).toBeNull();
}
test("actual page hands off the original ticket; export survives its real page/port cleanup", async () => {
  const api = fixture(),
    app = mount();
  await leavePage(api, app);
  expect(app.handedOff).toHaveLength(1);
  expect(Object.isFrozen(app.handedOff[0])).toBe(true);
  expect(Object.keys(app.handedOff[0]!).sort()).toEqual([
    "communityId",
    "postId",
    "sessionId",
    "ticketId",
    "wallet",
  ]);
  const before = api.requests.length;
  const { pending } = await heldDownload(api, app);
  noFiles(api);
  const exported = api.requests.find(
    (request) => request.path === "/api/karaoke/history",
  )!;
  expect(exported.init?.signal?.aborted).toBe(false);
  expect(
    api.requests
      .filter(
        (request) =>
          request.path.includes("/karaoke") &&
          request.path !== "/api/karaoke/history",
      )
      .some((request) => request.init?.signal === exported.init?.signal),
  ).toBe(false);
  api.finish();
  expect((await pending).ok).toBe(true);
  expect(api.files).toHaveLength(1);
  expect(JSON.parse(await readBlob(api.files[0]!))).toEqual(api.history);
  expect(api.clicks).toEqual([`learning-history-${ticketId}.json`]);
  expect(api.revoked).toEqual(["blob:fixture-history"]);
  expect(api.requests.slice(before).map((request) => request.path)).toEqual([
    "/api/session",
    "/api/karaoke/history",
    "/api/session",
  ]);
  expect(app.signConsent).not.toHaveBeenCalled();
  expect(
    api.requests
      .filter((request) => request.init?.method === "POST")
      .map((request) => request.path),
  ).toEqual(["/api/karaoke/history"]);
});
test.each([
  "logout",
  "account",
  "community",
  "session-generation",
  "private-owner",
  "disposed",
] as const)(
  "delayed private body after %s delivers no obsolete file",
  async (boundary) => {
    const api = fixture(),
      app = mount();
    await leavePage(api, app);
    const { pending } = await heldDownload(api, app);
    if (boundary === "logout") app.setSession(null);
    else if (boundary === "disposed") app.dispose();
    else
      app.setSession({
        ...auth,
        wallet: boundary === "account" ? hex("1", 20) : auth.wallet,
        communityId: boundary === "community" ? hex("2") : auth.communityId,
        generation: boundary === "session-generation" ? 2 : auth.generation,
        csrf: boundary === "session-generation" ? "renewed-csrf" : auth.csrf,
        accountId:
          boundary === "private-owner"
            ? "22222222-2222-4222-8222-222222222222"
            : auth.accountId,
      });
    if (boundary === "account") api.cookie(hex("1", 20));
    api.finish();
    expect((await pending).ok).toBe(false);
    noFiles(api);
    expect(app.signConsent).not.toHaveBeenCalled();
    expect(
      api.requests.filter((request) => request.init?.method === "POST"),
    ).toHaveLength(1);
  },
);
test.each([401, 403])(
  "typed endpoint %s refuses without reading its body or delivering a file",
  async (status) => {
    const api = fixture(),
      app = mount();
    await leavePage(api, app);
    api.denyEndpoint(status);
    const result = await observe(app.history.download());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(LearningServiceError);
      expect(result.error.status).toBe(status);
    }
    expect(api.deniedBodies).not.toHaveBeenCalled();
    noFiles(api);
    expect(app.history.available()).toBe(false);
  },
);
test.each([401, 403])(
  "typed session %s never dispatches the history endpoint",
  async (status) => {
    const api = fixture(),
      app = mount();
    await leavePage(api, app);
    api.denySession(status);
    const count = api.requests.length,
      result = await observe(app.history.download());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(LearningServiceError);
      expect(result.error.status).toBe(status);
    }
    expect(api.requests.slice(count).map((request) => request.path)).toEqual([
      "/api/session",
    ]);
    noFiles(api);
  },
);
test.each(["community", "post", "session", "schema"] as const)(
  "a mismatched %s envelope cannot create a file for the original ticket",
  async (field) => {
    const api = fixture(),
      app = mount();
    await leavePage(api, app);
    const { pending } = await heldDownload(api, app);
    api.finish({
      ...api.history,
      communityId: field === "community" ? hex("1") : communityId,
      sessionId: field === "session" ? hex("2") : sessionId,
      source: { communityId, postId: field === "post" ? hex("3") : postId },
      schema: field === "schema" ? "foreign" : api.history.schema,
    });
    expect((await pending).ok).toBe(false);
    noFiles(api);
  },
);
