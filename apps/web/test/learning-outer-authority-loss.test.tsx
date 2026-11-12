// UNRUN at5430. Actual page/client/source controllers over explicit local HTTP.
// Karaoke uses the actual c7 hook/controller/graph; only hardware/socket are
// memory fixtures adapted from learning-real-capture-recovery.test.tsx (c7).
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { StudyPage } from "../src/study/page.tsx";
import { KaraokePage } from "../src/karaoke/page.tsx";
import * as browserRecorder from "../src/study/studying-browser-recorder.ts";
import {
  useKaraokeCapture,
  type UseKaraokeCaptureOptions,
  type UseKaraokeCaptureResult,
} from "../src/karaoke/use-karaoke-capture.ts";
import { KaraokePlaybackGraph } from "../src/karaoke/playback-graph.ts";
import {
  createKaraokeCaptureController,
  type KaraokeCaptureController,
} from "../../../packages/karaoke/capture-controller.ts";
import type { KaraokeOperatorSocket } from "../../../packages/karaoke/operator-audio-client.ts";
import type { StudyLesson } from "../../../packages/study/lesson.ts";

const walletA = `0x${"a".repeat(40)}`,
  walletB = `0x${"b".repeat(40)}`;
const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const postId = `0x${"3".repeat(64)}`;
const song = {
  chainId: 6343,
  postsContract: `0x${"1".repeat(40)}`,
  communityId: `0x${"2".repeat(64)}`,
  postId,
  lyricRevision: 1,
};
type Actions = { download(): Promise<void> };
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function held(status: number) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
    { status },
  );
  const original = response.json.bind(response);
  const reads = vi.spyOn(response, "json").mockImplementation(original);
  return {
    response,
    reads,
    release(text = "malformed") {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}
function lesson(id = oldId, completed = true): StudyLesson {
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: id,
    song,
    startedAt: 100,
    expiresAt: Number.MAX_SAFE_INTEGER,
    completedAt: completed ? 200 : null,
    status: completed ? "completed" : "active",
    completionReason: null,
    current: completed
      ? null
      : {
          line: {
            ...song,
            lineId: `0x${"4".repeat(64)}`,
            lineVersion: 1,
            text: "Private original words",
            language: "en",
            manifestDigest: `0x${"5".repeat(64)}`,
          },
          presentationNumber: 1,
          takeNumber: 1,
          attempt: null,
        },
    lastAttempt: null,
    progress: {
      total: 4,
      resolved: completed ? 4 : 0,
      mastered: completed ? 4 : 0,
      presentations: completed ? 4 : 0,
      presentationCap: 12,
      firstPassGraded: completed ? 4 : 0,
      firstPassCorrect: completed ? (id === oldId ? 3 : 4) : 0,
    },
    qualification: "not_evaluated",
  };
}
const open = {
  state: "open",
  ticket: { body: { ticketId: "original-ticket" } },
  socketUrl: "wss://community.invalid/attempt",
  proof: "original-proof",
  elapsedMs: null,
};
const finished = {
  state: "finished",
  result: {
    body: {
      ticketId: "original-ticket",
      status: "completed",
      summary: { scoreBps: 8200 },
      lines: [],
      unmeasuredCount: 0,
      presentation: {
        finalScore: 0.82,
        lyricsScore: 0.88,
        timingScore: null,
        timingTrend: "on_time",
        scoredLineCount: 1,
        uncertainLineCount: 0,
        bestCombo: 1,
      },
    },
  },
  record: { consented: true, consent: null, publication: { state: "pending" } },
};
function http() {
  let account = walletA,
    csrf = "old-csrf",
    completed = true,
    result = false;
  let denial:
    | {
        at: "session" | "history" | "attempt" | "publication";
        response: Response;
      }
    | undefined;
  const calls: { path: string; method: string; body?: string }[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      calls.push({
        path,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      expect(init?.credentials).toBe("same-origin");
      if (path === "/api/session")
        return denial?.at === "session"
          ? denial.response
          : json({ mossAddress: account, csrf });
      const headers = new Headers(init?.headers);
      expect(headers.get("x-study-account")).toBe(account);
      if (method === "POST") expect(headers.get("x-csrf-token")).toBe(csrf);
      if (path.startsWith("/api/study/song?")) return json(song);
      if (path.endsWith("/history")) {
        if (denial?.at === "history") return denial.response;
        throw Error("this fixture has no successful history capability");
      }
      if (path.endsWith("/publication"))
        return denial?.at === "publication"
          ? denial.response
          : json({ state: "pending", receipt: null });
      if (path === `/api/study/lessons/${oldId}/attempts`)
        return json({
          lesson: lesson(oldId, false),
          attempt: {
            schema: "pirate.study.attempt/1",
            kind: "say-it-back",
            attemptId: "original-attempt",
            line: lesson(oldId, false).current!.line,
            policy: "script_aware_token_phonetic_v5",
            startedAt: 101,
            completedAt: null,
            state: "ready",
            grade: null,
            failure: null,
            recordingDurationMs: null,
            lesson: { lessonId: oldId, presentationNumber: 1, takeNumber: 1 },
          },
        });
      if (
        path === `/api/study/lessons/${oldId}` ||
        path === `/api/study/lessons/${newId}`
      )
        return json(lesson(path.endsWith(newId) ? newId : oldId, completed));
      if (path === `/api/public/posts/${postId}/karaoke`)
        return json({
          lines: [
            {
              lineId: "line",
              ordinal: 0,
              text: "Private scored line",
              startMs: 1000,
              endMs: 4000,
              words: [],
            },
          ],
          segments: [],
        });
      if (path === `/api/karaoke/attempt?postId=${postId}`)
        return denial?.at === "attempt"
          ? denial.response
          : json(result ? finished : open);
      throw Error(`Unscripted actual page request ${method} ${path}`);
    },
  );
  vi.stubGlobal("fetch", transport);
  return {
    calls,
    transport,
    account: (value: string) => {
      account = value;
    },
    csrf: (value: string) => {
      csrf = value;
    },
    active: () => {
      completed = false;
    },
    finished: () => {
      result = true;
    },
    fail: (
      at: "session" | "history" | "attempt" | "publication",
      response: Response,
    ) => {
      denial = { at, response };
    },
    clear: () => {
      denial = undefined;
    },
    mutations: () =>
      calls.filter(
        (call) =>
          call.method !== "GET" &&
          !/history|publication|attempts$/.test(call.path),
      ),
  };
}
function host() {
  const node = document.createElement("div");
  document.body.append(node);
  return node;
}
async function press(node: HTMLElement, text: string) {
  const button = await vi.waitFor(() => {
    const control = [...node.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    );
    expect(control).toBeDefined();
    return control!;
  });
  button.click();
}
function study() {
  const node = host();
  let actions: Actions | null = null;
  const created = browserRecorder.createStudyingBrowserRecorder;
  const cancels: (() => number)[] = [];
  vi.spyOn(browserRecorder, "createStudyingBrowserRecorder").mockImplementation(
    () => {
      const recorder = created();
      const cancel = recorder.cancel!.bind(recorder);
      const observedCancel = vi.fn(cancel);
      recorder.cancel = observedCancel;
      cancels.push(() => observedCancel.mock.calls.length);
      return recorder;
    },
  );
  const [scope, setScope] = createSignal({
    account: walletA,
    csrf: "old-csrf",
    lessonId: oldId,
  });
  const dispose = render(
    () => (
      <StudyPage
        {...scope()}
        postId={postId}
        title="Fixture song"
        signInPermission
        onExit={() => {}}
        onLearningActions={(value) => {
          actions = value;
        }}
      />
    ),
    node,
  );
  cleanup.push(dispose);
  return { node, dispose, action: () => actions, cancels, replace: setScope };
}
function studyMasked(app: ReturnType<typeof study>) {
  expect(app.node.textContent).toContain("Sign in to study");
  expect(app.node.textContent).not.toContain("3/4");
  expect(app.node.textContent).not.toContain("Private original words");
  expect(app.node.querySelector("audio")).toBeNull();
  expect(
    [...app.node.querySelectorAll("button")].some((button) =>
      /^(Record|Stop|Study again)$/.test(button.textContent?.trim() ?? ""),
    ),
  ).toBe(false);
  expect(app.action()).toBeNull();
  expect(app.cancels.some((count) => count() > 0)).toBe(true);
}
async function studyReady(
  api: ReturnType<typeof http>,
  app: ReturnType<typeof study>,
) {
  await vi.waitFor(() => expect(app.node.textContent).toContain("3/4"));
  await vi.waitFor(() =>
    expect(api.calls.some((call) => call.path.endsWith("/publication"))).toBe(
      true,
    ),
  );
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  expect(app.action()).not.toBeNull();
}
for (const status of [401, 403])
  for (const at of ["session", "publication", "history"] as const)
    test(`actual completed Study ${at} ${status} masks before body and stops polling/actions`, async () => {
      vi.useFakeTimers();
      const api = http(),
        app = study();
      await studyReady(api, app);
      await vi.waitFor(() =>
        expect(
          api.calls.some((call) => call.path.endsWith("/publication")),
        ).toBe(true),
      );
      const action = app.action();
      expect(action).not.toBeNull();
      const denied = held(status);
      api.fail(at, denied.response);
      let download: Promise<unknown> | undefined;
      if (at === "history")
        download = action!.download().catch((error: unknown) => error);
      else await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => studyMasked(app));
      expect(denied.reads).not.toHaveBeenCalled();
      const count = api.calls.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(api.calls).toHaveLength(count);
      await expect(action!.download()).rejects.toThrow(/closed/);
      expect(api.calls).toHaveLength(count);
      denied.release(status === 401 ? "" : "malformed");
      if (download) expect(await download).toMatchObject({ status });
      studyMasked(app);
      expect(api.mutations()).toEqual([]);
    });

