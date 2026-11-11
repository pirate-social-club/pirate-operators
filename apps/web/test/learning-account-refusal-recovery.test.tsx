// UNRUN proposal. Actual copied c7 StudyScreen/route/controller and decentralized
// StudyClient over a deferred in-memory HTTP fixture; no server/device claim.
import { render, type JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { createStudyClient } from "../src/study/client.ts";
import { StudyScreen } from "../src/study/screen.tsx";
import type { StudyLesson } from "../../../packages/study/lesson.ts";
import type { StudyingRecorder } from "../src/study/studying-route-model.ts";

const walletA = `0x${"a".repeat(40)}`;
const walletB = `0x${"b".repeat(40)}`;
const lessonA = "11111111-1111-4111-8111-111111111111";
const lessonB = "22222222-2222-4222-8222-222222222222";
const changed =
  "You are signed in with a different account. Reload to continue.";
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
function lesson(id = lessonA, completed = false): StudyLesson {
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
            text:
              id === lessonA
                ? "First account private line"
                : "Current account line",
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
function mount(ui: () => JSX.Element) {
  const host = document.createElement("div");
  document.body.append(host);
  const cleanup = render(ui, host);
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      cleanup();
    }
  };
  disposers.push(dispose);
  return { host, dispose };
}
async function press(host: HTMLElement, text: string) {
  const button = await vi.waitFor(() => {
    const value = [...host.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(value).toBeDefined();
    return value!;
  });
  button.click();
}
function recorder(): StudyingRecorder {
  return {
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => ({
      audio: new Blob(["original audio"], { type: "audio/webm" }),
      contentType: "audio/webm" as const,
      durationMs: 1100,
    })),
  };
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("expected-account refusal masks private actions and retains only the fixed reason until a fresh owner", async () => {
  const first = lesson(),
    second = lesson(lessonB);
  const original = JSON.stringify(first);
  let cookieWallet = walletA,
    opens = 0;
  const requests: { path: string; method: string; account: string | null }[] =
    [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input),
        method = init?.method ?? "GET";
      const account = new Headers(init?.headers).get("x-study-account");
      requests.push({ path, method, account });
      if (account !== cookieWallet) {
        expect(path).toBe(`/api/study/lessons/${lessonA}/attempts`);
        opens++;
        return response({ error: "study_account_changed" }, 401);
      }
      if (path === `/api/study/lessons/${lessonA}`) return response(first);
      if (path === `/api/study/lessons/${lessonB}`) return response(second);
      throw new Error(`Unexpected request ${method} ${path}`);
    },
  );
  vi.stubGlobal("fetch", transport);
  const opened: string[] = [],
    seen: string[] = [];
  let privateDownloadOwner: string | null = null;
  const makeClient = (value: StudyLesson, wallet: string) =>
    createStudyClient(
      value.song,
      () => "fixture-csrf",
      value.lessonId,
      (id) => opened.push(id),
      undefined,
      undefined,
      wallet,
    );
  const [scope, setScope] = createSignal({
    account: walletA,
    lessonId: lessonA,
    client: makeClient(first, walletA),
  });
  const capture = recorder();
  const { host } = mount(() => (
    <StudyScreen
      {...scope()}
      postId={first.song.postId}
      recorder={capture}
      onExit={() => {}}
      onConnect={() => {}}
      onLesson={(value) => {
        seen.push(value.lessonId);
        privateDownloadOwner = value.lessonId;
      }}
      onLessonCleared={() => {
        privateDownloadOwner = null;
      }}
    />
  ));
  await press(host, "Record");
  expect(privateDownloadOwner).toBe(lessonA);
  cookieWallet = walletB;
  await press(host, "Stop");
  await vi.waitFor(() => expect(host.textContent).toContain(changed));
  expect(host.textContent).not.toContain("First account private line");
  expect(
    [...host.querySelectorAll("button")].some((node) =>
      /^(Record|Stop)$/.test(node.textContent?.trim() ?? ""),
    ),
  ).toBe(false);
  expect(privateDownloadOwner).toBeNull();
  expect(capture.cancel).toHaveBeenCalled();
  expect(opens).toBe(1);
  expect(requests.filter((request) => request.method !== "GET")).toEqual([
    {
      path: `/api/study/lessons/${lessonA}/attempts`,
      method: "POST",
      account: walletA,
    },
  ]);
  expect(JSON.stringify(first)).toBe(original);
  expect(opened).toEqual([lessonA]);
  expect(seen).toEqual([lessonA]);
  setScope({
    account: walletB,
    lessonId: lessonB,
    client: makeClient(second, walletB),
  });
  await press(host, "Record");
  expect(host.textContent).toContain("Current account line");
  expect(host.textContent).not.toContain(changed);
  expect(privateDownloadOwner).toBe(lessonB);
  expect(seen).toEqual([lessonA, lessonB]);
  expect(JSON.stringify(first)).toBe(original);
  expect(
    requests.filter((request) =>
      /abandon|history|enrollment/.test(request.path),
    ),
  ).toEqual([]);
});

test.each(["session_required", "study_account_changed"])(
  "load-time %s uses the source auth slot with no retained private view",
  async (code) => {
    const value = lesson();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          { error: code, message: "PRIVATE BODY MUST NEVER BE SHOWN" },
          401,
        ),
      ),
    );
    const client = createStudyClient(
      value.song,
      () => "fixture-csrf",
      lessonA,
      undefined,
      undefined,
      undefined,
      walletA,
    );
    const { host } = mount(() => (
      <StudyScreen
        account={walletA}
        postId={value.song.postId}
        client={client}
      />
    ));
    await vi.waitFor(() =>
      expect(host.textContent).toContain("Sign in to study"),
    );
    expect(host.textContent).not.toContain("PRIVATE BODY");
    expect(host.textContent).not.toContain("First account private line");
    expect(host.textContent?.includes(changed)).toBe(
      code === "study_account_changed",
    );
  },
);

