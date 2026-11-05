// Loopback-only acceptance host: real D1/service, simulated authenticated session
// and speech response. Never deployed or used as a production auth adapter.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Miniflare } from "miniflare";
import { Effect } from "effect";
import { makeStudyService } from "../../../services/study-spoken.ts";
import {
  StudyError,
  type StudyLine,
} from "../../../packages/study/contracts.ts";
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
const lines: StudyLine[] = ["Hold me close", "Stay with me"].map((text, i) => ({
  chainId: 6343,
  postsContract: `0x${"2".repeat(40)}`,
  communityId: `0x${"a".repeat(64)}`,
  postId: `0x${"b".repeat(64)}`,
  lineId: `0x${String(i + 3).repeat(64)}`,
  lyricRevision: 1,
  lineVersion: 1,
  text,
  language: "en",
  manifestDigest: `0x${"d".repeat(64)}`,
}));
const owner = {
  accountId: "fixture-learner",
  communityId: lines[0].communityId,
};
let heard = "Hold me close",
  failure = false,
  lostResponse = false,
  calls = 0;
const service = makeStudyService({
  db,
  resolveLine: async (selected) => {
    const line = lines.find((line) => line.lineId === selected.lineId);
    if (!line) throw new StudyError("fixture_line_not_found", 404);
    return line;
  },
  transcriber: {
    providerRetention: "stored",
    transcribe: async () => {
      calls++;
      if (failure) throw new StudySpeechError("speech_unavailable");
      return { text: heard, language: "en" };
    },
  },
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
    if (path === "/api/study/lesson")
      response = Response.json({ lines, csrf: "local-fixture-csrf" });
    else if (path === "/__fixture" && req.method === "POST") {
      const body = (await request.json()) as {
        heard?: string;
        failure?: boolean;
        lostResponse?: boolean;
      };
      heard = body.heard ?? "Hold me close";
      failure = body.failure === true;
      lostResponse = body.lostResponse === true;
      await db.prepare("DELETE FROM study_attempts").run();
      calls = 0;
      response = Response.json({ fixture: true });
    } else if (path === "/__fixture")
      response = Response.json({ calls, attempts: await service.list(owner) });
    else if (path.startsWith("/api/study/attempts")) {
      if (
        req.method !== "GET" &&
        request.headers.get("x-csrf-token") !== "local-fixture-csrf"
      )
        throw new StudyError("fixture_csrf_required", 403);
      if (path === "/api/study/attempts" && req.method === "GET")
        response = Response.json(
          await service.list(
            owner,
            url.searchParams.has("selection")
              ? JSON.parse(url.searchParams.get("selection")!)
              : undefined,
          ),
        );
      else if (path === "/api/study/attempts" && req.method === "POST") {
        const body = (await request.json()) as {
          requestId: string;
          selection: unknown;
        };
        response = Response.json(
          await service.open(owner, body.requestId, body.selection),
          { status: 201 },
        );
      } else {
        const match = path.match(/^\/api\/study\/attempts\/([^/]+)\/audio$/);
        if (!match || req.method !== "PUT")
          throw new StudyError("not_found", 404);
        response = await Effect.runPromise(
          Effect.match(service.submit(owner, match[1], request), {
            onSuccess: (result) => Response.json(result),
            onFailure: (error) =>
              Response.json({ error: error.code }, { status: error.status }),
          }),
        );
        if (lostResponse) {
          lostResponse = false;
          // Replace the committed result with a gateway failure. Browsers may
          // transparently retry a TCP-reset PUT before exposing it to the UI.
          response = Response.json(
            { error: "fixture_response_lost" },
            { status: 503 },
          );
        }
      }
    } else {
      const file = resolve(
        dist,
        path === "/" ? "index.html" : "." + decodeURIComponent(path),
      );
      if (!file.startsWith(dist + "/")) throw new StudyError("not_found", 404);
      const content = await readFile(file);
      response = new Response(content, {
        headers: {
          "content-type":
            (
              {
                ".html": "text/html",
                ".js": "application/javascript",
                ".css": "text/css",
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