test("Study positively detects account replacement in outer poll without reading another private lesson", async () => {
  vi.useFakeTimers();
  const api = http(),
    app = study();
  await studyReady(api, app);
  api.account(walletB);
  const before = api.calls.filter(
    (call) => call.path !== "/api/session",
  ).length;
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => studyMasked(app));
  expect(app.node.textContent).toContain(
    "You are signed in with a different account. Reload to continue.",
  );
  expect(api.calls.filter((call) => call.path !== "/api/session")).toHaveLength(
    before,
  );
});

test("outer Study history denial cancels the actual browser recorder and borrowed microphone", async () => {
  const api = http();
  api.active();
  const stopTrack = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: stopTrack }],
      })),
    },
  });
  cleanup.push(() => {
    if (descriptor)
      Object.defineProperty(navigator, "mediaDevices", descriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });
  class DeviceRecorder extends EventTarget {
    static isTypeSupported(type: string) {
      return type === "audio/webm";
    }
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", DeviceRecorder);
  const app = study();
  await press(app.node, "Record");
  await vi.waitFor(() =>
    expect(
      [...app.node.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Stop",
      ),
    ).toBe(true),
  );
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  const denied = held(403);
  api.fail("history", denied.response);
  const outcome = app
    .action()!
    .download()
    .catch((error: unknown) => error);
  await vi.waitFor(() => studyMasked(app));
  expect(await outcome).toMatchObject({ status: 403 });
  expect(stopTrack).toHaveBeenCalled();
  expect(denied.reads).not.toHaveBeenCalled();
  denied.release();
  expect(api.mutations()).toEqual([]);
});