test.each(["post", "lesson", "fresh-session-owner", "disposed"] as const)(
  "account refusal reason cannot survive the %s lifetime boundary",
  async (boundary) => {
    const value = lesson();
    let refused = true;
    const transport = vi.fn(async () =>
      refused
        ? response({ error: "study_account_changed" }, 401)
        : response(value),
    );
    vi.stubGlobal("fetch", transport);
    const makeClient = () =>
      createStudyClient(
        value.song,
        () => "fixture-csrf",
        value.lessonId,
        undefined,
        undefined,
        undefined,
        walletA,
      );
    const [scope, setScope] = createSignal({
      client: makeClient(),
      account: walletA,
      postId: value.song.postId,
      lessonId: value.lessonId,
    });
    const { host, dispose } = mount(() => (
      <StudyScreen {...scope()} recorder={recorder()} />
    ));
    await vi.waitFor(() => expect(host.textContent).toContain(changed));
    if (boundary === "disposed") {
      const requests = transport.mock.calls.length;
      dispose();
      expect(host.textContent).toBe("");
      expect(transport).toHaveBeenCalledTimes(requests);
      return;
    }
    refused = false;
    if (boundary === "post") {
      value.song.postId = `0x${"6".repeat(64)}`;
      value.current!.line.postId = value.song.postId;
    }
    if (boundary === "lesson") value.lessonId = lessonB;
    // The real shell replaces the page owner on session generation changes;
    // this exercises that new client/owner, without substituting an auth flag.
    setScope({
      client: makeClient(),
      account: walletA,
      postId: value.song.postId,
      lessonId: value.lessonId,
    });
    await press(host, "Record");
    expect(host.textContent).not.toContain(changed);
    expect(host.textContent).toContain("First account private line");
  },
);

test("deferred 503 restart keeps the original 3/4 and retries only explicitly with the same start identity", async () => {
  const completed = lesson(lessonA, true),
    replacement = lesson(lessonB);
  const original = JSON.stringify(completed),
    pending = deferred<Response>();
  const starts: string[] = [],
    opened: string[] = [],
    seen: string[] = [];
  let abandons = 0,
    enrollmentRequests = 0,
    attemptRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input),
        method = init?.method ?? "GET";
      expect(new Headers(init?.headers).get("x-study-account")).toBe(walletA);
      if (path.includes("enrollment")) enrollmentRequests++;
      if (path === `/api/study/lessons/${lessonB}/attempts`) {
        attemptRequests++;
        // A real structured refusal at the new attempt endpoint; the positive
        // witness is reaching this endpoint rather than an obsolete local hold.
        return response({ error: "study_speech_retry_later" }, 429);
      }
      if (method === "GET" && path === `/api/study/lessons/${lessonB}`)
        return response(replacement);
      if (method === "GET" && path === `/api/study/lessons/${lessonA}`)
        return response(completed);
      if (path === `/api/study/lessons/${lessonA}/abandon`) {
        abandons++;
        return response(completed);
      }
      if (path === "/api/study/lessons" && method === "POST") {
        starts.push(String(init?.body));
        return starts.length === 1 ? pending.promise : response(replacement);
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }),
  );
  const client = createStudyClient(
    completed.song,
    () => "fixture-csrf",
    lessonA,
    (id) => opened.push(id),
    undefined,
    undefined,
    walletA,
  );
  const { host } = mount(() => (
    <StudyScreen
      client={client}
      account={walletA}
      postId={completed.song.postId}
      recorder={recorder()}
      onExit={() => {}}
      onLesson={(value) => seen.push(value.lessonId)}
    />
  ));
  await vi.waitFor(() => expect(host.textContent).toContain("3/4"));
  await press(host, "Study again");
  await vi.waitFor(() => expect(starts).toHaveLength(1));
  expect(host.textContent).toContain("3/4");
  await press(host, "Study again"); // pending duplicate gesture never replays
  expect(starts).toHaveLength(1);
  pending.resolve(response({ error: "fixture_restart_refused" }, 503));
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      "A new lesson could not start. Try again.",
    ),
  );
  expect(host.textContent).toContain("3/4");
  expect(host.textContent).not.toContain("Loading Study");
  expect(host.textContent).not.toContain("Study unavailable");
  expect(opened).toEqual([lessonA]);
  expect(seen).toEqual([lessonA]);
  expect(starts).toHaveLength(1);
  expect([abandons, enrollmentRequests, attemptRequests]).toEqual([1, 0, 0]);
  expect(JSON.stringify(completed)).toBe(original);
  await press(host, "Study again");
  await press(host, "Record");
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(opened).toEqual([lessonA, lessonB]);
  expect(seen).toEqual([lessonA, lessonB]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("3/4");
  expect([abandons, enrollmentRequests, attemptRequests]).toEqual([1, 0, 0]);
  expect(JSON.stringify(completed)).toBe(original);
  await press(host, "Stop");
  await vi.waitFor(() => expect(attemptRequests).toBe(1));
  expect(starts).toHaveLength(2);
  expect(abandons).toBe(1);
  expect(enrollmentRequests).toBe(0);
  expect(JSON.stringify(completed)).toBe(original);
});
