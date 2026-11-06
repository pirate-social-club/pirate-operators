import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import type {
  KaraokeManifest,
  KaraokeResultBody,
} from "../packages/protocol/payments.ts";
import type { Store } from "./runtime.ts";
import { check } from "../packages/protocol/index.ts";

export function saveLearnerHistory(
  store: Store,
  result: KaraokeResultBody,
  manifest: KaraokeManifest,
  retentionDays: number,
) {
  check(
    Number.isSafeInteger(retentionDays) &&
      retentionDays > 0 &&
      retentionDays <= 90,
    "history_retention_unconfigured",
  );
  const words =
    store.get<KaraokeRecognizedWord[]>(`words:${result.ticketId}`) ?? [];
  store.set(`history:${result.ticketId}`, {
    schema: "pirate.learner-history/1",
    activity: "karaoke",
    language: "und",
    sessionId: result.attemptId,
    communityId: result.communityId,
    source: manifest.song,
    contentRevision: result.manifestSha256,
    completedAt: result.performanceEndedAt,
    expiresAt: result.performanceEndedAt + retentionDays * 86400,
    observations: { expectedLines: manifest.lines, recognizedWords: words },
    assessment: {
      policy: `karaoke-scoring/${result.summary.scoringVersion}`,
      outcomes: result.lines,
    },
    provider: { name: "elevenlabs", model: "scribe_v2_realtime" },
    limitations: [
      "Recognized text and timings are speech-recognition evidence, not a direct pronunciation measurement.",
      "This operator-held export is an interim history copy. It is not an encrypted learner vault.",
    ],
  });
}
export function expireLearnerHistory(store: Store) {
  for (const { key, value } of store.entries("history:")) {
    if ((value as { expiresAt: number }).expiresAt > store.now()) continue;
    const ticketId = key.slice("history:".length);
    store.delete(key);
    store.delete(`words:${ticketId}`);
    store.delete(`audioRelay:${ticketId}`);
  }
}
