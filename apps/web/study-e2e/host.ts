// Loopback-only acceptance host: real D1/lesson services with a simulated
// authenticated account and speech response. Never deployed as an auth adapter.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Miniflare } from "miniflare";
import { Effect } from "effect";
import { makeStudyService } from "../../../services/study-spoken.ts";
import { makeStudyLessonService } from "../../../services/study-lessons.ts";
import {
  StudyError,
  type StudyLine,
} from "../../../packages/study/contracts.ts";
import {
  newLesson,
  songOf,
  STUDY_LESSON_LIFETIME_MS,
} from "../../../packages/study/lesson.ts";
import { StudyLessonStore } from "../../../packages/study/lesson-store.ts";
import { StudySpeechError } from "../../../packages/study/speech-transcriber.ts";

const origin = "http://127.0.0.1:4177",
  dist = resolve("dist/study");
const runtime = new Miniflare({
  modules: true,
  script:
    "export default {fetch(){return new Response('local Study acceptance')}}",
  compatibilityDate: "2026-08-06",
  d1Databases: ["DB"],
});
const db = await runtime.getD1Database("DB");
const sql = await readFile(
  new URL("../../../packages/study/schema.sql", import.meta.url),
  "utf8",
);
await db.batch(
  sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((s) => s.trim())
    .map((s) => db.prepare(s)),
);
const lines: StudyLine[] = [
  "Hold me close",
  "Stay with me",
  "Walk into the light",
  "Keep the fire bright",
].map((text, i) => ({
  chainId: 6343,
  postsContract: "0x" + "2".repeat(40),
  communityId: "0x" + "a".repeat(64),
  postId: "0x" + "b".repeat(64),
  lineId: "0x" + String(i + 3).repeat(64),
  lyricRevision: 1,
  lineVersion: 1,
  text,
  language: "en",
  manifestDigest: "0x" + "d".repeat(64),
}));
// Two simulated sign-ins. The session cookie is server-side here; `account`
// models whichever account the cookie currently belongs to.
const accounts = {
  first: "0x" + "a1".repeat(20),
  second: "0x" + "b8".repeat(20),
} as const;
const song = songOf(lines[0]),
  communityId = lines[0].communityId;
let account: keyof typeof accounts = "first";
const ownerOf = () => ({ accountId: accounts[account], communityId });
let heard = lines[0].text,
  failure: "known_failed" | "unknown" | null = null,
  lostResponse = false,
  clock = Date.now(),
  calls = 0,
  // V4: starts refused as `study_authorization_pending` before one succeeds.
  authorizationPending = 0,
  starts = 0;
