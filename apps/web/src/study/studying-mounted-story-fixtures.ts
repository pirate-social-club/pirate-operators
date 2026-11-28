// Stateful mounted StudyScreen fixtures. They model the operator lesson
// lifecycle without network, microphone, timers, translation cards, rewards,
// or streak facts.
import type {
  StudyAttempt,
  StudyLine,
} from "../../../../packages/study/contracts.ts";
import {
  STUDY_LESSON_NO_DEADLINE,
  STUDY_LESSON_SCHEMA,
  studyPresentationCap,
  type StudyLesson,
  type StudyLessonSubmission,
  type StudySong,
} from "../../../../packages/study/lesson.ts";
import type { StudyClient } from "./client.ts";

export const mountedStudyPostId = `0x${"3".repeat(64)}`;
export const mountedStudyAccount = `0x${"a".repeat(40)}`;
const song: StudySong = {
  chainId: 6343,
  postsContract: `0x${"1".repeat(40)}`,
  communityId: `0x${"2".repeat(64)}`,
  postId: mountedStudyPostId,
  lyricRevision: 1,
};
const digest = `0x${"5".repeat(64)}`;
const texts = [
  "Yo no sé por qué te fuiste tan temprano",
  "La luna sigue brillando sobre el mar",
  "Cada palabra vuelve a su lugar",
  "Cantamos hasta ver salir el sol",
];
const line = (index: number): StudyLine => ({
  ...song,
  lineId: `0x${String(index + 1).padStart(64, "0")}`,
  lineVersion: 1,
  text: texts[index],
  language: "es",
  manifestDigest: digest,
});
interface FixtureItem {
  line: StudyLine;
  presentations: number;
  mastered: boolean;
  resolved: boolean;
  firstPassOutcome: "correct" | "incorrect" | null;
  missFirst: boolean;
}
export interface MountedStudyFixtureOptions {
  /** Close the open legacy lesson when the next attempt is opened. */
  closeOnOpen?: boolean;
  /** Lose the next upload after the provider may have accepted it. */
  unresolvedRecording?: boolean;
  /** Start with this many leading cards already resolved. */
  resolvedBefore?: number;
  /** First-pass correct count among those already resolved cards. */
  firstPassCorrectBefore?: number;
}
export interface MountedStudyFixture {
  client: StudyClient;
  initialLessonId: string;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const conflict = (message: string) =>
  Object.assign(new Error(message), { status: 409 });

/** A small server-shaped lesson engine for mounted screen stories. */
export function createMountedStudyFixture(
  options: MountedStudyFixtureOptions = {},
): MountedStudyFixture {
  const initialLessonId = "11111111-1111-4111-8111-111111111111";
  const replacementLessonId = "22222222-2222-4222-8222-222222222222";
  let lessonId = initialLessonId;
  let items: FixtureItem[] = [];
  let currentIndex: number | null = 0;
  let presentationCount = 0;
  let startedAt = 1_000;
  let expiresAt = STUDY_LESSON_NO_DEADLINE;
  let completedAt: number | null = null;
  let status: StudyLesson["status"] = "active";
  let completionReason: StudyLesson["completionReason"] = null;
  let currentAttempt: StudyAttempt | null = null;
  let lastAttempt: StudyAttempt | null = null;
  let opened: StudyAttempt | null = null;
  let replacementStarted = false;

  function resetItems(prepared = true) {
    items = texts.map((_, index) => ({
      line: line(index),
      presentations: 0,
      mastered: false,
      resolved: false,
      firstPassOutcome: null,
      missFirst: index === 1,
    }));
    const resolvedBefore = prepared ? (options.resolvedBefore ?? 0) : 0;
    const firstPassCorrectBefore = prepared
      ? (options.firstPassCorrectBefore ?? resolvedBefore)
      : 0;
    for (let index = 0; index < resolvedBefore; index++) {
      const item = items[index];
      const firstCorrect = index < firstPassCorrectBefore;
      item.resolved = true;
      item.mastered = true;
      item.firstPassOutcome = firstCorrect ? "correct" : "incorrect";
      item.presentations = firstCorrect ? 1 : 2;
      presentationCount += item.presentations;
    }
    currentIndex = resolvedBefore < items.length ? resolvedBefore : null;
  }
  resetItems();
  if (options.closeOnOpen) expiresAt = startedAt + 3_600_000;

  function progress(): StudyLesson["progress"] {
    return {
      total: items.length,
      resolved: items.filter((item) => item.resolved).length,
      mastered: items.filter((item) => item.mastered).length,
      presentations: presentationCount,
      presentationCap: studyPresentationCap(items.length),
      firstPassGraded: items.filter((item) => item.firstPassOutcome !== null)
        .length,
      firstPassCorrect: items.filter(
        (item) => item.firstPassOutcome === "correct",
      ).length,
    };
  }
  function snapshot(): StudyLesson {
    const item = currentIndex === null ? undefined : items[currentIndex];
    return copy({
      schema: STUDY_LESSON_SCHEMA,
      kind: "say-it-back",
      lessonId,
      song,
      startedAt,
      expiresAt,
      completedAt,
      status,
      completionReason,
      current:
        status === "active" && item
          ? {
              line: item.line,
              presentationNumber: presentationCount + 1,
              takeNumber: 1,
              attempt: currentAttempt,
            }
          : null,
      lastAttempt,
      progress: progress(),
      qualification: "not_evaluated",
    });
  }
  function makeAttempt(state: StudyAttempt["state"], correct?: boolean) {
    const item = items[currentIndex!];
    const presentationNumber = presentationCount + 1;
    return {
      schema: "pirate.study.attempt/1" as const,
      kind: "say-it-back" as const,
      attemptId: `${lessonId}-attempt-${presentationNumber}`,
      line: copy(item.line),
      policy: "script_aware_token_phonetic_v5" as const,
      startedAt: 2_000 + presentationNumber,
      completedAt: state === "assessed" ? 3_000 + presentationNumber : null,
      state,
      grade:
        state === "assessed"
          ? {
              correct: correct === true,
              matchKind: correct ? ("exact" as const) : ("none" as const),
              policyRevision: "script_aware_token_phonetic_v5" as const,
            }
          : null,
      failure: null,
      lesson: { lessonId, presentationNumber, takeNumber: 1 },
      recordingDurationMs: state === "assessed" ? 1_000 : null,
      qualification: "not_evaluated" as const,
    } satisfies StudyAttempt;
  }
  function close(
    nextStatus: "abandoned" | "completed" | "expired",
    reason: NonNullable<StudyLesson["completionReason"]>,
  ) {
    status = nextStatus;
    completionReason = reason;
    completedAt =
      nextStatus === "expired"
        ? expiresAt
        : startedAt + presentationCount + 1;
    currentIndex = null;
    currentAttempt = null;
    opened = null;
  }
  function advance() {
    if (items.every((item) => item.resolved)) {
      close("completed", "all_resolved");
      return;
    }
    for (let step = 1; step <= items.length; step++) {
      const index = ((currentIndex ?? 0) + step) % items.length;
      if (!items[index].resolved) {
        currentIndex = index;
        return;
      }
    }
  }
  function startReplacement() {
    replacementStarted = true;
    lessonId = replacementLessonId;
    presentationCount = 0;
    startedAt = 10_000;
    expiresAt = STUDY_LESSON_NO_DEADLINE;
    completedAt = null;
    status = "active";
    completionReason = null;
    currentAttempt = null;
    lastAttempt = null;
    opened = null;
    resetItems(false);
  }

  const client: StudyClient = {
    async load() {
      // Cold opens never resurrect a terminal lesson; the producer starts its
      // replacement instead. In-flight recovery uses refresh(), not this path.
      if ((status === "expired" || status === "abandoned") && !replacementStarted)
        startReplacement();
      return snapshot();
    },
    async refresh() {
      // Exact stored readback: terminal state remains terminal here.
      return snapshot();
    },
    async restart() {
      if (!replacementStarted) startReplacement();
      return snapshot();
    },
    async open() {
      if (status !== "active" || currentIndex === null) throw conflict("study_lesson_changed");
      if (options.closeOnOpen && lessonId === initialLessonId) {
        close("expired", "deadline");
        throw conflict("study_lesson_changed");
      }
      const attempt = makeAttempt("ready");
      currentAttempt = attempt;
      opened = attempt;
      return { attempt: copy(attempt), lesson: snapshot() };
    },
    async submit(
      submittedLessonId: string,
      attemptId: string,
      _audio: Blob,
      durationMs: number,
    ): Promise<StudyLessonSubmission> {
      if (
        submittedLessonId !== lessonId ||
        !opened ||
        opened.attemptId !== attemptId ||
        currentIndex === null
      )
        throw conflict("study_lesson_changed");
      if (options.unresolvedRecording && lessonId === initialLessonId) {
        currentAttempt = {
          ...opened,
          state: "uncertain",
          recordingDurationMs: durationMs,
        };
        opened = null;
        throw new Error("The recording outcome is unknown.");
      }
      const item = items[currentIndex];
      const firstPass = item.firstPassOutcome === null;
      const correct = !(firstPass && item.missFirst);
      const attempt = {
        ...makeAttempt("assessed", correct),
        attemptId,
        recordingDurationMs: durationMs,
      };
      item.presentations++;
      if (firstPass) item.firstPassOutcome = correct ? "correct" : "incorrect";
      if (correct || item.presentations >= 3) {
        item.resolved = true;
        item.mastered = correct;
      }
      presentationCount++;
      currentAttempt = null;
      opened = null;
      lastAttempt = attempt;
      advance();
      return { attempt: copy(attempt), lesson: snapshot() };
    },
  };
  return { client, initialLessonId };
}
