// Actual source pages and HTTP adapters. Responses below are local simulations.
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import {
  LearningPageMount,
  type LearningPageRoute,
} from "../src/live/learning-pages.tsx";
import { createLearningActionOwner } from "../src/live/learning-action-owner.ts";
import { createSavedKaraokeHistory } from "../src/karaoke/saved-history.ts";
import type { StudyLesson } from "../../../packages/study/lesson.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function lesson(id: string, postId = "post-a"): StudyLesson {
  const song = {
    chainId: 6343,
    postsContract: `0x${"1".repeat(40)}`,
    communityId: `0x${"2".repeat(64)}`,
    postId,
    lyricRevision: 1,
  };
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: id,
    song,
    startedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    completedAt: null,
    status: "active",
    completionReason: null,
    current: {
      line: {
        ...song,
        lineId: "line-a",
        lineVersion: 1,
        text: "I am going home",
        language: "en",
        manifestDigest: "fixture-digest",
      },
      presentationNumber: 1,
      takeNumber: 1,
      attempt: null,
    },
    lastAttempt: null,
    progress: {
      total: 4,
      resolved: 0,
      mastered: 0,
      presentations: 0,
      presentationCap: 12,
      firstPassGraded: 0,
      firstPassCorrect: 0,
    },
    qualification: "not_evaluated",
  };
}
function mount(account: string | null = "account-a") {
  const [scope, setScope] = createSignal({
    communityId: "community-a",
    account,
    csrf: "csrf-a",
    route: {
      kind: "study",
      postId: "post-a",
      title: "Song A",
      lessonId: "lesson-a",
    } as LearningPageRoute | null,
  });
  const actions = createLearningActionOwner(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const opened = vi.fn();
  const dispose = render(
    () => (
      <LearningPageMount
        {...scope()}
        actions={actions}
        wallet={{
          signConsent: async () => {
            throw new Error("Unexpected signing request");
          },
        }}
        signInPermission={true}
        onExit={() => {}}
        onConnect={() => {}}
        onLessonOpened={opened}
      />
    ),
    host,
  );
  disposers.push(dispose);
  return { host, setScope, actions, opened, dispose };
}
function transport() {
  let account = "account-a";
  const requests: { url: URL; init?: RequestInit }[] = [];
  const delayed = new Map<string, (response: Response) => void>();
  const response = (value: unknown) => Response.json(value);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://community.example");
    requests.push({ url, init });
    if (url.pathname === "/api/session")
      return response({ mossAddress: account });
    if (url.pathname === "/api/study/song")
      return response(lesson("", url.searchParams.get("postId")!).song);
    if (url.pathname.startsWith("/api/study/lessons/")) {
      const id = decodeURIComponent(url.pathname.split("/")[4]!);
      if (id.startsWith("held"))
        return new Promise<Response>((resolve) => delayed.set(id, resolve));
      return response(lesson(id));
    }
    if (/^\/api\/public\/posts\/[^/]+\/karaoke$/.test(url.pathname))
      return new Promise(() => {});
    throw new Error(
      `Unexpected fixture request ${init?.method ?? "GET"} ${url.pathname}`,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    requests,
    delayed,
    setAccount(value: string) {
      account = value;
    },
  };
}

test("the default source mount resumes the URL lesson and remounts for lesson traversal", async () => {
  const http = transport();
  const view = mount();
  await vi.waitFor(() => expect(view.opened).toHaveBeenCalledWith("lesson-a"));
  await vi.waitFor(() => expect(view.actions.current()).not.toBeNull());
  view.setScope((scope) => ({
    ...scope,
    route: { ...scope.route!, lessonId: "lesson-b" },
  }));
  await vi.waitFor(() => expect(view.opened).toHaveBeenCalledWith("lesson-b"));
  expect(
    http.requests.filter(
      (request) => request.url.pathname === "/api/study/lessons",
    ),
  ).toHaveLength(0);
  expect(
    http.requests.some((request) => request.url.pathname.endsWith("/lesson-b")),
  ).toBe(true);
  expect(view.host.querySelector('[aria-label="Exit study"]')).not.toBeNull();
});

test.each(["lesson", "account", "community", "csrf", "closed"] as const)(
  "a held old lesson cannot publish after %s replacement",
  async (boundary) => {
    const http = transport();
    const view = mount();
    view.setScope((scope) => ({
      ...scope,
      route: { ...scope.route!, lessonId: "held-a" },
    }));
    await vi.waitFor(() => expect(http.delayed.has("held-a")).toBe(true));
    view.setScope((scope) => ({
      ...scope,
      account: boundary === "account" ? "account-b" : scope.account,
      communityId: boundary === "community" ? "community-b" : scope.communityId,
      csrf: boundary === "csrf" ? "csrf-b" : scope.csrf,
      route:
        boundary === "closed"
          ? null
          : { ...scope.route!, lessonId: "lesson-b" },
    }));
    if (boundary === "account") http.setAccount("account-b");
    if (boundary !== "closed")
      await vi.waitFor(() =>
        expect(view.opened).toHaveBeenCalledWith("lesson-b"),
      );
    const count = view.opened.mock.calls.length;
    const current = view.actions.current();
    http.delayed.get("held-a")!(Response.json(lesson("held-a")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.opened).toHaveBeenCalledTimes(count);
    expect(view.actions.current()).toBe(current);
    expect(view.opened).not.toHaveBeenCalledWith("held-a");
  },
);

test("signed-out Study and Karaoke render the actual source authentication states without private HTTP", async () => {
  const http = transport();
  const view = mount(null);
  expect(view.host.textContent).toContain("Sign in to study");
  view.setScope((scope) => ({
    ...scope,
    route: { kind: "sing", postId: "post-a", title: "Song A" },
  }));
  await vi.waitFor(() =>
    expect(view.host.textContent).toContain("Sign in to sing"),
  );
  expect(http.requests).toHaveLength(0);
});

test("switching from Study to the actual Karaoke page clears private Study actions", async () => {
  const http = transport();
  const view = mount();
  await vi.waitFor(() => expect(view.actions.current()).not.toBeNull());
  view.setScope((scope) => ({
    ...scope,
    route: { kind: "sing", postId: "post-a", title: "Song A" },
  }));
  await vi.waitFor(() =>
    expect(
      http.requests.some(
        (request) =>
          request.url.pathname === "/api/public/posts/post-a/karaoke",
      ),
    ).toBe(true),
  );
  expect(view.actions.current()).toBeNull();
  expect(
    http.requests.some(
      (request) => request.url.pathname === "/api/karaoke/tickets",
    ),
  ).toBe(false);
});

test.each(["closed", "account", "community", "generation"] as const)(
  "late canonical Karaoke metadata after %s cannot resurrect saved availability",
  async (boundary) => {
    const communityId = "0x" + "a".repeat(64),
      postId = "0x" + "b".repeat(64),
      wallet = "0x" + "c".repeat(40);
    const [scope, setScope] = createSignal({
      communityId,
      account: wallet,
      csrf: "fixture-session",
      generation: 1,
      route: {
        kind: "sing",
        postId,
        title: "Original song",
      } as LearningPageRoute | null,
    });
    let cookie = wallet,
      released = false,
      postRead = false;
    const pending: ((response: Response) => void)[] = [],
      paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        paths.push(path);
        if (path === "/api/session") {
          if (released) postRead = true;
          return Response.json({ mossAddress: cookie });
        }
        if (path === `/api/public/posts/${postId}/karaoke`)
          return Response.json({
            lines: [
              {
                lineId: "line",
                ordinal: 0,
                text: "Original lyric",
                startMs: 0,
                endMs: 3000,
                words: [],
              },
            ],
            segments: [],
          });
        expect(path).toBe(`/api/karaoke/attempt?postId=${postId}`);
        return new Promise<Response>((resolve) => pending.push(resolve));
      }),
    );
    let history!: ReturnType<typeof createSavedKaraokeHistory>;
    const handedOff = vi.fn();
    const karaokeActions = createLearningActionOwner(() => {});
    function Owner() {
      history = createSavedKaraokeHistory(() => ({
        communityId: scope().communityId,
        wallet: scope().account,
        authorId: "0x" + "d".repeat(64),
        accountId: "11111111-1111-4111-8111-111111111111",
        generation: scope().generation,
        csrf: scope().csrf,
      }));
      return (
        <LearningPageMount
          {...scope()}
          historyGeneration={scope().generation}
          actions={karaokeActions}
          wallet={{
            signConsent: async () => {
              throw new Error("No signing");
            },
          }}
          signInPermission={true}
          onExit={() => {}}
          onConnect={() => {}}
          onLessonOpened={() => {
            throw new Error("No Study");
          }}
          onKaraokeHistory={(ticket, generation) => {
            handedOff(ticket);
            if (ticket) history.remember(ticket, generation);
          }}
        />
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(() => <Owner />, host);
    disposers.push(dispose);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    setScope((value) => ({
      ...value,
      route: boundary === "closed" ? null : value.route,
      account: boundary === "account" ? "0x" + "e".repeat(40) : value.account,
      communityId:
        boundary === "community" ? "0x" + "f".repeat(64) : value.communityId,
      generation: boundary === "generation" ? 2 : value.generation,
    }));
    cookie = scope().account;
    released = true;
    pending[0]!(
      Response.json({
        state: "finished",
        result: {
          body: {
            ticketId: "0x" + "1".repeat(64),
            attemptId: "0x" + "2".repeat(64),
            communityId,
            status: "completed",
            summary: { scoreBps: 8000 },
            lines: [],
            unmeasuredCount: 0,
          },
        },
        record: {
          consented: true,
          consent: null,
          publication: { state: "recorded" },
        },
      }),
    );
    await vi.waitFor(() => expect(postRead).toBe(true));
    expect(handedOff).not.toHaveBeenCalled();
    expect(history.available()).toBe(false);
    expect(paths.some((path) => /tickets|enrollment|history/.test(path))).toBe(
      false,
    );
  },
);
