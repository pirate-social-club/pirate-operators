import { DurableObject } from "cloudflare:workers";
import { SpeechBudget } from "../../services/speech-budget.ts";
import { Store } from "../../services/operator-store.ts";
import { expireStudySpeech } from "../../services/study-operator.ts";
import { studyPrivateV5OperatorRoute } from "../../services/study-v5-operator.ts";
import type { Env } from "../../services/runtime.ts";
import { StudySpeechError, type StudyTranscriber } from "../../packages/study/speech-transcriber.ts";

export { SpeechBudget };
interface StudyEnv extends Env {
  PRIVATE_STUDY_STATE: DurableObjectNamespace<PrivateStudyState>;
  STUDY_PRIVATE_V5_PROFILE: string;
  LOCAL_STUDY_ASR_URL: string;
  LOCAL_STUDY_ASR_AUTH: string;
  LOCAL_STUDY_ASR?: Fetcher;
  PRIVATE_KARAOKE?: Fetcher;
}

function localAsr(env: StudyEnv): StudyTranscriber {
  return {
    providerRetention: "stored",
    async transcribe(audio, contentType, language) {
      if (language.split("-")[0] !== "en")
        throw new StudySpeechError("speech_language_unavailable", "known_failed");
      const target = new URL(env.LOCAL_STUDY_ASR_URL);
      if (target.protocol !== "https:" || !target.hostname.endsWith(".test") ||
          target.pathname !== "/transcribe" || target.search || target.hash ||
          target.username || target.password || !/^[A-Za-z0-9_-]{43}$/.test(env.LOCAL_STUDY_ASR_AUTH))
        throw new StudySpeechError("speech_not_configured", "known_failed");
      const transport = env.LOCAL_STUDY_ASR ? env.LOCAL_STUDY_ASR.fetch.bind(env.LOCAL_STUDY_ASR) : fetch;
      const response = await transport(target.href, {
        method: "POST", body: new Uint8Array(audio), signal: AbortSignal.timeout(25000),
        headers: { "content-type": contentType, authorization: "Bearer " + env.LOCAL_STUDY_ASR_AUTH },
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // Only the authenticated local transport's documented pre-effect 429
        // establishes refusal. Loss/timeout after dispatch stays uncertain.
        throw new StudySpeechError("speech_unavailable", response.status === 429 ? "known_failed" : "unknown");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new StudySpeechError("speech_invalid_response");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "", size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65536) throw new StudySpeechError("speech_invalid_response");
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { text: text.trim(), language: "en" };
    },
  };
}

/** This service is mounted by workerd as a private service binding. The
 * V5 route still checks the exact issuer, request hash and retained binding. */
export class PrivateStudyState extends DurableObject<StudyEnv> {
  private readonly store: Store;
  constructor(ctx: DurableObjectState, env: StudyEnv) {
    super(ctx, env);
    this.store = new Store(ctx.storage, undefined, true);
  }
  async fetch(request: Request) {
    try {
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 60000);
      return await studyPrivateV5OperatorRoute(request, this.env, this.store, localAsr(this.env)) ??
        new Response(null, { status: 404 });
    } catch {
      return Response.json({ error: "private_study_operator_unavailable" }, { status: 503 });
    }
  }
  async alarm() {
    expireStudySpeech(this.store);
    if (this.store.rangeExists("studySpeech:") || this.store.rangeExists("studyV5PrivateBinding:"))
      await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}

const karaokePaths = new Set(["/quote", "/prepare", "/attempt-start", "/result", "/record", "/history"]);
const paths = new Set(["/study/v5/private/bind", "/study/v5/private/speech", "/study/v5/private/speech/status"]);
export default {
  async fetch(request: Request, env: StudyEnv) {
    const url = new URL(request.url);
    if (env.PRIVATE_KARAOKE && request.method === "POST" && url.origin === "http://service" &&
        !url.search && karaokePaths.has(url.pathname)) return env.PRIVATE_KARAOKE.fetch(request);
    if (request.method !== "POST" || url.search || !paths.has(url.pathname))
      return new Response(null, { status: 404 });
    return env.PRIVATE_STUDY_STATE.getByName(env.COMMUNITY_ID).fetch(request);
  },
};
