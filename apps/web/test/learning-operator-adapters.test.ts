// Queued only: pure memory tests, no providers, microphone, sockets or chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StudyAttempt } from "../../../packages/study/contracts.ts";
import type { StudyLesson } from "../../../packages/study/lesson.ts";
import type { StudyClient } from "../src/study/client.ts";
import {
  createOperatorStudyingClient,
  operatorStudyPayload,
  operatorStudyResult,
} from "../src/study/operator-studying-adapter.ts";
import type { StudyingAttemptInput } from "../src/study/studying-route-model.ts";
import {
  createOperatorKaraokePort,
  type KaraokeAttemptView,
} from "../src/karaoke/operator-karaoke-adapter.ts";
import { LearningServiceError } from "../src/karaoke/operator-learning-http.ts";

const id = (digit: string) => `0x${digit.repeat(64)}`;
function lesson(): StudyLesson {
  const song = {
    chainId: 6343,
    postsContract: `0x${"1".repeat(40)}`,
    communityId: id("2"),
    postId: id("3"),
    lyricRevision: 1,
  };
  return {
    schema: "pirate.study.lesson/1",
    kind: "say-it-back",
    lessonId: id("4"),
    song,
    startedAt: 100,
    expiresAt: Number.MAX_SAFE_INTEGER,
    completedAt: null,
    status: "active",
    completionReason: null,
    current: {
      line: {
        ...song,
        lineId: id("5"),
        lineVersion: 1,
        text: "I am going home",
        language: "en",
        manifestDigest: id("6"),
      },
      presentationNumber: 1,
      takeNumber: 1,
      attempt: null,
    },
    lastAttempt: null,
    progress: {
      total: 4,
      resolved: 0,
      mastered: 0,
      presentations: 0,
      presentationCap: 12,
      firstPassGraded: 0,
      firstPassCorrect: 0,
    },
    qualification: "not_evaluated",
  };
}
function attempt(
  value = lesson(),
  state: StudyAttempt["state"] = "ready",
): StudyAttempt {
  return {
    schema: "pirate.study.attempt/1",
    kind: "say-it-back",
    attemptId: id("7"),
    line: value.current!.line,
    policy: "script_aware_token_phonetic_v5",
    startedAt: 100,
    completedAt: null,
    state,
    grade: null,
    failure: null,
    lesson: { lessonId: value.lessonId, presentationNumber: 1, takeNumber: 1 },
    recordingDurationMs: null,
    qualification: "not_evaluated",
  };
}
function input(value = lesson()): StudyingAttemptInput {
  return {
    type: "say_it_back",
    session_id: value.lessonId,
    exercise_id: value.current!.line.lineId,
    attempt_number: 1,
    idempotency_key: "same-audio-key",
    audio: new Blob(["audio"], { type: "audio/webm" }),
    audio_duration_ms: 1000,
    content_type: "audio/webm",
  };
}
function client(value = lesson()): StudyClient {
  return {
    load: async () => value,
    refresh: async () => value,
    restart: async () => value,
    open: async () => ({ attempt: attempt(value), lesson: value }),
    submit: async () => {
      throw new Error("No scripted submission");
    },
  };
}

test("lost final upload acknowledgement reconciles exact attempt and preserves actual result", async () => {
  const initial = lesson(),
    finalAttempt = {
      ...attempt(initial, "assessed"),
      grade: {
        correct: true,
        matchKind: "exact" as const,
        policyRevision: "script_aware_token_phonetic_v5" as const,
      },
    };
  const completed: StudyLesson = {
    ...initial,
    status: "completed",
    current: null,
    completedAt: 200,
    lastAttempt: finalAttempt,
    progress: { ...initial.progress, resolved: 4, firstPassCorrect: 3 },
  };
  let opens = 0,
    uploads = 0,
    refreshes = 0;
  const port = createOperatorStudyingClient({
    ...client(initial),
    open: async () => {
      opens++;
      return { attempt: attempt(initial), lesson: initial };
    },
    submit: async (lessonId, attemptId) => {
      uploads++;
      assert.equal(lessonId, initial.lessonId);
      assert.equal(attemptId, finalAttempt.attemptId);
      throw new Error("ack lost");
    },
    refresh: async () => {
      refreshes++;
      return completed;
    },
  });
  await port.loadLesson("song");
  const result = await port.submitAttempt(input(initial));
  assert.equal(result.outcome, "correct");
  assert.equal(result.session?.first_pass_correct_count, 3);
  assert.deepEqual(result.next_lesson?.exercises, []);
  assert.equal(result.study_progress, undefined);
  assert.deepEqual([opens, uploads, refreshes], [1, 1, 1]);
});

