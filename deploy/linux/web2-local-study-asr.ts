import { StudySpeechError, type StudyTranscriber } from "../../packages/study/speech-transcriber.ts";
import { noteStudyAsrStage } from "./web2-study-asr-diagnostics.ts";

export interface LocalStudyAsrBindings {
  LOCAL_STUDY_ASR_URL: string;
  LOCAL_STUDY_ASR_AUTH: string;
  LOCAL_STUDY_ASR?: Pick<Fetcher, "fetch">;
}

export function localStudyAsr(env: LocalStudyAsrBindings): StudyTranscriber {
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
      const signal = AbortSignal.timeout(25000);
      const diagnose = env.LOCAL_STUDY_ASR ? noteStudyAsrStage : undefined;
      let response: Response;
      try {
        response = await transport(target.href, {
          method: "POST", body: new Uint8Array(audio), signal,
          headers: { "content-type": contentType, authorization: "Bearer " + env.LOCAL_STUDY_ASR_AUTH },
          redirect: "error",
        });
      } catch (error) {
        diagnose?.(signal.aborted ? "worker_transport_deadline" : "worker_transport_failed");
        throw error;
      }
      if (!response.ok) {
        diagnose?.(response.status === 429 ? "worker_host_busy" :
          response.status === 504 ? "worker_host_deadline" :
          response.status === 403 ? "worker_host_auth_rejected" :
          response.status === 413 ? "worker_host_body_rejected" : "worker_host_rejected");
        await response.body?.cancel().catch(() => {});
        // Only the authenticated local transport's documented pre-effect 429
        // establishes refusal. Loss/timeout after dispatch stays uncertain.
        throw new StudySpeechError("speech_unavailable", response.status === 429 ? "known_failed" : "unknown");
      }
      const reader = response.body?.getReader();
      if (!reader) {
        diagnose?.("worker_body_missing");
        throw new StudySpeechError("speech_invalid_response");
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "", size = 0;
      let stage: "worker_body_read" | "worker_body_limit" | "worker_body_decode" = "worker_body_read";
      try {
        for (;;) {
          stage = "worker_body_read";
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          stage = "worker_body_limit";
          if (size > 65536) throw new StudySpeechError("speech_invalid_response");
          stage = "worker_body_decode";
          text += decoder.decode(next.value, { stream: true });
        }
        stage = "worker_body_decode";
        text += decoder.decode();
      } catch (error) {
        diagnose?.(stage);
        throw error;
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { text: text.trim(), language: "en" };
    },
  };
}