test("ordinary Study503 poll retains the real saved result/actions and explicit same history failure", async () => {
  vi.useFakeTimers();
  const api = http(),
    app = study();
  await studyReady(api, app);
  const denied = held(503);
  api.fail("publication", denied.response);
  await vi.advanceTimersByTimeAsync(3000);
  expect(app.node.textContent).toContain("3/4");
  expect(app.action()).not.toBeNull();
  denied.release('{"error":"temporary_outage"}');
  await vi.advanceTimersByTimeAsync(0);
  expect(app.node.textContent).not.toContain("Sign in to study");
  api.fail("history", json({ error: "temporary_outage" }, 503));
  await expect(app.action()!.download()).rejects.toMatchObject({ status: 503 });
  expect(app.node.textContent).toContain("3/4");
  expect(app.action()).not.toBeNull();
  expect(api.mutations()).toEqual([]);
});

for (const boundary of ["account", "session", "lesson", "dispose"] as const)
  test(`late Study history after ${boundary} cannot create a file or replace current actions`, async () => {
    const api = http(),
      app = study();
    await studyReady(api, app);
    const delayed = held(200);
    api.fail("history", delayed.response);
    const create = vi.fn(() => "blob:must-not-be-created");
    const NativeURL = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeURL {
        static createObjectURL = create;
        static revokeObjectURL = vi.fn();
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const oldAction = app.action()!;
    const pending = oldAction.download().catch((error: unknown) => error);
    await vi.waitFor(() => expect(delayed.reads).toHaveBeenCalledOnce());
    api.clear();
    if (boundary === "dispose") {
      app.dispose();
      cleanup.pop();
    } else {
      if (boundary === "account") api.account(walletB);
      if (boundary === "account" || boundary === "session")
        api.csrf("new-csrf");
      app.replace({
        account: boundary === "account" ? walletB : walletA,
        csrf:
          boundary === "session" || boundary === "account"
            ? "new-csrf"
            : "old-csrf",
        lessonId: newId,
      });
      await vi.waitFor(() => expect(app.node.textContent).toContain("4/4"));
    }
    const currentAction = app.action();
    delayed.release(
      '{"schema":"pirate.study-private-history/1","private":"old owner"}',
    );
    await pending;
    expect(create).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(app.action()).toBe(currentAction);
    if (boundary !== "dispose") expect(app.node.textContent).toContain("4/4");
    expect(api.mutations()).toEqual([]);
  });

class MemorySocket implements KaraokeOperatorSocket {
  listeners = new Map<string, ((event: never) => void)[]>();
  send = vi.fn();
  close() {
    this.emit("close", { code: 1000 });
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown) {
    this.listeners.get(type)?.forEach((listener) => listener(event as never));
  }
  ready() {
    this.emit("message", {
      data: JSON.stringify({
        type: "ready",
        attemptId: "original-attempt",
        resumed: false,
        audioSequence: 0,
      }),
    });
  }
}
function karaoke(api: ReturnType<typeof http>) {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const context = Object.assign(new EventTarget(), {
    state: "running",
    destination: {},
    resume: async () => {},
    close: async () => {},
    createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
  });
  let graph!: KaraokePlaybackGraph;
  const sockets: MemorySocket[] = [];
  const engine = {
    start: vi.fn(async () => {
      graph.acquire();
    }),
    activate: vi.fn(async (stamp?: number) => stamp ?? 1000),
    captureClockMs: () => 1000,
    deactivateAndFlush: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  let capture!: UseKaraokeCaptureResult, controller!: KaraokeCaptureController;
  let actions: Actions | null = null;
  const createCapture = (options: UseKaraokeCaptureOptions) =>
    (capture = useKaraokeCapture(
      {
        get enabled() {
          return options.enabled;
        },
        get ticketId() {
          return options.ticketId;
        },
        onMessage: options.onMessage,
        openSocket: () => {
          const socket = new MemorySocket();
          sockets.push(socket);
          return socket;
        },
      },
      {
        createPlaybackGraph: (onInterrupted) =>
          (graph = new KaraokePlaybackGraph(
            () => context as unknown as AudioContext,
            onInterrupted,
          )),
        createController: (options) => {
          controller = createKaraokeCaptureController({
            ...options,
            createCaptureEngine: () => engine,
          });
          vi.spyOn(controller, "dispose");
          vi.spyOn(controller, "abort");
          return controller;
        },
      },
    ));
  const [scope, replace] = createSignal({ account: walletA, csrf: "old-csrf" });
  const node = host();
  const dispose = render(
    () => (
      <KaraokePage
        {...scope()}
        postId={postId}
        title="Fixture song"
        serviceMode="internal"
        signInPermission
        createCapture={createCapture}
        onExit={() => {}}
        onLearningActions={(value) => {
          actions = value;
        }}
      />
    ),
    node,
  );
  cleanup.push(dispose);
  return {
    node,
    dispose,
    replace,
    engine,
    sockets,
    action: () => actions,
    capture: () => capture,
    controller: () => controller,
    async result() {
      await vi.waitFor(() =>
        expect(capture.readyFor("original-ticket")).toBe(true),
      );
      capture.controls.abort("fixture_connection_lost");
      api.finished();
      await press(node, "Start karaoke");
      await vi.waitFor(() => expect(node.textContent).toContain("Great work!"));
      expect(node.textContent).toContain("Publication status: pending.");
      expect(actions).not.toBeNull();
    },
  };
}
function karaokeMasked(app: ReturnType<typeof karaoke>) {
  expect(app.node.textContent).toContain("Sign in to sing");
  expect(app.node.textContent).not.toContain("Great work!");
  expect(app.node.textContent).not.toContain("Private scored line");
  expect(app.node.querySelector("audio")).toBeNull();
  expect(
    app.node.querySelector('[aria-label="Result publication"]'),
  ).toBeNull();
  expect(app.action()).toBeNull();
}

for (const status of [401, 403])
  test(`actual live Karaoke finish reconciliation ${status} aborts capture and stops its read loop`, async () => {
    const api = http(),
      app = karaoke(api);
    await vi.waitFor(() =>
      expect(app.capture().readyFor("original-ticket")).toBe(true),
    );
    await press(app.node, "Start karaoke");
    await vi.waitFor(() => expect(app.sockets).toHaveLength(1));
    app.sockets[0]!.ready();
    await vi.waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled(),
    );
    const audio = app.node.querySelector("audio")!;
    expect(audio).not.toBeNull();
    audio.currentTime = 2;
    audio.dispatchEvent(new Event("playing"));
    await vi.waitFor(() =>
      expect(app.capture().state()?.status).toBe("active"),
    );
    expect(app.engine.start).toHaveBeenCalledOnce();
    expect(app.engine.activate).toHaveBeenCalledOnce();
    const controller = app.controller();
    const denied = held(status);
    api.fail("attempt", denied.response);
    audio.currentTime = 5;
    audio.dispatchEvent(new Event("ended"));
    await vi.waitFor(() => karaokeMasked(app));
    expect(controller.abort).toHaveBeenCalledWith("karaoke_authority_lost");
    expect(controller.dispose).toHaveBeenCalled();
    expect(app.engine.stop).toHaveBeenCalled();
    expect(denied.reads).not.toHaveBeenCalled();
    const count = api.calls.length;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.calls).toHaveLength(count);
    denied.release();
    expect(
      api.calls.filter((call) => /tickets|enrollment/.test(call.path)),
    ).toEqual([]);
  });
