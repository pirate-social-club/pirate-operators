import { Effect } from "effect";
import { sha256, toHex } from "viem";
import {
  StudyAttemptStore,
  attemptView,
} from "../packages/study/attempt-store.ts";
import {
  MAX_STUDY_AUDIO_BYTES,
  MIN_STUDY_RECORDING_MS,
  MAX_STUDY_RECORDING_MS,
  StudyError,
  selection,
  studyCheck,
  validateStudyLine,
  type StudyLine,
  type StudyPrincipal,
  type StudySelection,
  type StudyAttemptLesson,
} from "../packages/study/contracts.ts";
import {
  StudySpeechError,
  type StudyTranscriber,
} from "../packages/study/speech-transcriber.ts";
import {
  gradeStudySpeech,
  minimalStudyGrade,
  type StudyAssessmentPort,
} from "../packages/study/assessment.ts";
import type { AdmittedStudyGrader } from "../packages/study/grader-revision.ts";
import type { StudySpeechContext } from "../packages/study/speech-transcriber.ts";

export async function readStudyAudio(request: Request) {
  const durationMs = Number(request.headers.get("x-study-duration-ms"));
  studyCheck(
    Number.isSafeInteger(durationMs) && durationMs >= MIN_STUDY_RECORDING_MS,
    "study_recording_too_short",
  );
  studyCheck(durationMs <= MAX_STUDY_RECORDING_MS, "study_recording_too_long");
  const type = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  studyCheck(
    ["audio/webm", "audio/ogg", "audio/wav", "audio/mp4"].includes(type),
    "unsupported_study_audio",
    415,
  );
  studyCheck(
    Number(request.headers.get("content-length") ?? 0) <= MAX_STUDY_AUDIO_BYTES,
    "study_audio_too_large",
    413,
  );
  studyCheck(request.body, "empty_study_audio");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      studyCheck(size <= MAX_STUDY_AUDIO_BYTES, "study_audio_too_large", 413);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const ascii = new TextDecoder().decode(audio.subarray(0, 12));
  studyCheck(
    size >= 12 &&
      ((type === "audio/webm" &&
        toHex(audio.subarray(0, 4)) === "0x1a45dfa3") ||
        (type === "audio/ogg" && ascii.startsWith("OggS")) ||
        (type === "audio/wav" &&
          ascii.startsWith("RIFF") &&
          ascii.slice(8, 12) === "WAVE") ||
        (type === "audio/mp4" && ascii.slice(4, 8) === "ftyp")),
    "invalid_study_audio",
    415,
  );
  return { audio, contentType: type, durationMs };
}

