// Built live app in a simulated V4 community: the one sign-in is the
// publication permission, and account settings turn public results off and
// on. Modelled on account-fixture.ts and study-fixture.ts. The wallet SDK is
// replaced by a recorder of each signature request; server cryptography, D1,
// the operator relay and the contract have their own local-chain tests.
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { StudyLesson, StudySong } from "../../../packages/study/lesson.ts";
import {
  readSignInMessageV4,
  signInMessageV4,
} from "../../../packages/protocol/learning-results-v4.ts";

export const origin = "https://study-v4.example";
const learner = `0x${"a4".repeat(20)}`;
const contract = `0x${"4".repeat(40)}`;
const song: StudySong = {
  chainId: 6343,
  postsContract: `0x${"1".repeat(40)}`,
  communityId: `0x${"2".repeat(64)}`,
  postId: `0x${"3".repeat(64)}`,
  lyricRevision: 1,
};
function lesson(): StudyLesson {
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
      line: {
        ...song,
        lineId: `0x${"4".repeat(64)}`,
        lineVersion: 1,
        text: "Hold me close",
        language: "en",
        manifestDigest: `0x${"5".repeat(64)}`,
      },
      presentationNumber: 1,
      takeNumber: 1,
      attempt: null,
    },
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
export const documents: Record<string, string> = {
  "/terms": "Fixture community terms.",
  "/privacy": "Fixture community privacy.",
  "/learning/v4/terms": "Fixture V4 learning terms.",
  "/learning/v4/privacy": "Fixture V4 learning privacy.",
};

export async function serveV4(page: Page) {
  let signedIn = false,
    withdrawn = false,
    recorded = false;
  const signatures: string[] = [];
  const counts = { enrollment: 0, starts: 0, revocations: 0, turnedOn: 0 };
  const lessons = new Map<string, StudyLesson>();
  const manifest = JSON.parse(
    await readFile("dist/live/.vite/manifest.json", "utf8"),
  ) as Record<string, { file: string }>;
  const walletChunk =
    "/" +
    Object.entries(manifest).find(([name]) =>
      name.includes("@megaeth-labs/wallet-sdk"),
    )![1].file;
  const publicResults = () =>
    withdrawn ? "off" : recorded ? "on" : "off";
  // The context, so documents opened in a new tab are served too.
  await page.context().route(`${origin}/**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
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
      const record = (kind, primaryType, message) => fetch("/__fixture/sign", {method:"POST",
        body: JSON.stringify({kind, primaryType, message})});
      export const mega = { async initialise(){},
        async connect(){return {address:"${learner}"}},
        async signMessage(message){await record("message", undefined, message);return {status:"success",signature:"0x5157"}},
        async signData({data}){await record("typed", data.primaryType);return {status:"success",signature:"0x7d"}} };`,
      });
    if (path === "/__fixture/sign") {
      const input = request.postDataJSON();
      // The V4 sign-in is a SIWE text; it is recorded as "SignIn".
      signatures.push(
        input.kind === "typed"
          ? input.primaryType
          : readSignInMessageV4(String(input.message))
            ? "SignIn"
            : input.kind,
      );
      return json({ ok: true });
    }
    if (documents[path])
      return route.fulfill({
        contentType: "text/plain; charset=utf-8",
        body: documents[path],
      });
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        canonicalOrigin: origin,
      });
    if (path === "/api/public/community")
      return json({ name: "V4 Study fixture" });
    if (path === "/api/capabilities")
      return json({
        schema: "pirate.community-capabilities/1",
        signIn: true,
        creatorConnection: false,
        upload: false,
        publication: false,
        learningServiceMode: "internal",
        learningPolicy: {
          version: 4,
          termsUrl: "/learning/v4/terms",
          privacyUrl: "/learning/v4/privacy",
        },
        study: true,
        policyVersion: "fixture",
      });
    if (path === "/api/session")
      return signedIn
        ? json({
            authenticated: true,
            authorId: `0x${"c".repeat(64)}`,
            mossAddress: learner,
            csrf: "csrf-v4",
            creator: null,
            pendingConnection: null,
            publicResults: publicResults(),
            publisher: false,
          })
        : json({ error: "session_required" }, 401);
    if (path === "/api/auth/challenge")
      return json({
        id: "fixture-challenge",
        kind: "sign-in-v4",
        message: signInMessageV4(
          {
            origin,
            chainId: 6343,
            contract: contract as `0x${string}`,
            communityId: song.communityId as `0x${string}`,
            publicationPolicy: `0x${"5".repeat(64)}`,
          },
          {
            learner: learner as `0x${string}`,
            nonce: `0x${"9".repeat(64)}`,
            issuedAt: BigInt(Math.floor(Date.now() / 1000) - 60),
          },
        ),
      });
    if (path === "/api/auth/verify") {
      signedIn = true;
      // The server relays the sign-in unless public results are off.
      if (!withdrawn) recorded = true;
      return json({ authenticated: true, csrf: "csrf-v4" });
    }
    if (path === "/api/logout") {
      signedIn = false;
      return json({ signedOut: true });
    }
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
    if (path.startsWith("/api/karaoke/enrollment")) {
      counts.enrollment++;
      return json({ error: "unexpected_enrollment" }, 500);
    }
    if (path.startsWith("/api/learning/public-results/")) {
      expect(signedIn).toBe(true);
      expect(request.headers()["x-csrf-token"]).toBe("csrf-v4");
      const body = request.postDataJSON() ?? {};
      if (path.endsWith("/off")) {
        if (!body.signature)
          return json({
            target: { chainId: 6343, version: 4, contract },
            domain: {
              name: "Pirate Learning Results",
              version: "4",
              chainId: 6343,
              verifyingContract: contract,
            },
            types: { Revocation: [] },
            primaryType: "Revocation",
            message: { learner, nonce: String(counts.revocations) },
          });
        counts.revocations++;
        withdrawn = true;
        return json({ state: "success", publicResults: "off" });
      }
      counts.turnedOn++;
      withdrawn = false;
      recorded = false;
      return json({ publicResults: "off" });
    }
    if (path.startsWith("/api/study/")) {
      if (!signedIn) return json({ error: "session_required" }, 401);
      if (path === "/api/study/song") return json(song);
      if (path === "/api/study/lessons") {
        if (request.method() === "GET")
          return json([...lessons.values()].at(-1) ?? null);
        if (publicResults() !== "on")
          return json({ error: "study_authorization_required" }, 409);
        counts.starts++;
        const started = lesson();
        lessons.set(started.lessonId, started);
        return json(started);
      }
      const [id, action] = path.slice("/api/study/lessons/".length).split("/");
      const found = lessons.get(id!);
      if (!found) return json({ error: "study_lesson_not_found" }, 404);
      if (action === "abandon") {
        const left: StudyLesson = {
          ...found,
          status: "abandoned",
          current: null,
          completionReason: "left",
          completedAt: Date.now(),
        };
        lessons.set(id!, left);
        return json(left);
      }
      if (action === "publication")
        return json({ state: "bound", receipt: null });
      return json(found);
    }
    if (path.startsWith("/api/"))
      throw Error(`Unexpected V4 fixture route ${path}`);
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
          } as Record<string, string>
        )[extname(file)] ?? "text/html",
      body: await readFile(file),
    });
  });
  return {
    signatures,
    counts,
    url: `${origin}/`,
    studyUrl: `${origin}/?study=${song.postId}`,
    publicResults,
  };
}