for (const status of [401, 403])
  for (const malformed of ["", "malformed"])
    test(`actual Karaoke retained result ${status}/${malformed || "empty"} headers mask before held body`, async () => {
      const api = http(),
        app = karaoke(api);
      await app.result();
      const denied = held(status);
      api.fail("attempt", denied.response);
      const oldAction = app.action()!;
      await press(app.node, "Check again");
      await vi.waitFor(() => karaokeMasked(app));
      expect(denied.reads).not.toHaveBeenCalled();
      const count = api.calls.length;
      await expect(oldAction.download()).rejects.toThrow(/closed/);
      denied.release(malformed);
      await Promise.resolve();
      karaokeMasked(app);
      expect(api.calls).toHaveLength(count);
      expect(
        api.calls.filter((call) => call.path === "/api/karaoke/tickets"),
      ).toEqual([]);
    });

for (const status of [401, 403])
  test(`Karaoke completed history ${status} clears retained actions after real controller cleanup`, async () => {
    const api = http(),
      app = karaoke(api);
    await vi.waitFor(() =>
      expect(app.capture().readyFor("original-ticket")).toBe(true),
    );
    const controller = app.controller();
    const denied = held(status);
    api.fail("history", denied.response);
    // Load's open take does not export until a canonical completion. Reach the
    // original controller's error->same-ticket readback completion first.
    await app.result();
    expect(controller.dispose).toHaveBeenCalled();
    const action = app.action()!;
    const failure = action.download().catch((error: unknown) => error);
    await vi.waitFor(() => karaokeMasked(app));
    expect(await failure).toMatchObject({ status });
    expect(controller.dispose).toHaveBeenCalled();
    expect(denied.reads).not.toHaveBeenCalled();
    denied.release();
    expect(
      api.calls.filter((call) => /tickets|enrollment/.test(call.path)),
    ).toEqual([]);
  });

