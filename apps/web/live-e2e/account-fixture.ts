// Built live app with two simulated accounts sharing one browser. The session
// cookie is modelled server-side: it can change account (another tab signing
// in), be cleared (sign-out) or fail once (a temporary session-check outage).
// Lessons are scoped by account and Study routes enforce x-study-account the
// way services/study-community-api.ts does. Server cryptography, D1 and the
// real lesson service have their own tests.
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type {
  LessonState,
  StudyLesson,
  StudySong,
} from "../../../packages/study/lesson.ts";

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
  let historyRequests = 0,
    releaseHistory: (() => void) | undefined;
  let historyWait = Promise.resolve();
  // The first account already has a lesson in progress on its second line.
  const owned = new Map<string, { owner: Account; lesson: StudyLesson }>();
  const firstLesson = lessonAt("Stay with me", 1);
  const original = structuredClone(firstLesson);
  owned.set(firstLesson.lessonId, { owner: "first", lesson: firstLesson });
  const privateIds = {
    first: crypto.randomUUID(),
    second: crypto.randomUUID(),
  };
  const authorIds = {
    first: `0x${"c".repeat(64)}`,
    second: `0x${"d".repeat(64)}`,
  };
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
    if (path === "/__fixture/wallet")
      return json({ address: accounts[wallet] });
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        canonicalOrigin: origin,
        communityId: song.communityId,
        apiBase: "/api",
        protocolVersions: [1],
        defaultLanguage: "en",
        supportedLanguages: ["en"],
        mirrors: [],
      });
    if (path === "/api/public/community")
      return json({ name: "Study account fixture" });
    if (path === "/api/capabilities")
      return json({
        schema: "pirate.community-capabilities/1",
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
            publicResults: "unavailable",
            publisher: false,
          })
        : json({ error: "session_required" }, 401);
    }
    if (path === "/api/profile/owner")
      return cookie
        ? json(
            fixtureOwner(
              song.communityId,
              privateIds[cookie],
              authorIds[cookie],
              `Fixture ${cookie} account`,
            ),
          )
        : json({ error: "session_required" }, 401);
    if (path === "/api/public/authors") {
      const ids =
        new URL(request.url()).searchParams.get("ids")?.split(",") ?? [];
      return json({
        schema: "pirate.community-profile-list/1",
        communityId: song.communityId,
        profiles: Object.entries(authorIds)
          .filter(([, id]) => ids.includes(id))
          .map(([name, id]) =>
            fixtureProfile(song.communityId, id, `Fixture ${name} account`),
          ),
      });
    }
    if (/^\/api\/public\/authors\/[^/]+\/activity$/.test(path))
      return json({ error: "profile_activity_unavailable" }, 503);
    if (path.startsWith("/api/public/authors/")) {
      const entry = Object.entries(authorIds).find(
        ([, id]) => id === path.split("/").at(-1),
      );
      return entry
        ? json(
            fixtureProfile(
              song.communityId,
              entry[1],
              `Fixture ${entry[0]} account`,
            ),
          )
        : json({ error: "profile_not_found" }, 404);
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
      return json({ authenticated: true, csrf: `csrf-${cookie}` });
    }
    if (path === "/api/logout") {
      expect(request.method()).toBe("POST");
      if (!cookie) return json({ error: "session_required" }, 401);
      expect(request.headers()["x-csrf-token"]).toBe(`csrf-${cookie}`);
      cookie = null;
      return json({ signedOut: true });
    }
    if (path === "/api/uploads") return json({ uploads: [] });
    if (path === "/api/feed")
      return json({
        schema: "pirate.community-feed/1",
        communityId: song.communityId,
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
      expect(request.headers()["x-study-account"]).toBe(accounts[cookie!]);
      return json({ target, active: true, activities: 3 });
    }
    if (path.startsWith("/api/study/")) {
      if (!cookie) return json({ error: "session_required" }, 401);
      // Same order as services/study-community-api.ts: account, then CSRF.
      const expected = request.headers()["x-study-account"];
      if (expected?.toLowerCase() !== accounts[cookie].toLowerCase()) {
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
      const [id, action] = path.slice("/api/study/lessons/".length).split("/");
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
      if (action === "publication")
        return json({ state: "bound", receipt: null });
      if (action === "history") {
        historyRequests++;
        const snapshot = historyExport(entry.lesson);
        await historyWait;
        return json(snapshot);
      }
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
    privateIds,
    firstLesson: original,
    url: `${origin}/?study=${song.postId}`,
    lessonUrl: (id: string) => `${origin}/?study=${song.postId}&lesson=${id}`,
    /** The cookie now belongs to this account, as after another tab signs in. */
    signedInAs(account: Account | null) {
      cookie = account;
    },
    /** The wallet the next source Sign in action uses. */
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
    historyRequests: () => historyRequests,
    holdHistory() {
      historyWait = new Promise<void>((resolve) => {
        releaseHistory = resolve;
      });
    },
    releaseHistory() {
      releaseHistory?.();
    },
    lessonsOf: (account: Account) =>
      [...owned.values()]
        .filter((x) => x.owner === account)
        .map((x) => x.lesson),
  };
}

/** Intentional current profile producers, with a genuine private UUID separate
 * from wallet and public author. No SDK replacement is added by these helpers. */
export function fixtureProfile(
  communityId: string,
  authorId: string,
  displayName = "Fixture member",
) {
  return {
    schema: "pirate.community-profile/1",
    communityId,
    authorId,
    revision: 1,
    displayName,
    bio: null,
    avatarRef: null,
    coverRef: null,
  };
}
export function fixtureOwner(
  communityId: string,
  accountId: string,
  authorId: string,
  displayName = "Fixture member",
) {
  return {
    schema: "pirate.community-profile-owner/1",
    communityId,
    accountId,
    profile: fixtureProfile(communityId, authorId, displayName),
    capabilities: { metadata: true, handles: false, publicMedia: false },
  };
}
export function historyExport(lesson: StudyLesson, attempts: unknown[] = []) {
  const lines = Array.from({ length: 4 }, (_, index) => ({
    ...lesson.song,
    lineId: `0x${(index + 4).toString(16).repeat(64)}` as const,
    lineVersion: 1,
    text: lesson.current?.line.text ?? "Hold me close",
    language: "en",
    manifestDigest: `0x${"5".repeat(64)}` as const,
  }));
  // Current LessonState envelope, without importing root runtime/viem into the
  // web-only browser fixture install (same boundary as v4-sign-in-text.ts).
  const state: LessonState = {
    policy: "pirate.study.lesson-queue/1",
    song: lesson.song,
    items: lines.map((line) => ({
      line,
      presentations: 0,
      lastQueueOrdinal: null,
      mastered: false,
      resolved: false,
      firstPassOutcome: null,
    })),
    startedAt: lesson.startedAt,
    expiresAt: lesson.expiresAt,
    completedAt: lesson.completedAt,
    status: lesson.status,
    completionReason: lesson.completionReason,
    terminalAbsences: null,
    presentationCount: Math.max(
      lesson.progress.presentations,
      lesson.progress.firstPassGraded,
    ),
    currentIndex: lesson.current ? Math.min(3, lesson.progress.resolved) : null,
    currentAttemptId: null,
    lastAttemptId: null,
    takeNumber: lesson.current?.takeNumber ?? 1,
  };
  state.status = lesson.status;
  state.expiresAt = lesson.expiresAt;
  state.completedAt = lesson.completedAt;
  state.completionReason = lesson.completionReason;
  state.presentationCount = Math.max(
    lesson.progress.presentations,
    lesson.progress.firstPassGraded,
  );
  state.currentIndex = lesson.current
    ? Math.min(3, lesson.progress.resolved)
    : null;
  state.items.forEach((item, index) => {
    item.presentations = index < lesson.progress.firstPassGraded ? 1 : 0;
    item.resolved = index < lesson.progress.resolved;
    item.mastered = index < lesson.progress.mastered;
    item.firstPassOutcome =
      index < lesson.progress.firstPassGraded
        ? index < lesson.progress.firstPassCorrect
          ? "correct"
          : "incorrect"
        : null;
  });
  const exportedAt = Date.now();
  return {
    schema: "pirate.study-private-history/1",
    activity: "study",
    exportedAt,
    exportAvailableUntil:
      (lesson.completedAt ??
        (lesson.expiresAt === Number.MAX_SAFE_INTEGER
          ? exportedAt
          : lesson.expiresAt)) +
      30 * 86400 * 1000,
    communityId: lesson.song.communityId,
    lesson: { lessonId: lesson.lessonId, revision: 0, state },
    attempts,
    publication: null,
    limitations: [
      "Explicit browser fixture; operator private history semantics have separate actual-server gates.",
    ],
  };
}
export const studyOverlay = (page: Page) => page.locator(".live-study-overlay");
export const studyHeading = (page: Page) =>
  studyOverlay(page).getByRole("heading", { level: 2 });
export async function exitStudy(page: Page) {
  await studyOverlay(page)
    .getByRole("button", { name: "Exit study", exact: true })
    .click();
  await expect(studyOverlay(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("lesson")).toBeNull();
  await expect(page.locator("#app-content")).toBeFocused();
}
export async function openSettings(page: Page) {
  await expect(studyOverlay(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Profile", exact: true })
    .first()
    .click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const owner = await page.evaluate(async () =>
    (await fetch("/api/profile/owner")).json(),
  );
  expect(owner.schema).toBe("pirate.community-profile-owner/1");
  expect(owner.accountId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await expect(
    page
      .getByRole("main")
      .getByText(owner.profile.displayName, { exact: true })
      .first(),
  ).toBeVisible();
}
export async function home(page: Page) {
  await page.getByRole("button", { name: "Go home", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Community documents" }),
  ).toBeVisible();
}
export async function openSong(page: Page) {
  await home(page);
  await page
    .getByRole("link", { name: "Fixture song", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("navigation", { name: "Song activities" }),
  ).toBeVisible();
}
export async function startStudy(page: Page) {
  await openSong(page);
  await page
    .getByRole("navigation", { name: "Song activities" })
    .getByRole("link", { name: "Study", exact: true })
    .click();
}
export async function signInCurrent(page: Page) {
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .first()
    .click();
  if (new URL(page.url()).searchParams.has("study")) {
    await expect(studyOverlay(page)).toBeVisible();
    await expect(
      studyOverlay(page).getByRole("button", { name: "Sign in", exact: true }),
    ).toHaveCount(0);
  } else {
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Signed in. Choose a song to study or sing." }),
    ).toHaveText("Signed in. Choose a song to study or sing.");
  }
}
export async function expectAccount(
  page: Page,
  wallet: string,
  privateId?: string,
) {
  const value = await page.evaluate(async () => ({
    session: await (await fetch("/api/session")).json(),
    owner: await (await fetch("/api/profile/owner")).json(),
  }));
  expect(value.session.mossAddress).toBe(wallet);
  expect(value.owner.profile.authorId).toBe(value.session.authorId);
  expect(value.owner.accountId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  if (privateId) expect(value.owner.accountId).toBe(privateId);
  if (new URL(page.url()).hash === "#/settings")
    await expect(
      page
        .getByRole("main")
        .getByText(value.owner.profile.displayName, { exact: true })
        .first(),
    ).toBeVisible();
}
