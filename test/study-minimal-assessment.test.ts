import test from "node:test";
import assert from "node:assert/strict";
import { sha256, type Hex } from "viem";
import { createLyrics } from "../packages/community/lyric-manifest.ts";
import { digest } from "../packages/protocol/index.ts";
import { studyExercisesHash } from "../packages/protocol/learning-results-v3.ts";
import { STUDY_LESSON_NO_DEADLINE } from "../packages/study/lesson.ts";
import {
  gradeStudySpeech,
  reduceStudyGrade,
  minimalStudyGrade,
} from "../packages/study/assessment.ts";
import { studySourceSelection } from "../packages/study/public-source.ts";
import type { AdmittedStudyGrader } from "../packages/study/grader-revision.ts";
import type { StudySpeechJob } from "../services/study-speech-receipt.ts";
import {
  completeStudySpeech,
  recoverStudySpeech,
} from "../services/study-speech-receipt.ts";
import { dispatchStudySpeech } from "../services/study-speech-dispatch.ts";
import { privateStudySource } from "../services/study-private-assessment.ts";
import { reserveCommunitySpeech } from "../services/study-speech-reservation.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";

function fixture(
  policy: AdmittedStudyGrader = "script_aware_token_phonetic_v4",
) {
  const f = speechRepairFixture();
  const source = createLyrics(
    {
      chainId: 6343,
      postsContract: `0x${"11".repeat(20)}`,
      communityId: f.policy.communityId as Hex,
      postId: digest("minimal-song"),
    },
    "I'm going home\nNever let me go\nStay with me\nBring the morning home",
    "en",
  );
  const selected = studySourceSelection(source, [1, 2, 3, 4]);
  const offer = {
    lessonId: "minimal_lesson_fixture_0001",
    learner: `0x${"22".repeat(20)}` as Hex,
    sourceDigest: selected.hash as Hex,
    startedAt: f.store.now() * 1000,
    expiresAt: STUDY_LESSON_NO_DEADLINE,
    authorizationId: digest("original-v4"),
    speechChannel: "telegram-linked" as const,
    privateSpeechSource: source,
    ...(policy === "script_aware_token_phonetic_v5"
      ? { graderRevision: policy }
      : {}),
    exercises: selected.selected.map((line, i) => ({
      ordinal: i + 1,
      lineId: line.lineId as Hex,
      language: line.language,
    })),
  };
  const target = {
    version: 4 as const,
    chainId: 6343 as const,
    contract: `0x${"44".repeat(20)}` as Hex,
  };
  const binding = {
    offer,
    offerHash: digest(offer),
    exercisesHash: studyExercisesHash([1, 2, 3, 4]),
    target,
    authorization: {
      id: offer.authorizationId,
      issuedAt: f.store.now() - 1,
      target,
    },
  };
  const bytes = new Uint8Array([1, 2, 3]);
  const parameters = {
    lessonId: offer.lessonId,
    attemptId: "minimal_attempt_fixture_0001",
    lineId: selected.selected[0].lineId as Hex,
    presentationNumber: 1,
    takeNumber: 1,
    contentType: "audio/webm",
    durationMs: 1000,
  };
  const key = "studySpeech:" + parameters.attemptId;
  const job: StudySpeechJob = {
    bindingHash: binding.offerHash,
    requestHash: digest("minimal-request"),
    audioDigest: sha256(bytes),
    parameters,
    receipt: { state: "assessing", error: "speech_pending" },
    expiresAt: f.store.now() + 3600,
    channel: "telegram-linked",
  };
  f.store.set("studyBinding:" + offer.lessonId, binding);
  f.store.set(key, job);
  return {
    ...f,
    source,
    selected,
    offer,
    binding,
    bytes,
    parameters,
    key,
    job,
  };
}
const secret = "private transcript sentinel that must never enter the journal";