test("ordinary Karaoke503 retains the actual result and later explicit status uses the same ticket", async () => {
  const api = http(),
    app = karaoke(api);
  await app.result();
  api.fail("attempt", json({ error: "temporary_outage" }, 503));
  await press(app.node, "Check again");
  await vi.waitFor(() =>
    expect(app.node.textContent).toContain("Your result is still unavailable"),
  );
  expect(app.node.textContent).toContain("Great work!");
  expect(app.action()).not.toBeNull();
  api.clear();
  await press(app.node, "Check again");
  await vi.waitFor(() =>
    expect(app.node.textContent).not.toContain(
      "Your result is still unavailable",
    ),
  );
  expect(app.node.textContent).toContain("Great work!");
  expect(
    api.calls.filter((call) => /tickets|enrollment/.test(call.path)),
  ).toEqual([]);
});

for (const boundary of ["account", "session", "dispose"] as const)
  test(`late Karaoke status after ${boundary} cannot restore old result/actions`, async () => {
    const api = http(),
      app = karaoke(api);
    await app.result();
    const delayed = held(200);
    api.fail("attempt", delayed.response);
    await press(app.node, "Check again");
    await vi.waitFor(() => expect(delayed.reads).toHaveBeenCalledOnce());
    api.clear();
    if (boundary === "dispose") {
      app.dispose();
      cleanup.pop();
    } else {
      if (boundary === "account") api.account(walletB);
      if (boundary === "account" || boundary === "session")
        api.csrf("new-csrf");
      app.replace({
        account: boundary === "account" ? walletB : walletA,
        csrf:
          boundary === "session" || boundary === "account"
            ? "new-csrf"
            : "old-csrf",
      });
      // A visit retains history, but deliberately offers a new take rather
      // than restoring the previous visit's completion projection.
      await vi.waitFor(() =>
        expect(app.node.textContent).not.toContain("Great work!"),
      );
      await vi.waitFor(() => expect(app.action()).not.toBeNull());
    }
    const currentAction = app.action();
    delayed.release(JSON.stringify(finished));
    await vi.waitFor(() => expect(delayed.reads).toHaveBeenCalledOnce());
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(app.node.textContent).not.toContain("Great work!");
    expect(app.action()).toBe(currentAction);
    expect(
      api.calls.filter((call) => /tickets|enrollment/.test(call.path)),
    ).toEqual([]);
  });

