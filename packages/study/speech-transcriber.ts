// Adapted from pinned api-next study-spoken-audio.ts; see source handoff.
export const STUDY_SPEECH_ENDPOINT =
  "https://api.elevenlabs.io/v1/speech-to-text?enable_logging=true";
export interface StudyTranscript {
  text: string;
  language: string | null;
}
export interface StudyTranscriber {
  readonly providerRetention: "stored";
  transcribe(
    audio: Uint8Array,
    contentType: string,
    language: string,
  ): Promise<StudyTranscript>;
}
export class StudySpeechError extends Error {
  readonly code: string;
  readonly outcome: "known_failed" | "unknown";
  constructor(code: string, outcome: "known_failed" | "unknown" = "unknown") {
    super(code);
    this.code = code;
    this.outcome = outcome;
  }
}
export function makeStudyTranscriber(
  apiKey: string,
  transport: typeof fetch = fetch,
  timeoutMs = 20000,
): StudyTranscriber {
  return {
    providerRetention: "stored",
    async transcribe(audio, contentType, language) {
      if (!apiKey || apiKey.trim() !== apiKey)
        throw new StudySpeechError("speech_not_configured", "known_failed");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(audio)], { type: contentType }),
          "answer",
        );
        form.append("model_id", "scribe_v2");
        form.append("tag_audio_events", "false");
        form.append("diarize", "false");
        form.append("timestamps_granularity", "none");
        if (language !== "und")
          form.append("language_code", language.split("-")[0]);
        const response = await transport(STUDY_SPEECH_ENDPOINT, {
          method: "POST",
          headers: { "xi-api-key": apiKey },
          body: form,
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new StudySpeechError(
            response.status === 429
              ? "speech_rate_limited"
              : "speech_unavailable",
            [400, 401, 403, 413, 415, 422, 429].includes(response.status)
              ? "known_failed"
              : "unknown",
          );
        }
        if (Number(response.headers.get("content-length")) > 65536) {
          await response.body?.cancel().catch(() => {});
          throw new StudySpeechError("speech_invalid_response");
        }
        reader = response.body?.getReader();
        if (!reader) throw new StudySpeechError("speech_invalid_response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (controller.signal.aborted)
            throw new StudySpeechError("speech_timeout");
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 65536)
            throw new StudySpeechError("speech_invalid_response");
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        if (
          typeof body.text !== "string" ||
          body.text.length > 4096 ||
          (body.language_code != null &&
            (typeof body.language_code !== "string" ||
              body.language_code.length > 35)) ||
          (body.language_probability != null &&
            (typeof body.language_probability !== "number" ||
              !Number.isFinite(body.language_probability) ||
              body.language_probability < 0 ||
              body.language_probability > 1))
        )
          throw new StudySpeechError("speech_invalid_response");
        return { text: body.text, language: body.language_code ?? null };
      } catch (error) {
        if (controller.signal.aborted)
          throw new StudySpeechError("speech_timeout");
        throw error instanceof StudySpeechError
          ? error
          : new StudySpeechError("speech_unavailable");
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancel);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    },
  };
}