test("unconfirmed upload holds card and cannot open another reservation", async () => {
  const initial = lesson();
  let opens = 0;
  const port = createOperatorStudyingClient({
    ...client(initial),
    open: async () => {
      opens++;
      return { attempt: attempt(initial), lesson: initial };
    },
    refresh: async () => {
      throw new Error("offline");
    },
  });
  await port.loadLesson("song");
  await assert.rejects(port.submitAttempt(input(initial)), {
    details: {
      reason_code: "study_provider_outcome_unknown",
      next_action: "operator_review",
    },
  });
  await assert.rejects(port.submitAttempt(input(initial)));
  assert.equal(opens, 1);
});

test("provider uncertainty after reload blocks before any microphone upload or open", async () => {
  const initial = lesson();
  initial.current!.attempt = attempt(initial, "uncertain");
  let opened = false;
  const port = createOperatorStudyingClient({
    ...client(initial),
    open: async () => {
      opened = true;
      throw new Error("must not open");
    },
  });
  const payload = await port.loadLesson("song");
  assert.equal(
    payload.spoken_submission?.session_item_id,
    initial.current!.line.lineId,
  );
  await assert.rejects(port.submitAttempt(input(initial)));
  assert.equal(opened, false);
});

test("refused speech and re-record have no fabricated miss, streak or reward", () => {
  const initial = lesson(),
    unavailable = attempt(initial, "unavailable");
  assert.throws(
    () => operatorStudyResult({ attempt: unavailable, lesson: initial }),
    {
      details: {
        reason_code: "study_provider_refused",
        next_action: "record_again",
      },
    },
  );
  const ungraded = {
    ...attempt(initial, "assessed"),
    grade: {
      correct: false,
      matchKind: "none" as const,
      policyRevision: "script_aware_token_phonetic_v5" as const,
      rerecordReason: "low_voice_overlap" as const,
    },
  };
  const result = operatorStudyResult({ attempt: ungraded, lesson: initial });
  assert.equal(result.outcome, "ungraded_rerecord");
  assert.equal(result.study_progress, undefined);
  assert.equal(operatorStudyPayload(initial).reward_label, undefined);
});

test("auth/account switch is held without attempting recovery under another identity", async () => {
  const initial = lesson();
  let refreshes = 0;
  const port = createOperatorStudyingClient({
    ...client(initial),
    submit: async () => {
      throw Object.assign(new Error("account changed"), {
        status: 401,
        code: "study_account_changed",
      });
    },
    refresh: async () => {
      refreshes++;
      return initial;
    },
  });
  await port.loadLesson("song");
  await assert.rejects(port.submitAttempt(input(initial)), {
    code: "study_account_changed",
  });
  assert.equal(refreshes, 0);
});

const open: KaraokeAttemptView = {
  state: "open",
  ticket: { body: { ticketId: "same-ticket" } },
  socketUrl: "wss://community.invalid/attempt",
  proof: "fixture-proof",
  elapsedMs: 1400,
};
test("lost ticket response recovers same ticket; subsequent retries do not create another", async () => {
  let reads = 0,
    writes = 0;
  const port = createOperatorKaraokePort({
    account: "fixture-account",
    postId: "fixture-post",
    csrf: () => "fixture-csrf",
    request: async <T>(_path: string, body?: unknown): Promise<T> => {
      if (body !== undefined) {
        writes++;
        throw new Error("ack lost");
      }
      reads++;
      return (reads === 1 ? { state: "none" } : open) as T;
    },
  });
  assert.equal((await port.ticket()).ticketId, "same-ticket");
  assert.equal((await port.ticket()).ticketId, "same-ticket");
  assert.equal(writes, 1);
  port.dispose();
});

test("unresolved ticket creation never treats an early empty read as authority to charge again", async () => {
  let writes = 0;
  const port = createOperatorKaraokePort({
    account: "fixture-account",
    postId: "fixture-post",
    csrf: () => "fixture-csrf",
    request: async <T>(_path: string, body?: unknown): Promise<T> => {
      if (body !== undefined) {
        writes++;
        throw new Error("unknown dispatch");
      }
      return { state: "none" } as T;
    },
  });
  await assert.rejects(port.ticket(), /confirm this take/);
  await assert.rejects(port.ticket(), /confirm this take/);
  assert.equal(writes, 1);
  port.dispose();
});

