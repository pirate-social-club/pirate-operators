// UNRUN at exact6c26. Actual StudyClient -> operator adapter -> copied c7
// StudyScreen/route under Solid2 DOM ownership. Only HTTP/capture are fixtures.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { createStudyClient } from "../src/study/client.ts";
import { StudyScreen } from "../src/study/screen.tsx";
import type { StudyLesson } from "../../../packages/study/lesson.ts";
import type { StudyingRecorder } from "../src/study/studying-route-model.ts";

const walletA = `0x${"a".repeat(40)}`,
  walletB = `0x${"b".repeat(40)}`;
const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const changed =
  "You are signed in with a different account. Reload to continue.";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
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
function lesson(id = oldId, completed = false): StudyLesson {
  const song = {
    chainId: 6343,
    postsContract: `0x${"1".repeat(40)}`,
    communityId: `0x${"2".repeat(64)}`,
    postId: `0x${"3".repeat(64)}`,
    lyricRevision: 1,
  };
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: id,
    song,
    startedAt: 100,
    expiresAt: completed ? Number.MAX_SAFE_INTEGER : 3_600_100,
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
            text: id === oldId ? "Old private prompt" : "Current owner prompt",
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
      firstPassCorrect: completed ? 3 : 0,
    },
    qualification: "not_evaluated",
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function fixture(
  mode: "completed" | "expired" | "open" | "reconcile",
  status: 401 | 403 | 503,
  lossAt: "start" | "abandon" = "start",
) {
  const initial = lesson(oldId, mode === "completed"),
    current = lesson(newId);
  const expired: StudyLesson = {
    ...initial,
    status: "expired",
    current: null,
    completedAt: initial.expiresAt,
    completionReason: "deadline",
  };
  let saved = initial,
    retry = false;
  const consumed = deferred<void>();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        body = value;
      },
    }),
    { status },
  );
  const read = response.json.bind(response);
  let beforeRead: () => void = () => {
    throw Error("install actual owner observation before error body read");
  };
  const readBody = vi.spyOn(response, "json").mockImplementation(async () => {
    beforeRead();
    try {
      return await read();
    } finally {
      consumed.resolve();
    }
  });
  const starts: string[] = [],
    requests: { path: string; method: string }[] = [];
  let abandon = 0,
    oldReads = 0,
    attempts = 0,
    uploads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input),
        method = init?.method ?? "GET";
      requests.push({ path, method });
      const expected = path.includes(newId) ? walletB : walletA;
      expect(new Headers(init?.headers).get("x-study-account")).toBe(expected);
      expect(init?.credentials).toBe("same-origin");
      if (path === `/api/study/lessons/${newId}` && method === "GET")
        return json(current);
      if (path === `/api/study/lessons/${oldId}` && method === "GET") {
        oldReads++;
        return mode === "reconcile" && oldReads > 1 ? response : json(saved);
      }
      if (path === `/api/study/lessons/${oldId}/attempts`) {
        attempts++;
        if (mode === "expired") {
          saved = expired;
          return json({ error: "study_lesson_changed" }, 409);
        }
        if (mode === "open") return response;
        return json({
          lesson: initial,
          attempt: {
            schema: "pirate.study.attempt/1",
            kind: "say-it-back",
            attemptId: "original-attempt",
            line: initial.current!.line,
            policy: "script_aware_token_phonetic_v5",
            startedAt: 101,
            completedAt: null,
            state: "ready",
            grade: null,
            failure: null,
            lesson: { lessonId: oldId, presentationNumber: 1, takeNumber: 1 },
            recordingDurationMs: null,
            qualification: "not_evaluated",
          },
        });
      }
      if (path.endsWith("/audio")) {
        uploads++;
        throw new TypeError("original upload outcome unknown");
      }
      if (path === `/api/study/lessons/${oldId}/abandon`) {
        abandon++;
        return lossAt === "abandon" ? response : json(saved);
      }
      if (path === "/api/study/lessons" && method === "POST") {
        starts.push(String(init?.body));
        return retry ? json(current) : response;
      }
      throw Error(`Unexpected request ${method} ${path}`);
    }),
  );
  return {
    initial,
    current,
    response,
    readBody,
    consumed: consumed.promise,
    starts,
    requests,
    client: createStudyClient(
      initial.song,
      () => "fixture-csrf",
      oldId,
      undefined,
      undefined,
      undefined,
      walletA,
    ),
    counts: () => ({ abandon, oldReads, attempts, uploads }),
    observeBeforeRead(check: () => void) {
      beforeRead = check;
    },
    finish(error = "study_account_changed") {
      body.enqueue(
        new TextEncoder().encode(
          JSON.stringify({ error, message: "PRIVATE ERROR DETAIL" }),
        ),
      );
      body.close();
    },
    explicitRetryAllowed() {
      retry = true;
    },
  };
}
function mount(api: ReturnType<typeof fixture>) {
  let privateAction: string | null = null;
  const seen: string[] = [];
  const capture: StudyingRecorder = {
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => ({
      audio: new Blob(["original"], { type: "audio/webm" }),
      contentType: "audio/webm" as const,
      durationMs: 1100,
    })),
  };
  const [scope, setScope] = createSignal({
    client: api.client,
    account: walletA,
    lessonId: oldId,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const release = render(
    () => (
      <StudyScreen
        {...scope()}
        postId={api.initial.song.postId}
        recorder={capture}
        onExit={() => {}}
        onConnect={() => {}}
        onLesson={(value) => {
          seen.push(value.lessonId);
          privateAction = value.lessonId;
        }}
        onLessonCleared={() => {
          privateAction = null;
        }}
      />
    ),
    host,
  );
  let closed = false;
  const dispose = () => {
    if (!closed) {
      closed = true;
      release();
    }
  };
  cleanup.push(dispose);
  return {
    host,
    capture,
    seen,
    dispose,
    action: () => privateAction,
    replaceOwner() {
      setScope({
        account: walletB,
        lessonId: newId,
        client: createStudyClient(
          api.current.song,
          () => "new-csrf",
          newId,
          undefined,
          undefined,
          undefined,
          walletB,
        ),
      });
    },
  };
}
async function press(host: HTMLElement, label: string) {
  const control = await vi.waitFor(() => {
    const found = [...host.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  });
  control.click();
}
async function ready(
  api: ReturnType<typeof fixture>,
  app: ReturnType<typeof mount>,
  mode: "completed" | "expired",
) {
  if (mode === "completed")
    await vi.waitFor(() => expect(app.host.textContent).toContain("3/4"));
  else {
    await press(app.host, "Record");
    await press(app.host, "Stop");
    await vi.waitFor(() =>
      expect(
        app.host.querySelector('[aria-label="Expired Study session"]'),
      ).not.toBeNull(),
    );
  }
  expect(app.action()).toBe(oldId);
}
function masked(app: ReturnType<typeof mount>) {
  expect(app.host.textContent).toContain("Sign in to study");
  expect(app.host.textContent).not.toContain("3/4");
  expect(app.host.textContent).not.toContain("Old private prompt");
  expect(
    app.host.querySelector('[aria-label="Expired Study session"]'),
  ).toBeNull();
  expect(
    [...app.host.querySelectorAll("button")].some((node) =>
      /^(Record|Stop|Study again|Start new lesson)$/.test(
        node.textContent?.trim() ?? "",
      ),
    ),
  ).toBe(false);
  expect(app.action()).toBeNull();
  expect(app.capture.cancel).toHaveBeenCalled();
}

for (const mode of ["completed", "expired"] as const)
  for (const status of [401, 403] as const)
    test(`${mode} restart ${status} headers mask before held JSON; no replacement/replay`, async () => {
      const api = fixture(mode, status),
        app = mount(api);
      api.observeBeforeRead(() => masked(app));
      await ready(api, app, mode);
      expect(api.readBody).not.toHaveBeenCalled();
      await press(
        app.host,
        mode === "completed" ? "Study again" : "Start new lesson",
      );
      await vi.waitFor(() => masked(app));
      expect(api.starts).toHaveLength(1);
      expect(api.counts().abandon).toBe(1);
      expect(app.seen.every((id) => id === oldId)).toBe(true);
      await vi.waitFor(() => expect(api.readBody).toHaveBeenCalledOnce());
      // JSON is STILL pending. Header status alone has already removed authority.
      masked(app);
      expect(api.starts).toHaveLength(1);
      api.finish();
      await api.consumed;
      await vi.waitFor(() => expect(app.host.textContent).toContain(changed));
      masked(app);
      expect(app.host.textContent).not.toContain("PRIVATE ERROR DETAIL");
      expect(api.starts).toHaveLength(1);
    });

for (const mode of ["open", "reconcile"] as const)
  test(`${mode} 403 cannot become provider uncertainty instead of the auth mask`, async () => {
    const api = fixture(mode, 403),
      app = mount(api);
    api.observeBeforeRead(() => masked(app));
    await press(app.host, "Record");
    await press(app.host, "Stop");
    await vi.waitFor(() => masked(app));
    expect(api.counts().attempts).toBe(1);
    expect(api.counts().uploads).toBe(mode === "reconcile" ? 1 : 0);
    expect(api.starts).toEqual([]);
    expect(app.host.textContent).not.toContain("still being checked");
    await vi.waitFor(() => expect(api.readBody).toHaveBeenCalledOnce());
    api.finish();
    await api.consumed;
    masked(app);
  });

test.each(["new-owner", "disposed"] as const)(
  "late denied body after %s cannot reinstall old authority or feedback",
  async (boundary) => {
    const api = fixture("completed", 401),
      app = mount(api);
    api.observeBeforeRead(() => masked(app));
    await ready(api, app, "completed");
    await press(app.host, "Study again");
    await vi.waitFor(() => masked(app));
    await vi.waitFor(() => expect(api.readBody).toHaveBeenCalledOnce());
    if (boundary === "disposed") app.dispose();
    else {
      app.replaceOwner();
      await vi.waitFor(() =>
        expect(app.host.textContent).toContain("Current owner prompt"),
      );
    }
    const callbacks = [...app.seen],
      action = app.action();
    api.finish();
    await api.consumed;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(app.seen).toEqual(callbacks);
    expect(app.action()).toBe(action);
    expect(app.host.textContent).not.toContain(changed);
    expect(app.host.textContent).not.toContain("3/4");
    expect(app.host.textContent).not.toContain("PRIVATE ERROR DETAIL");
    if (boundary === "disposed") {
      expect(app.host.textContent).toBe("");
      expect(action).toBeNull();
    } else expect(action).toBe(newId);
    expect(api.starts).toHaveLength(1);
  },
);

test("ordinary503 body latency keeps the actual completed result and original retry error", async () => {
  const api = fixture("completed", 503),
    app = mount(api);
  api.observeBeforeRead(() => expect(app.host.textContent).toContain("3/4"));
  await ready(api, app, "completed");
  await press(app.host, "Study again");
  await vi.waitFor(() => expect(api.readBody).toHaveBeenCalledOnce());
  expect(app.host.textContent).toContain("3/4");
  expect(app.host.textContent).not.toContain("Sign in to study");
  api.finish("fixture_restart_refused");
  await api.consumed;
  await vi.waitFor(() =>
    expect(app.host.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      "A new lesson could not start. Try again.",
    ),
  );
  expect(app.host.textContent).toContain("3/4");
  expect(api.starts).toHaveLength(1);
});

test.each([401, 403] as const)(
  "abandon %s headers mask the completed view before JSON and never create a replacement",
  async (status) => {
    const api = fixture("completed", status, "abandon"),
      app = mount(api);
    api.observeBeforeRead(() => masked(app));
    await ready(api, app, "completed");
    await press(app.host, "Study again");
    await vi.waitFor(() => masked(app));
    expect(api.starts).toEqual([]);
    expect(api.counts().abandon).toBe(1);
    await vi.waitFor(() => expect(api.readBody).toHaveBeenCalledOnce());
    api.finish();
    await api.consumed;
    masked(app);
    expect(api.starts).toEqual([]);
  },
);

test.each([401, 403] as const)(
  "post-dispatch %s preserves original uncertain start body until explicit retry",
  async (status) => {
    const api = fixture("completed", status);
    await api.client.load();
    await expect(api.client.restart()).rejects.toMatchObject({
      status,
      evidence: {
        stage: "response_headers",
        method: "POST",
        writeOutcome: "unknown",
      },
    });
    expect(api.readBody).not.toHaveBeenCalled();
    expect(api.starts).toHaveLength(1);
    expect(api.counts().abandon).toBe(1);
    api.explicitRetryAllowed(); // controlled HTTP fixture now represents restored permission
    expect((await api.client.restart()).lessonId).toBe(newId);
    expect(api.starts).toHaveLength(2);
    expect(api.starts[1]).toBe(api.starts[0]);
    expect(api.counts().abandon).toBe(1);
    expect(api.readBody).not.toHaveBeenCalled();
    api.finish();
  },
);
