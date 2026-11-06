import type { LyricManifest } from "../community/lyric-manifest.ts";
import type { StudyTerminalFacts } from "./terminal-facts.ts";
export type { StudyPublicationReceipt } from "./publication-view.ts";

/** Sent by the authenticated community service, never accepted from a learner. */
export interface StudyTerminalRequest {
  lessonId: string;
  terminal: StudyTerminalFacts;
  source: LyricManifest;
}
