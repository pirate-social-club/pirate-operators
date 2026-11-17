// Actual application login/lyrics/Study storage and issuer signatures. Only
// provider output and transport loss are doubles; admission runs its real SQL.
import assert from "node:assert/strict";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { digest } from "../packages/protocol/index.ts";
import { CommunityError } from "../packages/community/common.ts";
import { StudyError } from "../packages/study/contracts.ts";
import { studyV5PrivateHttp } from "../services/study-v5-http.ts";
import { studyOperatorRoute } from "../services/study-operator.ts";
import type { StudyEnv } from "../services/study-community.ts";
import type { StudyLesson, StudySong } from "../packages/study/lesson.ts";
import type { StudyTranscript } from "../packages/study/speech-transcriber.ts";

export const path = (id: string) => "/api/study/lessons/" + id;
export async function json<T = unknown>(response: Response): Promise<T> {
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value as T;
}
export function recording(auth: Record<string, string>, suffix = 1): RequestInit {
  const bytes = new Uint8Array(40000); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes[39999] = suffix;
  return { method: "PUT", headers: { ...auth, origin: firstSong.origin, "content-type": "audio/webm", "x-study-duration-ms": "1000" }, body: bytes };
}
export async function privateStudyV5Fixture(port: number) {
  const f = await studyCommunityFixture(port);
  const budget = speechRepairFixture({ communityId: f.config.communityId });
  const profile = { schema: "pirate.study-private-runtime/5", version: 5, chainId: 31337,
    communityId: f.config.communityId, sourceChainId: f.config.chainId, contract: f.v3.toLowerCase(),
    releaseHash: digest({ fixture: "private-only-runtime-selection" }), speechPolicyHash: digest(budget.policy) };
  // This fixture authority address does not assert a deployed V5 public ABI.
  const operatorEnv = { ...f.operatorEnv, ...budget.env, STUDY_PRIVATE_V5_PROFILE: JSON.stringify(profile) };
  let calls = 0, heard = "", loss: string | null = null;
  let behavior = async (): Promise<StudyTranscript> => ({ text: heard, language: "en" });
  const provider = { providerRetention: "stored" as const, transcribe: async () => { calls++; return behavior(); } };
  async function operatorCall(request: Request) {
    try {
      const response = await studyOperatorRoute(request, operatorEnv, f.store, provider);
      if (new URL(request.url).pathname === loss) { loss = null; throw Error("fixture_lost_ack"); }
      return response ?? new Response("not_found", { status: 404 });
    } catch (e) {
      if (e instanceof Error && e.message === "fixture_lost_ack") throw e;
      return Response.json({ error: e instanceof Error ? e.message : "operator_unavailable" }, { status: 400 });
    }
  }
  const env: StudyEnv = { ...f.env, ...budget.env, STUDY_RUNTIME: "private-v5", STUDY_PRIVATE_V5_PROFILE: JSON.stringify(profile),
    KARAOKE_OPERATOR: { fetch: (input: RequestInfo | URL, init?: RequestInit) => operatorCall(new Request(input, init)) } as Fetcher };
  const statementSql = new WeakMap<D1PreparedStatement, string>();
  let beforeBatch: (sql: string[]) => Promise<void> = async () => {};
  const queries: string[] = []; let after: (sql: string) => Promise<void> = async () => {};
  const native = f.db as unknown as D1Database;
  function statement(target: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(target, { get(t, key) {
      if (key === "bind") return (...args: unknown[]) => statement(t.bind(...args), sql);
      if (["first", "all", "raw"].includes(String(key))) return async (...args: unknown[]) => {
        const result = await Reflect.apply(Reflect.get(t, key), t, args); queries.push(sql); await after(sql); return result;
      };
      const value = Reflect.get(t, key); return typeof value === "function" ? value.bind(t) : value;
    } });
    statementSql.set(proxy, sql); return proxy;
  }
  const db = new Proxy(native, { get(t, key) {
    if (key === "prepare") return (sql: string) => statement(t.prepare(sql), sql);
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      const sql = statements.map(s => statementSql.get(s) ?? "");
      await beforeBatch(sql); queries.push(...sql); return t.batch(statements);
    };
    const value = Reflect.get(t, key); return typeof value === "function" ? value.bind(t) : value;
  } });
  async function call(url: string, init: RequestInit = {}) {
    try {
      return (await studyV5PrivateHttp(new Request(firstSong.origin + url, init), {
        env, db, config: f.config, reads: f.ports.publicReads!, now: f.clock,
      }, { communityId: f.config.communityId, origin: firstSong.origin }, new Headers({ "cache-control": "no-store" })))!;
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "study_unavailable" }, {
        status: e instanceof StudyError || e instanceof CommunityError ? e.status : 503,
      });
    }
  }
  const post = (url: string, body: unknown, auth: Record<string, string>) => call(url, { method: "POST",
    headers: { ...auth, origin: firstSong.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  async function song(auth: Record<string, string>) { return json<StudySong>(await call("/api/study/song?postId=" + firstSongFixture.postId, { headers: auth })); }
  return { ...f, env, db: native, queries, policy: budget.policy, resolutions: budget.resolutions, operatorCall,
    call, post, get: (url: string, auth: Record<string, string>) => call(url, { headers: auth }), song,
    async start(auth: Record<string, string>, requestId = crypto.randomUUID(), selected?: StudySong) {
      const selectedSong = selected ?? await song(auth); const lesson = await json<StudyLesson>(await post("/api/study/lessons", { requestId, song: selectedSong }, auth)); return { song: selectedSong, lesson, requestId };
    },
    async lessonRow(id: string) { const row = await native.prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?").bind(id).first<{ state_json: string }>(); assert.ok(row); return { state: JSON.parse(row.state_json) }; },
    heard: (text: string) => { heard = text; }, calls: () => calls,
    behavior: (next: typeof behavior) => { behavior = next; }, lose: (p: string) => { loss = p; }, afterRead: (next: typeof after) => { after = next; }, beforeBatch: (next: typeof beforeBatch) => { beforeBatch = next; },
    async dispose() { budget.close(); await f.dispose(); },
  };
}