test("explicit budget refusal preserves refusal evidence and allows deliberate same-step retry", async () => {
  let writes = 0;
  const port = createOperatorKaraokePort({
    account: "fixture-account",
    postId: "fixture-post",
    csrf: () => "fixture-csrf",
    request: async <T>(_path: string, body?: unknown): Promise<T> => {
      if (body !== undefined) {
        writes++;
        throw new LearningServiceError(
          429,
          "speech_budget_exhausted",
          "Community limit",
          {
            stage: "endpoint_refusal",
            path: "/api/karaoke/tickets",
            method: "POST",
            endpointStatus: 429,
          },
        );
      }
      return { state: "none" } as T;
    },
  });
  await assert.rejects(port.ticket(), { code: "speech_budget_exhausted" });
  await assert.rejects(port.ticket(), { status: 429 });
  assert.equal(writes, 2);
  port.dispose();
});

test("disposing an in-flight ticket ignores its late identity and cannot start a new request", async () => {
  let resolve!: (value: unknown) => void;
  const port = createOperatorKaraokePort({
    account: "fixture-account",
    postId: "fixture-post",
    csrf: () => "fixture-csrf",
    request: <T>() =>
      new Promise<T>((done) => {
        resolve = done as (value: unknown) => void;
      }),
  });
  const pending = port.ticket();
  port.dispose();
  resolve(open);
  await assert.rejects(pending, /closed/);
  await assert.rejects(port.ticket(), /closed/);
});

test("ready readback retains the original live Study upload across reload and replacement audio", async () => {
  const initial = lesson(),
    originalAttempt = attempt(initial);
  let saved: StudyLesson = {
      ...initial,
      current: { ...initial.current!, attempt: originalAttempt },
    },
    finishOriginal!: () => void,
    opens = 0,
    uploads = 0;
  const original = input(initial);
  const server = new Promise<void>((resolve) => {
    finishOriginal = resolve;
  }).then(() => {
    saved = {
      ...initial,
      status: "completed",
      current: null,
      completedAt: 200,
      lastAttempt: {
        ...originalAttempt,
        state: "assessed",
        grade: {
          correct: true,
          matchKind: "exact",
          policyRevision: "script_aware_token_phonetic_v5",
        },
      },
      progress: { ...initial.progress, resolved: 4, firstPassCorrect: 3 },
    };
  });
  const port = createOperatorStudyingClient({
    ...client(initial),
    open: async () => {
      opens++;
      return { attempt: originalAttempt, lesson: initial };
    },
    submit: async (lessonId, attemptId, audio) => {
      uploads++;
      assert.equal(lessonId, initial.lessonId);
      assert.equal(attemptId, originalAttempt.attemptId);
      assert.equal(
        audio,
        original.type === "say_it_back" ? original.audio : null,
      );
      throw new Error("delivery unknown while original body still streams");
    },
    refresh: async () => saved,
  });
  await port.loadLesson("song");
  await assert.rejects(port.submitAttempt(original), {
    details: {
      reason_code: "study_provider_outcome_unknown",
      next_action: "operator_review",
    },
  });
  const held = await port.loadLesson("song");
  assert.equal(
    held.spoken_submission?.session_item_id,
    originalAttempt.line.lineId,
  );
  await assert.rejects(port.submitAttempt(input(initial)));
  assert.deepEqual([opens, uploads], [1, 1]);
  finishOriginal();
  await server;
  const resolved = await port.loadLesson("song");
  assert.deepEqual(resolved.exercises, []);
  assert.equal(resolved.correct_count, 3);
  assert.equal(resolved.spoken_submission, null);
  assert.deepEqual([opens, uploads], [1, 1]);
});

test("ready and malformed assessed results are uncertainty, never provider refusal", () => {
  const value = lesson();
  for (const state of ["ready", "assessed"] as const)
    assert.throws(
      () =>
        operatorStudyResult({ lesson: value, attempt: attempt(value, state) }),
      {
        details: {
          reason_code: "study_provider_outcome_unknown",
          next_action: "operator_review",
        },
      },
    );
});

test("a fresh adapter also holds an existing ready attempt across a full page reload", async () => {
  const value = lesson();
  value.current!.attempt = attempt(value, "ready");
  let opens = 0;
  const port = createOperatorStudyingClient({
    ...client(value),
    open: async () => {
      opens++;
      throw new Error("must not replace existing ready upload");
    },
  });
  const payload = await port.loadLesson("song");
  assert.equal(payload.spoken_submission?.state, "provider_outcome_unknown");
  await assert.rejects(port.submitAttempt(input(value)));
  assert.equal(opens, 0);
});