// UNRUN successor cases. Append to the prior actual mounted page/controller
// tests without changing their assertions or explicit hardware/socket fixtures.
function holdNextTicketPreflight() {
  const actualFixtureFetch = globalThis.fetch;
  const preflight = held(200);
  let awaitingReadPostflight = false;
  let awaitingTicketPreflight = false;
  let claimed = false;
  let signal: AbortSignal | null = null;
  let aborts = 0;
  const dispatched: {
    path: string;
    body: unknown;
    account: string | null;
    csrf: string | null;
  }[] = [];
  const blocked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = input instanceof Request ? input.url : String(input);
      // Native fetch rejects an already-aborted signal before sending an HTTP
      // request. Keep the delivered session body independently held to exercise
      // the late-body race rather than hiding it with an early body rejection.
      if (init?.signal?.aborted) {
        blocked.push(path);
        throw init.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      if (path === "/api/session") {
        if (awaitingReadPostflight) {
          awaitingReadPostflight = false;
          awaitingTicketPreflight = true;
        } else if (awaitingTicketPreflight && !claimed) {
          awaitingTicketPreflight = false;
          claimed = true;
          signal = init?.signal ?? null;
          signal?.addEventListener(
            "abort",
            () => {
              aborts++;
            },
            { once: true },
          );
          return preflight.response;
        }
      }
      if (!claimed && path === `/api/karaoke/attempt?postId=${postId}`)
        awaitingReadPostflight = true;
      if (path === "/api/karaoke/tickets" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        expect(init.credentials).toBe("same-origin");
        dispatched.push({
          path,
          body: JSON.parse(String(init.body)),
          account: headers.get("x-study-account"),
          csrf: headers.get("x-csrf-token"),
        });
        return json({
          ticket: { body: { ticketId: "next-ticket" } },
          socketUrl: "wss://community.invalid/next",
          proof: "next-proof",
        });
      }
      return actualFixtureFetch(input, init);
    }),
  );
  return {
    preflight,
    dispatched,
    blocked,
    signal: () => signal,
    aborts: () => aborts,
  };
}

