// Built live app with two simulated accounts sharing one browser. The session
// cookie is modelled server-side: it can change account (another tab signing
// in), be cleared (sign-out) or fail once (a temporary session-check outage).
// Lessons are scoped by account and Study routes enforce x-study-account the
// way services/study-community-api.ts does. Server cryptography, D1 and the
// real lesson service have their own tests.
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { StudyLesson, StudySong } from "../../../packages/study/lesson.ts";

export const origin = "https://study-accounts.example";
export const accounts = {
  first: `0x${"a1".repeat(20)}`,
  second: `0x${"b8".repeat(20)}`,
} as const;
type Account = keyof typeof accounts;
const target = { chainId: 6343, version: 3, contract: `0x${"6".repeat(40)}` };
const song: StudySong = {
  chainId: 6343,
  postsContract: `0x${"1".repeat(40)}`,
  communityId: `0x${"2".repeat(64)}`,
  postId: `0x${"3".repeat(64)}`,
  lyricRevision: 1,
};
const line = (text: string, n: number) => ({
  ...song,
  lineId: `0x${String(n).repeat(64)}`,
  lineVersion: 1,
  text,
  language: "en",
  manifestDigest: `0x${"5".repeat(64)}`,
});
function lessonAt(text: string, presentations: number): StudyLesson {
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: crypto.randomUUID(),
    song,
    startedAt: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    completedAt: null,
    status: "active",
    completionReason: null,
    lastAttempt: null,
    current: {
      line: line(text, presentations + 4),
      presentationNumber: presentations + 1,
      takeNumber: 1,
      attempt: null,
    },
    progress: {
      total: 4,
      resolved: presentations,
      mastered: presentations,
      presentations,
      presentationCap: 12,
      firstPassGraded: presentations,
      firstPassCorrect: presentations,
    },
    qualification: "not_evaluated",
  };
}