const attempts = makeStudyService({
  db,
  now: () => clock,
  resolveLine: async (selected) => {
    const line = lines.find((line) => line.lineId === selected.lineId);
    if (!line) throw new StudyError("fixture_line_not_found", 404);
    return line;
  },
  transcriber: {
    providerRetention: "stored",
    transcribe: async () => {
      calls++;
      if (failure) throw new StudySpeechError("speech_unavailable", failure);
      return { text: heard, language: "en" };
    },
  },
});
const lessons = makeStudyLessonService({
  db,
  now: () => clock,
  attempts,
  resolveLines: async () => lines,
});
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", origin),
      path = url.pathname;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      ...(req.method !== "GET" && req.method !== "HEAD"
        ? { body: Readable.toWeb(req), duplex: "half" }
        : {}),
    } as RequestInit);
    let response: Response;
    if (path === "/api/study/config")
      response = Response.json({
        song,
        csrf: "local-fixture-csrf",
        account: accounts[account],
      });
    else if (
      path === "/__fixture" &&
      (req.method === "POST" || req.method === "PATCH")
    ) {
      const body = (await request.json()) as {
        heard?: string;
        failure?: boolean | "known_failed" | "unknown";
        lostResponse?: boolean;
        advanceMs?: number;
        account?: keyof typeof accounts;
        legacyLesson?: boolean;
        authorizationPending?: number;
      };
      if (req.method === "POST") {
        await db.prepare("DELETE FROM study_attempts").run();
        await db.prepare("DELETE FROM study_lessons").run();
        calls = 0;
        heard = lines[0].text;
        failure = null;
        lostResponse = false;
        clock = Date.now();
        account = "first";
        authorizationPending = 0;
        starts = 0;
      }
      if (body.authorizationPending !== undefined)
        authorizationPending = body.authorizationPending;
      if (body.account !== undefined) account = body.account;
      let seeded: string | undefined;
      if (body.legacyLesson) {
        // A lesson started before the time limit was removed keeps its hour.
        const state = newLesson(song, lines, clock);
        seeded = (
          await new StudyLessonStore(db).create(
            ownerOf(),
            crypto.randomUUID(),
            { ...state, expiresAt: clock + STUDY_LESSON_LIFETIME_MS },
          )
        ).lesson_id;
      }
      if (body.heard !== undefined) heard = body.heard;
      if (body.failure !== undefined)
        failure =
          body.failure === true
            ? "unknown"
            : body.failure === false
              ? null
              : body.failure;
      if (body.lostResponse !== undefined) lostResponse = body.lostResponse;
      if (body.advanceMs !== undefined) clock += body.advanceMs;
      response = Response.json({ fixture: true, lessonId: seeded });
    } else if (path === "/__fixture")
      response = Response.json({
        calls,
        starts,
        account: accounts[account],
        attempts: await attempts.list(ownerOf()),
        lesson: await lessons.latest(ownerOf(), song),
      });
    else if (path.startsWith("/api/study/lessons")) {
      if (
        req.method !== "GET" &&
        request.headers.get("x-csrf-token") !== "local-fixture-csrf"
      )
        throw new StudyError("fixture_csrf_required", 403);
      // Same rule as services/study-community-api.ts.
      const expected = request.headers.get("x-study-account");
      if (expected !== null && expected !== accounts[account])
        throw new StudyError("study_account_changed", 409);
      const owner = ownerOf();
      if (path === "/api/study/lessons" && req.method === "GET")
        response = Response.json(
          await lessons.latest(
            owner,
            JSON.parse(url.searchParams.get("song") ?? "null"),
          ),
        );
      else if (path === "/api/study/lessons" && req.method === "POST") {
        const body = (await request.json()) as {
          requestId: string;
          song: unknown;
        };
        starts++;
        if (authorizationPending > 0) {
          authorizationPending--;
          throw new StudyError("study_authorization_pending", 409);
        }
        response = Response.json(
          await lessons.start(owner, body.requestId, body.song),
          { status: 201 },
        );
      } else {
        const abandon = path.match(/^\/api\/study\/lessons\/([^/]+)\/abandon$/);
        if (abandon && req.method === "POST") {
          response = Response.json(await lessons.abandon(owner, abandon[1]));
        } else {
          const match = path.match(
            /^\/api\/study\/lessons\/([^/]+)(?:\/attempts(?:\/([^/]+)\/audio)?)?$/,
          );
          if (!match) throw new StudyError("not_found", 404);
          if (req.method === "GET")
            response = Response.json(await lessons.get(owner, match[1]));
          else if (req.method === "POST" && path.endsWith("/attempts")) {
            const body = (await request.json()) as {
              presentationNumber: number;
              takeNumber: number;
            };
            response = Response.json(
              await lessons.openAttempt(
                owner,
                match[1],
                body.presentationNumber,
                body.takeNumber,
              ),
            );
          } else if (req.method === "PUT" && match[2]) {
            response = await Effect.runPromise(
              Effect.match(lessons.submit(owner, match[1], match[2], request), {
                onSuccess: (value) => Response.json(value),
                onFailure: (error) =>
                  Response.json(
                    { error: error.code },
                    { status: error.status },
                  ),
              }),
            );
            if (lostResponse) {
              lostResponse = false;
              response = Response.json(
                { error: "fixture_response_lost" },
                { status: 503 },
              );
            }
          } else throw new StudyError("not_found", 404);
        }
      }
    } else {
      const file = resolve(
        dist,
        path === "/" ? "index.html" : "." + decodeURIComponent(path),
      );
      if (!file.startsWith(dist + "/")) throw new StudyError("not_found", 404);
      response = new Response(await readFile(file), {
        headers: {
          "content-type":
            (
              {
                ".html": "text/html",
                ".js": "application/javascript",
                ".css": "text/css",
                ".mp3": "audio/mpeg",
              } as Record<string, string>
            )[extname(file)] ?? "application/octet-stream",
        },
      });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(error instanceof StudyError ? error.status : 500, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        error: error instanceof StudyError ? error.code : "fixture_error",
      }),
    );
  }
});
server.listen(4177, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.close();
    void runtime.dispose().then(() => process.exit(0));
  });