for (const status of [401, 403])
  test(`completed Karaoke concurrent ${status} retires a held ticket preflight before endpoint POST`, async () => {
    const api = http(),
      app = karaoke(api);
    await app.result();
    expect(app.node.textContent).toContain("Great work!");
    expect(app.node.textContent).toContain("Publication status: pending.");
    const oldAction = app.action();
    expect(oldAction).not.toBeNull();
    const queued = holdNextTicketPreflight();
    await press(app.node, "Sing again");
    await vi.waitFor(() =>
      expect(queued.preflight.reads).toHaveBeenCalledOnce(),
    );
    expect(queued.dispatched).toEqual([]);
    expect(queued.signal()?.aborted).toBe(false);
    // Starting the next take keeps the original completed projection until
    // its actual ticket is confirmed, so the status action is still available.
    expect(app.node.textContent).toContain("Great work!");
    const denied = held(status);
    api.fail("attempt", denied.response);
    await press(app.node, "Check again");
    await vi.waitFor(() => karaokeMasked(app));
    expect(denied.reads).not.toHaveBeenCalled();
    expect(queued.signal()?.aborted).toBe(true);
    expect(queued.aborts()).toBe(1);
    queued.preflight.release(
      JSON.stringify({ mossAddress: walletA, csrf: "old-csrf" }),
    );
    await vi.waitFor(() =>
      expect(queued.blocked).toContain("/api/karaoke/tickets"),
    );
    expect(queued.dispatched).toEqual([]);
    karaokeMasked(app);
    const requests = api.calls.length;
    await expect(oldAction!.download()).rejects.toThrow(/closed/);
    expect(api.calls).toHaveLength(requests);
    denied.release("malformed late denial body");
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
    karaokeMasked(app);
    expect(queued.dispatched).toEqual([]);
    app.dispose();
    cleanup.pop();
    expect(queued.aborts()).toBe(1);
  });

test("the same held Karaoke preflight without denial dispatches its intended normal ticket POST", async () => {
  const api = http(),
    app = karaoke(api);
  await app.result();
  expect(app.node.textContent).toContain("Great work!");
  const queued = holdNextTicketPreflight();
  await press(app.node, "Sing again");
  await vi.waitFor(() => expect(queued.preflight.reads).toHaveBeenCalledOnce());
  expect(queued.dispatched).toEqual([]);
  queued.preflight.release(
    JSON.stringify({ mossAddress: walletA, csrf: "old-csrf" }),
  );
  await vi.waitFor(() =>
    expect(queued.dispatched).toEqual([
      {
        path: "/api/karaoke/tickets",
        body: { postId },
        account: walletA,
        csrf: "old-csrf",
      },
    ]),
  );
  await vi.waitFor(() =>
    expect(app.capture().readyFor("next-ticket")).toBe(true),
  );
  expect(queued.blocked).toEqual([]);
  expect(queued.signal()?.aborted).toBe(false);
  expect(app.node.textContent).not.toContain("Sign in to sing");
});
