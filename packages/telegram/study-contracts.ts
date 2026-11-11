import type { StudyLine } from "../study/contracts.ts";
import type { LessonState, StudyLesson, StudySong } from "../study/lesson.ts";
import type { StudyTranscriptGraderPolicyRevision } from "../study/transcript-grading.ts";
import type { ChatActor, TelegramGrant } from "./contracts.ts";

export interface TelegramPublicAudio {
  url: string;
  sha256: string;
  filename: string;
  byteLength: number;
}
export interface TelegramOffer {
  id: string;
  mode: "practice" | "testnet" | "live";
  opensAt: number;
  cutoffAt: number;
  tickets: number;
  activities: readonly ("study" | "karaoke" | "dance")[];
  rules: string;
}
export type TelegramOffers =
  | { state: "unavailable" }
  | {
      state: "ready";
      offers: TelegramOffer[];
      readAt: number;
      validUntil: number;
    };
export interface TelegramSong {
  key: string;
  title: string;
  song: StudySong;
  publicAudio: TelegramPublicAudio;
  offers: TelegramOffers;
  /** Only from verified account progress reads. Null is not zero. */
  streak: number | null;
  resumable: boolean | null;
}
export interface TelegramCatalogPort {
  list(
    actor: ChatActor,
    grant: TelegramGrant | null,
  ): Promise<{ songs: TelegramSong[]; drawAt: number | null }>;
  song(
    actor: ChatActor,
    key: string,
    grant: TelegramGrant | null,
  ): Promise<TelegramSong>;
  lines(song: StudySong): Promise<StudyLine[]>;
  /** Read an admitted/cached prompt recording; never start paid generation from this read. */
  referenceAudio(line: StudyLine): Promise<TelegramPublicAudio | null>;
}
export interface TelegramLessonView {
  id: string;
  mode: "trial" | "linked";
  songKey: string;
  status: "active" | "completed" | "abandoned" | "expired";
  revision: number;
  startedAt: number;
  completedAt: number | null;
  prompt: {
    key: string;
    line: StudyLine;
    presentation: number;
    take: number;
  } | null;
  progress: { total: number; resolved: number };
  score: number | null;
}
export interface TelegramTrialRecord {
  id: string;
  actor: ChatActor;
  songKey: string;
  state: LessonState;
  revision: number;
  policy: StudyTranscriptGraderPolicyRevision;
  historyDeletedAt: number | null;
}
export interface TelegramVoiceInput {
  fileId: string;
  fileUniqueId: string;
  contentType: string;
  durationMs: number;
  reportedBytes: number;
}
export interface TelegramLinkedStudyPort {
  start(
    actor: ChatActor,
    grant: TelegramGrant,
    song: TelegramSong,
    requestId: string,
  ): Promise<StudyLesson>;
  get(
    actor: ChatActor,
    grant: TelegramGrant,
    lessonId: string,
  ): Promise<StudyLesson>;
  /** Idempotent attempt under the existing Study service; the trusted adapter
   * marks its operator offer telegram-linked and rechecks lane6 authority. */
  answer(
    actor: ChatActor,
    grant: TelegramGrant,
    lessonId: string,
    expected: TelegramLessonView["prompt"],
    request: Request,
  ): Promise<{
    lesson: StudyLesson;
    attempt: import("../study/contracts.ts").StudyAttempt;
  }>;
  recover(
    actor: ChatActor,
    grant: TelegramGrant,
    lessonId: string,
    expected: TelegramLessonView["prompt"],
    audioDigest: string,
  ): Promise<{
    lesson: StudyLesson;
    attempt: import("../study/contracts.ts").StudyAttempt | null;
  }>;
  /** Personal status comes from the existing economic ledger, never UI scores. */
  personal(
    actor: ChatActor,
    grant: TelegramGrant,
    song: TelegramSong,
  ): Promise<{
    streak: number | null;
    participation: "pending" | "entered" | "none" | "unavailable";
    claimable: boolean;
  }>;
}
