import { sha256, type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import type { KaraokeLocalFailure, KaraokeStreamingSttAdapter } from "../packages/karaoke/stt-adapter.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";

const INPUT_BYTES = 32_000 * 30;
const OUTPUT_BYTES = 65_536;
type Span = { startMs: number; endMs: number; songStartMs: number; songEndMs: number };
type Start = Parameters<KaraokeStreamingSttAdapter["start"]>[0];

async function boundedJson(response: Response) {
  check(response.ok && response.body, "karaoke_local_recognition_unavailable");
  const reader = response.body.getReader();
  const text = new TextDecoder("utf-8", { fatal: true });
  let size = 0, json = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= OUTPUT_BYTES, "karaoke_local_recognition_overflow");
      json += text.decode(part.value, { stream: true });
    }
    return JSON.parse(json + text.decode()) as Record<string, unknown>;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** PCM and all timestamps are from the capture and recognizer. No lyric text
 * is sent to the recognizer or accepted as a replacement for measurement. */
export function localKaraokeAdapter(port: Fetcher, modelSha256: Hex): KaraokeStreamingSttAdapter {
  let input: Start | null = null;
  let generation: string | null = null;
  let sequence = 0;
  let chunks: ArrayBuffer[] = [], spans: Span[] = [], bytes = 0;
  let active: AbortController | null = null;

  const discardPendingOnSeek = () => {
    active?.abort();
    active = null;
    chunks = [];
    spans = [];
    bytes = 0;
  };

  return {
    get streamGeneration() { return generation; },
    async start(value) {
      check(!input, "karaoke_local_stream_started");
      input = value;
      sequence = value.initialSequence;
      generation = crypto.randomUUID();
    },
    async sendPcm16(frame) {
      check(input && frame.sampleRate === 16000 && frame.pcm16.byteLength > 0 &&
        frame.pcm16.byteLength % 2 === 0 && bytes + frame.pcm16.byteLength <= INPUT_BYTES,
        "karaoke_local_pcm_invalid");
      const prior = spans.at(-1);
      if (prior) check(frame.songStartMs >= prior.songEndMs - 25,
        "karaoke_local_pcm_discontinuity");
      const startMs = bytes / 32;
      bytes += frame.pcm16.byteLength;
      chunks.push(frame.pcm16);
      spans.push({ startMs, endMs: bytes / 32, songStartMs: frame.songStartMs, songEndMs: frame.songEndMs });
    },
    async commit() {
      if (!input || !generation || !bytes || active) return null;
      const owner = input, streamGeneration = generation;
      const audio = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        audio.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      const map = spans;
      const frontierMs = map.at(-1)!.songEndMs;
      chunks = [];
      spans = [];
      bytes = 0;
      const commitId = crypto.randomUUID();
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
      const songTime = (ms: number, end: boolean) => {
        const span = map.find(s => end ? s.startMs < ms && ms <= s.endMs : s.startMs <= ms && ms < s.endMs);
        check(span, "karaoke_local_word_time_invalid");
        return Math.round(span.songStartMs + (ms - span.startMs) *
          (span.songEndMs - span.songStartMs) / (span.endMs - span.startMs));
      };
      // Let the relay install the original commit handle before recognition can respond.
      setTimeout(() => {
        if (active !== controller || signal.aborted) return;
        void (async () => {
          let outcome: KaraokeLocalFailure["outcome"] = "child_unavailable";
          try {
            const digest = sha256(audio);
            const response = await port.fetch("http://local-karaoke/recognize", {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: audio,
              signal,
            });
            outcome = response.status === 504 ? "timeout" : "child_unavailable";
            check(response.ok, "karaoke_local_recognition_unavailable");
            outcome = "invalid_response";
            const doc = await boundedJson(response);
            check(doc && doc.schema === "pirate.local-karaoke-recognition/1" &&
              doc.timing === "whisper-token-timestamps" && Array.isArray(doc.words) &&
              doc.words.length <= 1000, "karaoke_local_recognition_invalid");
            if (doc.modelSha256 !== modelSha256 || doc.pcmSha256 !== digest ||
                doc.sampleCount !== audio.byteLength / 2) {
              if (active === controller && input === owner) {
                active = null;
                owner.onTerminalError?.("local_recognition_binding_changed");
              }
              return;
            }
            outcome = "invalid_word_time";
            let previous = 0;
            const words: KaraokeRecognizedWord[] = doc.words.map((word: unknown) => {
              const row = word as { text?: unknown; startMs?: unknown; endMs?: unknown; confidence?: unknown } | null;
              check(row && typeof row.text === "string" && row.text.length <= 120 &&
                /^\S+$/u.test(row.text) && typeof row.startMs === "number" && typeof row.endMs === "number" &&
                Number.isSafeInteger(row.startMs) && Number.isSafeInteger(row.endMs) &&
                row.startMs >= previous && row.endMs > row.startMs && row.endMs <= audio.byteLength / 32 &&
                typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1,
                "karaoke_local_word_time_invalid");
              previous = row.startMs;
              const startMs = songTime(row.startMs, false), endMs = songTime(row.endMs, true);
              check(endMs > startMs, "karaoke_local_word_time_invalid");
              return { text: row.text, startMs, endMs, confidence: row.confidence, final: true, source: "stt" };
            });
            if (active !== controller || input !== owner) return;
            signal.throwIfAborted();
            active = null;
            await owner.onMessage({
              event: { protocolVersion: 1, type: "stt_final", sessionId: owner.sessionId,
                attemptId: owner.attemptId, sequence: ++sequence, deliveredAtAudioMs: frontierMs,
                text: words.map(word => word.text).join(" "), words },
              commit: { commitId, streamGeneration, coverageMs: frontierMs },
            });
          } catch {
            if (active === controller && input === owner) {
              active = null;
              if (signal.aborted) outcome = "timeout";
              await owner.onLocalCommitUnmeasured?.({
                commitId, streamGeneration, outcome, pcmMs: audio.byteLength / 32,
              }).catch(() => undefined);
            }
          }
        })();
      }, 0);
      return { commitId, streamGeneration, frontierMs };
    },
    discardPendingOnSeek,
    async close() {
      discardPendingOnSeek();
      input = null;
      generation = null;
    },
  };
}