export async function serveAccounts(page: Page) {
  let cookie: Account | null = null,
    wallet: Account = "first",
    challenge: Account | null = null,
    sessionFailures = 0;
  // The first account already has a lesson in progress on its second line.
  const owned = new Map<string, { owner: Account; lesson: StudyLesson }>();
  const firstLesson = lessonAt("Stay with me", 1);
  const original = structuredClone(firstLesson);
  owned.set(firstLesson.lessonId, { owner: "first", lesson: firstLesson });
  const counts = { starts: 0, abandons: 0, refusedAccount: 0, foreign: 0 };
  const manifest = JSON.parse(
    await readFile("dist/live/.vite/manifest.json", "utf8"),
  ) as Record<string, { file: string }>;
  const walletChunk =
    "/" +
    Object.entries(manifest).find(([name]) =>
      name.includes("@megaeth-labs/wallet-sdk"),
    )![1].file;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === walletChunk)
      return route.fulfill({
        contentType: "application/javascript",
        body: `
      export const mega = { async initialise(){},
        async connect(){return (await fetch("/__fixture/wallet")).json()},
        async signMessage(){return {status:"success",signature:"fixture-sign-in"}},
        async signData(){return {status:"success",signature:"fixture-enrollment"}} };`,
      });
    if (path === "/__fixture/wallet") return json({ address: accounts[wallet] });
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        canonicalOrigin: origin,
      });
    if (path === "/api/public/community")
      return json({ name: "Study account fixture" });
    if (path === "/api/capabilities")
      return json({
        signIn: true,
        creatorConnection: false,
        upload: false,
        publication: false,
        learningServiceMode: "internal",
        study: true,
        policyVersion: "fixture",
      });
    if (path === "/api/session") {
      if (sessionFailures > 0) {
        sessionFailures--;
        return json({ error: "session_unavailable" }, 503);
      }
      return cookie
        ? json({
            authenticated: true,
            authorId: `0x${(cookie === "first" ? "c" : "d").repeat(64)}`,
            mossAddress: accounts[cookie],
            csrf: `csrf-${cookie}`,
            creator: null,
            pendingConnection: null,
          })
        : json({ error: "session_required" }, 401);
    }
    if (path === "/api/auth/challenge") {
      const address = request.postDataJSON().address;
      challenge = (Object.keys(accounts) as Account[]).find(
        (name) => accounts[name] === address,
      )!;
      return json({ id: "fixture-challenge", message: "Fixture sign-in" });
    }
    if (path === "/api/auth/verify") {
      cookie = challenge;
      return json({ authenticated: true });
    }
    if (path === "/api/logout") {
      cookie = null;
      return json({ signedOut: true });
    }
    if (path === "/api/uploads") return json({ uploads: [] });
    if (path === "/api/feed")
      return json({
        posts: [
          {
            manifest: {
              schema: "pirate.community-post/2",
              ...song,
              authorId: `0x${"c".repeat(64)}`,
              title: "Fixture song",
              rating: "general",
              language: "en",
            },
            audioUrl: "/fixture.mp3",
            postUrl: "/posts/fixture",
            lyricsText: "Hold me close",
          },
        ],
      });
    if (path === "/api/karaoke/enrollment") {
      expect(cookie).not.toBeNull();
      return json({ target, active: true, activities: 3 });
    }
    if (path.startsWith("/api/study/")) {
      if (!cookie) return json({ error: "session_required" }, 401);
      // Same order as services/study-community-api.ts: account, then CSRF.
      const expected = request.headers()["x-study-account"];
      if (
        expected !== undefined &&
        expected.toLowerCase() !== accounts[cookie].toLowerCase()
      ) {
        counts.refusedAccount++;
        return json({ error: "study_account_changed" }, 409);
      }
      if (
        request.method() !== "GET" &&
        request.headers()["x-csrf-token"] !== `csrf-${cookie}`
      )
        return json({ error: "csrf_required" }, 403);
      const mine = [...owned.values()].filter((x) => x.owner === cookie);
      if (path === "/api/study/song") return json(song);
      if (path === "/api/study/lessons") {
        if (request.method() === "GET")
          return json(mine.at(-1)?.lesson ?? null);
        counts.starts++;
        const lesson = lessonAt("Hold me close", 0);
        owned.set(lesson.lessonId, { owner: cookie, lesson });
        return json(lesson);
      }
      const [id, action] = path
        .slice("/api/study/lessons/".length)
        .split("/");
      const entry = owned.get(id);
      if (!entry || entry.owner !== cookie) {
        counts.foreign++;
        return json({ error: "study_lesson_not_found" }, 404);
      }
      if (action === "abandon") {
        counts.abandons++;
        entry.lesson = {
          ...entry.lesson,
          status: "abandoned",
          current: null,
          completionReason: "left",
          completedAt: Date.now(),
        };
      }
      if (action === "publication") return json({ state: "bound", receipt: null });
      if (action === "history")
        return json({
          schema: "pirate.study-private-history/1",
          lessonId: id,
          attempts: [],
        });
      return json(entry.lesson);
    }
    if (path.startsWith("/api/"))
      throw Error(`Unexpected account fixture route ${path}`);
    if (path === "/fixture.mp3")
      return route.fulfill({ status: 404, body: "fixture audio is unused" });
    const filename = path.startsWith("/app/assets/")
      ? path.slice(1)
      : "index.html";
    const file = resolve("dist/live", filename);
    expect(file.startsWith(resolve("dist/live") + "/")).toBe(true);
    return route.fulfill({
      contentType:
        (
          {
            ".js": "application/javascript",
            ".css": "text/css",
            ".mp3": "audio/mpeg",
          } as Record<string, string>
        )[extname(file)] ?? "text/html",
      body: await readFile(file),
    });
  });
  return {
    counts,
    firstLesson: original,
    url: `${origin}/?study=${song.postId}`,
    lessonUrl: (id: string) => `${origin}/?study=${song.postId}&lesson=${id}`,
    /** The cookie now belongs to this account, as after another tab signs in. */
    signedInAs(account: Account | null) {
      cookie = account;
    },
    /** The wallet the next "Sign in with MOSS" uses. */
    walletIs(account: Account) {
      wallet = account;
    },
    /** The first account's lesson reached its legacy deadline. */
    expireFirstLesson() {
      const entry = owned.get(firstLesson.lessonId)!;
      entry.lesson = {
        ...entry.lesson,
        expiresAt: entry.lesson.startedAt + 3600000,
        status: "expired",
        completionReason: "deadline",
        completedAt: entry.lesson.startedAt + 3600000,
        current: null,
      };
    },
    failSessionChecks(times: number) {
      sessionFailures = times;
    },
    lessonsOf: (account: Account) =>
      [...owned.values()]
        .filter((x) => x.owner === account)
        .map((x) => x.lesson),
  };
}