test("original linked dispatch grades once and stores/returns only assessment facts with exact billing evidence", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const raw = {
      state: "assessed" as const,
      transcript: { text: secret, language: "en" },
    };
    const expected = reduceStudyGrade(
      gradeStudySpeech(
        f.selected.selected[0],
        raw.transcript,
        "script_aware_token_phonetic_v4",
        1,
      ),
    );
    const realSet = f.store.set;
    f.store.set = (key, value) => {
      assert.ok(
        !JSON.stringify(value).includes(secret),
        "raw private content crossed Store.set",
      );
      realSet(key, value);
    };
    const receipt = await dispatchStudySpeech({
      env: f.env,
      store: f.store,
      parameters: f.parameters,
      key: f.key,
      requestHash: f.job.requestHash,
      bodyHash: f.job.audioDigest,
      expiresAtMs: STUDY_LESSON_NO_DEADLINE,
      channel: "telegram-linked",
      audio: f.bytes,
      contentType: "audio/webm",
      language: "en",
      provider: {
        providerRetention: "stored",
        async transcribe() {
          calls++;
          return raw.transcript;
        },
      },
    });
    assert.deepEqual(receipt, { state: "assessed", grade: expected });
    assert.equal(calls, 1);
    const saved = f.store.get<StudySpeechJob>(f.key)!;
    assert.equal(saved.completionEvidence, digest(raw));
    assert.equal(f.resolutions.at(-1)?.evidenceDigest, digest(raw));
    assert.equal(f.resolutions.at(-1)?.state, "succeeded");
    assert.doesNotMatch(
      JSON.stringify(saved),
      /heardTranscript|"transcript"|"matched"|"missing"/,
    );
    assert.deepEqual(
      completeStudySpeech(f.store, f.key, f.job.requestHash, {
        state: "assessed",
        transcript: { text: "another private losing response", language: "en" },
      })?.receipt,
      receipt,
    );
    assert.equal(
      f.store.get<StudySpeechJob>(f.key)?.completionEvidence,
      digest(raw),
    );
  } finally {
    f.close();
  }
});

test("read-only provider recovery and legacy terminal reduction use the same minimal winner and never redispatch", async () => {
  const f = fixture("script_aware_token_phonetic_v5");
  try {
    await reserveCommunitySpeech(
      f.env,
      "telegram-linked",
      "study:" + f.parameters.attemptId,
      f.job.audioDigest,
    );
    let reads = 0,
      dispatches = 0;
    const raw = {
      state: "assessed" as const,
      transcript: {
        text: "I'm goin' home",
        language: "en",
        languageConfidence: 1,
      },
    };
    const provider = {
      providerRetention: "stored" as const,
      async transcribe() {
        dispatches++;
        throw Error("redispatch forbidden");
      },
      async recover() {
        reads++;
        return raw;
      },
    };
    const recovered = await recoverStudySpeech(
      f.env,
      f.store,
      f.key,
      f.job,
      provider,
    );
    assert.deepEqual(recovered.receipt, {
      state: "assessed",
      grade: reduceStudyGrade(
        gradeStudySpeech(
          f.selected.selected[0],
          raw.transcript,
          "script_aware_token_phonetic_v5",
          1,
        ),
      ),
    });
    assert.equal(recovered.completionEvidence, digest(raw));
    await recoverStudySpeech(f.env, f.store, f.key, f.job, provider);
    assert.equal(reads, 1);
    assert.equal(dispatches, 0);
    assert.equal(f.resolutions.at(-1)?.evidenceDigest, digest(raw));
    // Explicit prior-version fixture: raw terminal data is reduced on read
    // while its original accounting evidence remains the same.
    f.store.set(f.key, { ...f.job, receipt: raw });
    const reduced = await recoverStudySpeech(f.env, f.store, f.key, {
      ...f.job,
      receipt: raw,
    });
    assert.deepEqual(reduced.receipt, recovered.receipt);
    assert.equal(reduced.completionEvidence, digest(raw));
    assert.doesNotMatch(
      JSON.stringify(f.store.get(f.key)),
      /heardTranscript|"transcript"/,
    );
  } finally {
    f.close();
  }
});

test("linked assessment source and minimal result are exact; missing original source cannot disclose a legacy transcript", () => {
  const f = fixture();
  try {
    assert.equal(privateStudySource(f.offer).hash, f.offer.sourceDigest);
    assert.throws(
      () => privateStudySource({ ...f.offer, sourceDigest: digest("changed") }),
      /source_changed/,
    );
    assert.throws(
      () =>
        minimalStudyGrade({
          correct: false,
          matchKind: "none",
          policyRevision: "script_aware_token_phonetic_v4",
          heardTranscript: secret,
        }),
      /minimal_grade_invalid/,
    );
    const { privateSpeechSource: _source, ...offer } = f.offer;
    const hash = digest(offer);
    f.store.set("studyBinding:" + offer.lessonId, {
      ...f.binding,
      offer,
      offerHash: hash,
    });
    const raw = {
      state: "assessed" as const,
      transcript: { text: secret, language: "en" },
    };
    f.store.set(f.key, { ...f.job, bindingHash: hash, receipt: raw });
    assert.throws(
      () => completeStudySpeech(f.store, f.key, f.job.requestHash, raw),
      /private_grading_source_required/,
    );
    assert.equal(f.store.get<StudySpeechJob>(f.key)?.receipt.state, "assessed");
    assert.equal(f.resolutions.length, 0);
  } finally {
    f.close();
  }
});
