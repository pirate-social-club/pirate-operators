// Built live app against explicit HTTP and wallet simulations. Server-side
// cryptography, D1, provider and contract qualification have separate tests.
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { StudyLesson, StudySong } from "../../../packages/study/lesson.ts";

export const origin = "https://study-community.example";
const target = { chainId: 6343, version: 3, contract: `0x${"6".repeat(40)}` };
const song: StudySong = {
  chainId: 6343,
  postsContract: `0x${"1".repeat(40)}`,
  communityId: `0x${"2".repeat(64)}`,
  postId: `0x${"3".repeat(64)}`,
  lyricRevision: 1,
};
function newLesson(): StudyLesson {
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: crypto.randomUUID(),
    song,
    startedAt: Date.now(),
    expiresAt: Date.now() + 3600000,
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
export async function serveStudy(
  page: Page,
  options: {
    anonymous?: boolean;
    available?: boolean;
    loseStart?: boolean;
    delaySignature?: boolean;
    rejectSignatureOnce?: boolean;
    disclosureMismatch?: boolean;
    delayEnrollment?: boolean;
    rewardOffers?: "hang" | "reject";
  } = {},
) {
  let authenticated = !options.anonymous,
    enrolled = false,
    lesson: StudyLesson | null = null,
    published = false,
    loseStart = options.loseStart;
  let historyExpired = false;
  let publicRevision:
    | { revision: number; status: number; confirmed: boolean }
    | undefined;
  const publicationResponses: {
    state: string;
    confirmed: boolean;
    revision?: number;
    status?: number;
  }[] = [];
  const counts = {
    publicationChecks: 0,
    terminalReads: 0,
    starts: 0,
    enrollmentRequests: 0,
    enrollmentSubmissions: 0,
    signatures: 0,
    abandons: 0,
    rewardOfferRequests: 0,
  };
  let releaseSignature: (() => void) | undefined;
  const signatureWait = options.delaySignature
    ? new Promise<void>((resolve) => {
        releaseSignature = resolve;
      })
    : Promise.resolve();
  let releaseEnrollment: (() => void) | undefined;
  const enrollmentWait = options.delayEnrollment
    ? new Promise<void>((resolve) => {
        releaseEnrollment = resolve;
      })
    : Promise.resolve();
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
      export const mega = { async initialise(){}, async connect(){return {address:"0x${"7".repeat(40)}"}},
        async signMessage(){return {status:"success",signature:"fixture-sign-in"}},
        async signData(){const response=await fetch("/__fixture/signature",{method:"POST"});if(!response.ok)throw new Error("Wallet signature cancelled.");document.body.dataset.fixtureSignatureReturned="true";return {status:"success",signature:"fixture-enrollment"}} };`,
      });
    if (path === "/__fixture/signature") {
      counts.signatures++;
      await signatureWait;
      if (options.rejectSignatureOnce && counts.signatures === 1)
        return json({ cancelled: true }, 409);
      return json({ fixture: true });
    }
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        canonicalOrigin: origin,
      });
    if (path === "/api/public/community")
      return json({ name: "Study browser fixture" });
    if (path === "/api/capabilities")
      return json({
        signIn: true,
        creatorConnection: false,
        upload: false,
        publication: false,
        learningServiceMode: "internal",
        study: options.available !== false,
        ...(options.rewardOffers ? { rewards: true } : {}),
        policyVersion: "fixture",
      });
    if (path === "/api/rewards/offers") {
      counts.rewardOfferRequests++;
      // A hung optional request is never fulfilled; Study must not wait for it.
      if (options.rewardOffers === "hang") return new Promise<void>(() => {});
      return json({ error: "reward_offers_unavailable" }, 503);
    }
    if (path === "/api/session")
      return authenticated
        ? json({
            authenticated: true,
            authorId: `0x${"8".repeat(64)}`,
            mossAddress: `0x${"7".repeat(40)}`,
            csrf: "fixture-csrf",
            creator: null,
            pendingConnection: null,
          })
        : json({ error: "session_required" }, 401);
    if (path === "/api/auth/challenge")
      return json({ id: "fixture-challenge", message: "Fixture sign-in" });
    if (path === "/api/auth/verify") {
      authenticated = true;
      return json({ authenticated: true });
    }
    if (path === "/api/uploads") return json({ uploads: [] });
    if (path === "/api/feed")
      return json({
        posts: [
          {
            manifest: {
              schema: "pirate.community-post/2",
              ...song,
              authorId: `0x${"8".repeat(64)}`,
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
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      const body = request.postDataJSON();
      if (body.signature) {
        counts.enrollmentSubmissions++;
        enrolled = true;
        await enrollmentWait;
        return json({ state: "success" });
      }
      expect(body.activity).toBe("study");
      counts.enrollmentRequests++;
      return json(
        enrolled
          ? { target, active: true, activities: 3 }
          : {
              target,
              disclosure: {
                version: 3,
                termsUrl: "/learning/v3/terms",
                privacyUrl: "/learning/v3/privacy",
                publicityPolicy: `0x${(options.disclosureMismatch ? "8" : "9").repeat(64)}`,
              },
              primaryType: "Enrollment",
              types: {},
              domain: {
                chainId: 6343,
                verifyingContract: target.contract,
                version: "3",
              },
              message: {
                activities: "3",
                learner: `0x${"7".repeat(40)}`,
                publicityPolicy: `0x${"9".repeat(64)}`,
              },
            },
      );
    }
    if (path === "/api/study/song") return json(song);
    if (path === "/api/study/lessons") {
      if (request.method() === "GET") return json(lesson);
      expect(enrolled).toBe(true);
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      counts.starts++;
      lesson = newLesson();
      if (loseStart) {
        loseStart = false;
        return route.abort("failed");
      }
      return json(lesson);
    }
    if (path.endsWith("/history")) {
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      return historyExpired
        ? json({ error: "study_history_expired" }, 410)
        : json({
            schema: "pirate.study-private-history/1",
            lessonId: lesson?.lessonId,
            attempts: [{ heardTranscript: "private fixture words" }],
          });
    }
    if (path.endsWith("/publication")) {
      counts.publicationChecks++;
      publicationResponses.push({
        state: published ? "published" : "pending",
        confirmed: published && (publicRevision?.confirmed ?? true),
        revision: publicRevision?.revision,
        status: publicRevision?.status,
      });
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      return json({
        state: published ? "published" : "pending",
        receipt: published
          ? {
              confirmed: publicRevision?.confirmed ?? true,
              ...(publicRevision ? { canonicalRevision: publicRevision } : {}),
            }
          : null,
      });
    }
    if (path.endsWith("/abandon")) {
      counts.abandons++;
      // The real lesson service preserves a terminal row on repeated abandon.
      if (lesson?.status === "active")
        lesson = {
          ...lesson,
          status: "abandoned",
          current: null,
          completionReason: "left",
          completedAt: Date.now(),
        };
      return json(lesson);
    }
    if (path.startsWith("/api/study/lessons/")) {
      if (lesson?.status !== "active") counts.terminalReads++;
      return json(lesson);
    }
    if (path === "/api/logout") {
      authenticated = false;
      return json({ signedOut: true });
    }
    if (path.startsWith("/api/"))
      throw Error(`Unexpected Study fixture route ${path}`);
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
    publicationResponses,
    releaseSignature: () => releaseSignature?.(),
    releaseEnrollment: () => releaseEnrollment?.(),
    expireHistory: () => {
      historyExpired = true;
    },
    url: `${origin}/?study=${song.postId}`,
    complete() {
      lesson = {
        ...lesson!,
        status: "completed",
        current: null,
        completionReason: "all_resolved",
        completedAt: Date.now(),
        progress: {
          ...lesson!.progress,
          resolved: 4,
          mastered: 4,
          firstPassGraded: 4,
          firstPassCorrect: 3,
        },
      };
    },
    end(status: "expired" | "abandoned") {
      lesson = {
        ...lesson!,
        status,
        current: null,
        completionReason: status === "expired" ? "deadline" : "left",
        completedAt: Date.now(),
      };
    },
    publish() {
      published = true;
    },
    revise(revision: number, status: number, confirmed = true) {
      published = true;
      publicRevision = { revision, status, confirmed };
    },
  };
}
