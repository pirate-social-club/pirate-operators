// A new lesson has no learner time limit. It can continue only while the
// publication consent it was bound to is live; at that consent's last second
// it closes privately, and the ordinary thirty-day erasure follows.
import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";
import { accounts } from "../harness/runtime.ts";
import {
  studyPublicationFixture,
  lessonPath,
} from "./study-publication-fixture.ts";
import { closeBoundOf, lessonState } from "./study-close-bound-fixture.ts";
import { communityScheduled } from "../services/community-application.ts";
import { deleteExpiredStudyHistory } from "../services/study-retention.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";
import {
  acceptRevocation,
  revocationRequest,
} from "../services/learning-enrollment.ts";
import { resultsTarget } from "../services/learning-contract.ts";
import { revocationTypes } from "../packages/protocol/learning-results-v3.ts";
import { STUDY_LESSON_NO_DEADLINE } from "../packages/study/lesson.ts";

type Fixture = Awaited<ReturnType<typeof studyPublicationFixture>>;
async function revoke(f: Fixture) {
  const target = resultsTarget(f.operatorEnv, 3);
  const request = await revocationRequest(
    f.operatorEnv,
    accounts[5].address,
    target,
  );
  const message = {
    learner: accounts[5].address,
    nonce: BigInt(request.message.nonce),
  };
  await acceptRevocation(
    f.operatorEnv,
    f.store,
    accounts[5].address,
    message.nonce,
    await accounts[5].signTypedData({
      domain: request.domain,
      primaryType: "Revocation",
      types: revocationTypes,
      message,
    }),
    target,
  );
}
async function attemptsOf(f: Fixture, id: string) {
  return (await f.db
    .prepare("SELECT count(*) AS n FROM study_attempts WHERE lesson_id=?")
    .bind(id)
    .first<{ n: number }>())!.n;
}
// Sessions last thirty days, like consent, so reads after the bound sign in again.
async function publicationAfter(f: Fixture, id: string) {
  const response = await f.call(lessonPath(id) + "/publication", {
    headers: await f.login(),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    state: string;
    receipt: {
      state: string;
      reason?: string;
      sessionId: `0x${string}`;
    } | null;
  };
}
async function erasedAt(f: Fixture, id: string) {
  return (await f.db
    .prepare("SELECT history_deleted_at FROM study_lessons WHERE lesson_id=?")
    .bind(id)
    .first<{ history_deleted_at: number | null }>())!.history_deleted_at;
}

test(
  "a new lesson whose bound consent ends closes at its last second, stays private and is erased after thirty days",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19950);
    try {
      let lesson = await f.start();
      assert.equal(lesson.expiresAt, STUDY_LESSON_NO_DEADLINE);
      lesson = (await f.answer(lesson, false)).lesson;
      const bound = await closeBoundOf(f.db, lesson.lessonId);
      assert.equal(bound.reason, "consent_ended");
      // Hours later, well inside consent (this fixture signs one day), the
      // lesson simply resumes.
      f.advance(Math.floor((bound.at - f.clock()) / 2));
      await f.mineClock();
      await communityScheduled(f.env, f.ports);
      assert.equal((await f.get(lesson.lessonId)).status, "active");
      const txs = f.store.entries("tx:").length,
        counts = f.counts();
      f.advance(bound.at - f.clock() + 1);
      await f.mineClock();
      await communityScheduled(f.env, f.ports);
      const closed = await lessonState(f.db, lesson.lessonId);
      assert.equal(closed.status, "abandoned");
      assert.equal(closed.completionReason, "consent_ended");
      assert.equal(closed.completedAt, bound.at);
      const receipt = (await publicationAfter(f, lesson.lessonId)).receipt!;
      assert.equal(receipt.state, "private");
      assert.equal(receipt.reason, "enrollment_inactive");
      assert.equal(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          receipt.sessionId,
        ]),
        zeroHash,
      );
      assert.equal(f.store.entries("tx:").length, txs);
      assert.deepEqual(f.counts(), counts);
      // Ordinary retention: the private copy is kept for the export window.
      f.advance(bound.at + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock() - 1);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        0,
      );
      assert.ok((await attemptsOf(f, lesson.lessonId)) > 0);
      f.advance(2);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      assert.equal(await erasedAt(f, lesson.lessonId), f.clock());
      assert.equal(await attemptsOf(f, lesson.lessonId), 0);
      assert.equal(f.store.entries("tx:").length, txs);
      assert.deepEqual(f.counts(), counts);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "consent revoked mid-lesson is a known refusal with no speech or publication; the lesson closes privately and is erased",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19951);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      const bound = await closeBoundOf(f.db, lesson.lessonId);
      await revoke(f);
      const txs = f.store.entries("tx:").length,
        counts = f.counts();
      // The operator refuses speech for revoked consent before any slot or
      // provider dispatch. The application records a known refusal and closes
      // the lesson at once, inside the bound consent's window, so the learner
      // sees it ended and is not left blocked until the consent's end date.
      const refusedAt = f.clock();
      const refused = await f.answer(lesson, true);
      assert.equal(refused.attempt.state, "unavailable");
      assert.equal(
        (refused.attempt as { failure?: string }).failure,
        "enrollment_required",
      );
      assert.equal(refused.lesson.status, "abandoned");
      assert.equal(refused.lesson.completionReason, "consent_ended");
      assert.ok(refused.lesson.completedAt! >= refusedAt);
      assert.ok(refused.lesson.completedAt! < bound.at);
      assert.equal(refused.lesson.progress.firstPassGraded, 1);
      assert.deepEqual(f.counts(), counts);
      const closed = await lessonState(f.db, lesson.lessonId);
      assert.equal(closed.status, "abandoned");
      assert.deepEqual(closed.terminalAbsences, [
        null,
        ...closed.terminalAbsences!.slice(1),
      ]);
      const receipt = (await publicationAfter(f, lesson.lessonId)).receipt!;
      assert.equal(receipt.state, "private");
      assert.equal(receipt.reason, "enrollment_inactive");
      assert.equal(f.store.entries("tx:").length, txs);
      // Ordinary retention runs from the recorded completion time.
      const completedAt = closed.completedAt!;
      f.advance(completedAt + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock() - 1);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        0,
      );
      f.advance(2);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      assert.equal(await erasedAt(f, lesson.lessonId), f.clock());
      assert.equal(await attemptsOf(f, lesson.lessonId), 0);
      assert.equal(f.store.entries("tx:").length, txs);
      assert.deepEqual(f.counts(), counts);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "an open new lesson exports its history until its bound plus thirty days, then 410",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19952);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      const bound = await closeBoundOf(f.db, lesson.lessonId);
      const history = async () =>
        f.post(lessonPath(lesson.lessonId) + "/history", {}, await f.login());
      const open = (await (await history()).json()) as {
        exportAvailableUntil: number;
        lesson: { state: { status: string } };
        attempts: unknown[];
      };
      assert.equal(open.lesson.state.status, "active");
      assert.equal(open.attempts.length, 1);
      assert.ok(open.exportAvailableUntil > f.clock());
      // No reader closes the lesson; the export window still follows the bound.
      f.advance(bound.at + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock() - 1);
      const last = await history();
      assert.equal(last.status, 200);
      assert.equal(
        ((await last.json()) as { exportAvailableUntil: number })
          .exportAvailableUntil,
        bound.at + STUDY_HISTORY_EXPORT_WINDOW_MS,
      );
      f.advance(1);
      assert.equal((await history()).status, 410);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "retention closes and erases a bound lesson thirty days after start even when its consent ends far later",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixture(19956);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      // A consent end the application never requests, past 2^53 when in ms.
      await f.db
        .prepare(
          "UPDATE study_publications SET binding_json=json_set(binding_json,'$.enrollment.expiresAt',?) WHERE lesson_id=?",
        )
        .bind(2 ** 60, lesson.lessonId)
        .run();
      const at = lesson.startedAt + 30 * 86400000;
      f.advance(at + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock() - 1);
      // Due by SQL only at the limit plus the export window.
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        0,
      );
      assert.equal((await lessonState(f.db, lesson.lessonId)).status, "active");
      f.advance(2);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      assert.equal(await erasedAt(f, lesson.lessonId), f.clock());
      assert.equal(await attemptsOf(f, lesson.lessonId), 0);
    } finally {
      await f.dispose();
    }
  },
);
