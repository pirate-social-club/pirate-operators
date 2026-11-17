import { DurableObject } from "cloudflare:workers";
import { SpeechBudget } from "../../services/speech-budget.ts";
import { Store } from "../../services/operator-store.ts";
import { expireStudySpeech } from "../../services/study-operator.ts";
import { studyPrivateV5OperatorRoute } from "../../services/study-v5-operator.ts";
import type { Env } from "../../services/runtime.ts";
import { localStudyAsr, type LocalStudyAsrBindings } from "./web2-local-study-asr.ts";

export { SpeechBudget };
interface StudyEnv extends Env, LocalStudyAsrBindings {
  PRIVATE_STUDY_STATE: DurableObjectNamespace<PrivateStudyState>;
  STUDY_PRIVATE_V5_PROFILE: string;
  PRIVATE_KARAOKE?: Fetcher;
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
      return await studyPrivateV5OperatorRoute(request, this.env, this.store, localStudyAsr(this.env)) ??
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