export function makeStudyService(options: {
  db: D1Database;
  transcriber: StudyTranscriber;
  /** Trusted saved binding selects a shared minimal assessor; no client grade. */
  assessor?(context: StudySpeechContext): Promise<StudyAssessmentPort | null>;
  // Lesson-linked attempts resolve the frozen, authenticated published source.
  resolveLine(
    selection: StudySelection,
    lesson: StudyAttemptLesson | null,
  ): Promise<StudyLine>;
  now?: () => number;
}) {
  const store = new StudyAttemptStore(options.db),
    now = options.now ?? Date.now;
  function principal(owner: StudyPrincipal) {
    studyCheck(
      owner.accountId.length > 0 &&
        owner.accountId.length <= 128 &&
        /^0x[0-9a-f]{64}$/.test(owner.communityId),
      "study_auth_required",
      401,
    );
  }
  const service = {
    async open(
      owner: StudyPrincipal,
      requestId: string,
      input: unknown,
      lesson: StudyAttemptLesson | null = null,
      policy?: AdmittedStudyGrader,
    ) {
      principal(owner);
      studyCheck(
        /^[a-zA-Z0-9_-]{16,128}$/.test(requestId),
        "invalid_study_request_id",
      );
      const requested = selection(input);
      studyCheck(
        requested.communityId === owner.communityId,
        "study_wrong_community",
        403,
      );
      const line = validateStudyLine(
        await options.resolveLine(requested, lesson),
        requested,
      );
      return store.open(owner, requestId, line, now(), lesson, policy);
    },
    async get(owner: StudyPrincipal, id: string) {
      principal(owner);
      const row = await store.get(owner, id);
      if (
        (options.transcriber.recover || options.assessor) &&
        (row.state === "assessing" || row.state === "uncertain") &&
        row.lesson_id &&
        row.audio_digest &&
        row.audio_duration_ms
      ) {
        // Recovery cannot reopen a closed lesson or grade after its deadline.
        const active = await options.db
          .prepare(
            `SELECT 1 FROM study_lessons WHERE lesson_id=? AND account_id=?
          AND community_id=? AND json_extract(state_json,'$.status')='active'
          AND json_extract(state_json,'$.currentAttemptId')=?
          AND json_extract(state_json,'$.expiresAt')>?`,
          )
          .bind(row.lesson_id, owner.accountId, owner.communityId, id, now())
          .first();
        if (active) {
          const line: StudyLine = JSON.parse(row.line_json);
          // Unavailable status storage is not evidence of a failed dispatch.
          const context: StudySpeechContext = {
            lessonId: row.lesson_id,
            attemptId: id,
            lineId: line.lineId,
            presentationNumber: row.presentation_number!,
            takeNumber: row.take_number!,
            durationMs: row.audio_duration_ms,
          };
          const receipt = await (async () => {
            // Missing legacy context is not evidence of a failed dispatch.
            // Hold recovery without a raw transcriber fallback; closure can
            // still record the original attempted work as unmeasured.
            const assessor = await options.assessor?.(context);
            return assessor
              ? assessor.recover(context, row.audio_digest!)
              : (options.transcriber.recover?.(context, row.audio_digest!) ??
                  Promise.resolve(null));
          })().catch(() => null);
          if (receipt)
            return store.finish(
              owner,
              id,
              receipt.state,
              receipt.state === "assessed"
                ? "grade" in receipt
                  ? minimalStudyGrade(receipt.grade, row.policy)
                  : gradeStudySpeech(
                      line,
                      receipt.transcript,
                      row.policy,
                      row.take_number ?? 1,
                    )
                : null,
              receipt.state === "unavailable" ? receipt.error : null,
              now(),
              row.state,
            );
        }
      }
      return attemptView(row);
    },
    async list(owner: StudyPrincipal, input?: unknown) {
      principal(owner);
      const requested = input === undefined ? undefined : selection(input);
      studyCheck(
        !requested || requested.communityId === owner.communityId,
        "study_wrong_community",
        403,
      );
      return store.list(owner, requested);
    },
    submit(owner: StudyPrincipal, id: string, request: Request) {
      return Effect.tryPromise({
        try: async () => {
          principal(owner);
          const row = await store.get(owner, id);
          const { audio, contentType, durationMs } =
            await readStudyAudio(request);
          const digest = sha256(audio);
          if (!(await store.claim(owner, id, digest, now(), durationMs)))
            return attemptView(await store.get(owner, id));
          try {
            const line: StudyLine = JSON.parse(row.line_json);
            const context: StudySpeechContext | undefined = row.lesson_id
              ? {
                  lessonId: row.lesson_id,
                  attemptId: id,
                  lineId: line.lineId,
                  presentationNumber: row.presentation_number!,
                  takeNumber: row.take_number!,
                  durationMs,
                }
              : undefined;
            const assessor = context ? await options.assessor?.(context) : null;
            const grade =
              assessor && context
                ? minimalStudyGrade(
                    await assessor.assess(audio, contentType, line, context),
                    row.policy,
                  )
                : gradeStudySpeech(
                    line,
                    await options.transcriber.transcribe(
                      audio,
                      contentType,
                      line.language,
                      context,
                    ),
                    row.policy,
                    row.take_number ?? 1,
                  );
            return await store.finish(
              owner,
              id,
              "assessed",
              grade,
              null,
              now(),
            );
          } catch (error) {
            const known =
              error instanceof StudySpeechError &&
              error.outcome === "known_failed";
            return await store.finish(
              owner,
              id,
              known ? "unavailable" : "uncertain",
              null,
              error instanceof StudySpeechError
                ? error.code
                : "speech_unavailable",
              now(),
            );
          }
        },
        catch: (error) =>
          error instanceof StudyError
            ? error
            : new StudyError("study_unavailable", 503),
      });
    },
  };
  return service;
}
