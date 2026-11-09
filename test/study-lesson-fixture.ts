import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { Effect } from "effect";
import { makeStudyService } from "../services/study-spoken.ts";
import { makeStudyLessonService } from "../services/study-lessons.ts";
import { songOf, type StudyLesson } from "../packages/study/lesson.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";
import type { StudyLine } from "../packages/study/contracts.ts";
import { makeLegacyLesson } from "./study-close-bound-fixture.ts";

export function lessonRecording(duration = 1000, suffix = 1) {
  return new Request("https://study.example/audio", {
    method: "PUT",
    headers: {
      "content-type": "audio/webm",
      "x-study-duration-ms": String(duration),
    },
    body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, suffix]),
  });
}
export async function lessonFixture(
  count = 4,
  persist?: string,
  initialize = true,
) {
  const runtime = new Miniflare({
    modules: true,
    script:
      "export default {fetch(){return new Response('Study lesson fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: { DB: "study-lessons" },
    ...(persist ? { d1Persist: persist } : {}),
  });
  const db = await runtime.getD1Database("DB");
  if (initialize) {
    const sql = await readFile(
      new URL("../packages/study/schema.sql", import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
  }
  const lines: StudyLine[] = Array.from({ length: count }, (_, i) => ({
    chainId: 6343,
    postsContract: "0x" + "2".repeat(40),
    communityId: "0x" + "a".repeat(64),
    postId: "0x" + "b".repeat(64),
    lineId: "0x" + (i + 1).toString(16).padStart(64, "0"),
    lyricRevision: 1,
    lineVersion: 1,
    text: "Hold me close " + (i + 1),
    language: "en",
    manifestDigest: "0x" + "d".repeat(64),
  }));
  const owner = {
      accountId: "lesson-learner",
      communityId: lines[0].communityId,
    },
    song = songOf(lines[0]);
  let heard = lines[0].text,
    calls = 0,
    failure: "known_failed" | "unknown" | null = null,
    clock = 1793894400000,
    // Lesson-only databases have no bindings; tests may simulate one consent.
    consent: number | null = null;
  const attemptOptions = {
    db,
    now: () => clock,
    resolveLine: async (selected: { lineId: string }) =>
      lines.find((l) => l.lineId === selected.lineId)!,
    transcriber: {
      providerRetention: "stored" as const,
      transcribe: async () => {
        calls++;
        if (failure) throw new StudySpeechError("speech_unavailable", failure);
        return { text: heard, language: "en" };
      },
    },
  };
  const attempts = makeStudyService(attemptOptions);
  const lessonOptions = {
    db,
    attempts,
    resolveLines: async () => lines,
    now: () => clock,
    consentExpiry: async () => consent,
  };
  const lessons = makeStudyLessonService(lessonOptions);
  return {
    db,
    owner,
    song,
    lines,
    attempts,
    attemptOptions,
    lessons,
    lessonOptions,
    dispose: () => runtime.dispose(),
    calls: () => calls,
    fail: (value: typeof failure) => {
      failure = value;
    },
    heard: (text: string) => {
      heard = text;
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
    start: (requestId = "lesson-request-" + crypto.randomUUID()) =>
      lessons.start(owner, requestId, song),
    /** A lesson started before the time limit was removed (one-hour deadline). */
    async startLegacy(requestId = "lesson-request-" + crypto.randomUUID()) {
      const lesson = await lessons.start(owner, requestId, song);
      await makeLegacyLesson(db, lesson.lessonId);
      return lessons.get(owner, lesson.lessonId);
    },
    /** Simulate the bound consent's end, in seconds, for every lesson. */
    consent: (expiresAtS: number | null) => {
      consent = expiresAtS;
    },
    clock: () => clock,
    async answer(lesson: StudyLesson, correct: boolean) {
      const current = lesson.current!;
      heard = correct ? current.line.text : "unrelated words";
      const opened = await lessons.openAttempt(
        owner,
        lesson.lessonId,
        current.presentationNumber,
        current.takeNumber,
      );
      return Effect.runPromise(
        lessons.submit(
          owner,
          lesson.lessonId,
          opened.attempt.attemptId,
          lessonRecording(),
        ),
      );
    },
  };
}
