// A V4 community where a learner still has V3 Study work from before V4 became
// the learning records. Turning public results off (the learner's signed V4
// Revocation) closes every open lesson privately and stops the learner's V3
// results not yet sent, so nothing more is published to V3, even after
// public results are turned back on. Actual community routes, D1, operator and
// local V3 and V4 contracts; the posts RPC, IPFS transport and speech provider
// are the fixture's simulations.
import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash, type Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";
import { communityScheduled } from "../services/community-application.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { resumeStudyPublications } from "../services/study-publication-recovery.ts";
import { lessonState } from "./study-close-bound-fixture.ts";
import {
  json,
  lessonPath,
  studyPublicationFixture,
} from "./study-publication-fixture.ts";

type Fixture = Awaited<ReturnType<typeof studyPublicationFixture>>;
type Auth = Record<string, string>;

/** The release that makes V4 the community's learning records. */
async function becomeV4(f: Fixture) {
  const v4 = await f.evm.deploy("LearningResultsV4", [
    accounts[3].address,
    f.config.communityId,
    learningV4PublicityPolicy,
  ]);
  await f.evm.write(
    v4,
    "LearningResultsV4",
    "setGrader",
    [accounts[2].address, 2, true],
    3,
  );
  await f.applyV4Migration();
  f.operatorEnv.RESULTS_V4_CONTRACT = v4;
  (f.env as { STUDY_RESULTS_V4_CONTRACT?: string }).STUDY_RESULTS_V4_CONTRACT =
    v4;
  (f.config as { learningRecords: string }).learningRecords = v4.toLowerCase();
  return v4;
}
/** A V4 lesson; its first start relays the learner's sign-in. */
async function startV4(f: Fixture, auth: Auth) {
  for (let i = 0; i < 5; i++) {
    const response = await f.post(
      "/api/study/lessons",
      { requestId: crypto.randomUUID(), song: f.song },
      auth,
    );
    if (response.status === 200) return (await response.json()) as StudyLesson;
    await f.recordSignIns();
  }
  throw Error("V4 lesson did not start");
}
/** "Turn off public results" from settings: request, sign, relay. */
async function turnOff(f: Fixture, auth: Auth) {
  const request = await json<{ message: { learner: string; nonce: string } }>(
    await f.post("/api/learning/public-results/off", {}, auth),
  );
  const signature = await accounts[5].signTypedData(request as never);
  const off = await json<{ state: string; publicResults: string }>(
    await f.post(
      "/api/learning/public-results/off",
      { message: request.message, signature },
      auth,
    ),
  );
  assert.ok(off.state === "success" || off.state === "pending");
  assert.equal(off.publicResults, "off");
}
async function turnOn(f: Fixture, auth: Auth) {
  await json(await f.post("/api/learning/public-results/on", {}, auth));
}
async function sync(f: Fixture, id: string) {
  return json<{
    state: string;
    receipt: {
      state: string;
      sessionId: Hex;
      reason?: string;
      neverSubmitted?: boolean;
      transactionHash: Hex | null;
    } | null;
  }>(await f.post(lessonPath(id) + "/publication", {}, f.auth));
}
/** Fails only the operator's terminal path, leaving speech and binding. */
function holdTerminals(f: Fixture) {
  const real = f.env.KARAOKE_OPERATOR as Fetcher;
  f.env.KARAOKE_OPERATOR = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/study/terminal")
        throw Error("fixture terminal outage");
      return real.fetch(request);
    },
  } as Fetcher;
  return () => {
    f.env.KARAOKE_OPERATOR = real;
  };
}
async function complete(f: Fixture) {
  let lesson = await f.start();
  lesson = (await f.answer(lesson, false)).lesson;
  while (lesson.status === "active")
    lesson = (await f.answer(lesson, true)).lesson;
  assert.equal(lesson.status, "completed");
  return lesson;
}
/** No result transaction was ever queued for V3, and V3 holds no commitment. */
async function nothingOnV3(f: Fixture, sessions: Hex[]) {
  const toV3 = f.store
    .entries("intent:record_result:")
    .filter(
      ({ value }) =>
        (value as { to: string }).to.toLowerCase() === f.v3.toLowerCase(),
    );
  assert.deepEqual(toV3, []);
  for (const session of sessions)
    assert.equal(
      await f.evm.read(f.v3, "LearningResultsV3", "commitments", [session]),
      zeroHash,
    );
}
/** The operator's alarm and the community's scheduled job both run. */
async function sweep(f: Fixture) {
  await f.mineClock();
  await resumeStudyPublications(f.operatorEnv, f.store);
  await communityScheduled(f.env, f.ports);
  await resumeStudyPublications(f.operatorEnv, f.store);
}
async function privateWithdrawn(f: Fixture, id: string) {
  const publication = await sync(f, id);
  assert.equal(publication.state, "private");
  assert.equal(publication.receipt!.reason, "authorization_withdrawn");
  assert.equal(publication.receipt!.neverSubmitted, true);
  assert.equal(publication.receipt!.transactionHash, null);
  return publication.receipt!.sessionId;
}

test(
  "V3 lesson open, V4 becomes the records, sign in and start V4, turn off: the V3 lesson closes privately and nothing publishes to V3, even after turn-on",
  { timeout: 240000 },
  async () => {
    const f = await studyPublicationFixture(19702);
    try {
      // 1. A V3 lesson is open under the learner's V3 enrollment.
      let old = await f.start();
      old = (await f.answer(old, false)).lesson;
      assert.equal(old.status, "active");
      // 2. V4 becomes the records.
      await becomeV4(f);
      // 3. Sign in (the V4 permission), start a V4 lesson, turn off.
      const auth = await f.login();
      const fresh = await startV4(f, auth);
      const offAt = f.clock();
      await turnOff(f, auth);
      for (const id of [old.lessonId, fresh.lessonId]) {
        const closed = await lessonState(f.db, id);
        assert.equal(closed.status, "abandoned");
        assert.equal(closed.completionReason, "consent_ended");
        assert.equal(closed.completedAt, offAt);
      }
      // The V3 lesson cannot continue, and stays private.
      const view = await json<StudyLesson>(
        await f.call(lessonPath(old.lessonId), { headers: auth }),
      );
      assert.equal(view.status, "abandoned");
      const session = await privateWithdrawn(f, old.lessonId);
      await sweep(f);
      await nothingOnV3(f, [session]);
      // Turning public results back on never resumes V3 publication.
      await turnOn(f, auth);
      const again = await f.login();
      await startV4(f, again);
      await sweep(f);
      assert.equal((await sync(f, old.lessonId)).state, "private");
      await nothingOnV3(f, [session]);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "V3 results queued but not yet sent, in the application or at the operator, stay private after the V4 turn-off",
  { timeout: 240000 },
  async () => {
    const f = await studyPublicationFixture(19703);
    try {
      // Queued in the application: completed while the operator's terminal
      // path was down, so the operator has never seen it.
      const release = holdTerminals(f);
      const queued = await complete(f);
      release();
      const row = await f.db
        .prepare(
          "SELECT state,terminal_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(queued.lessonId)
        .first<{ state: string; terminal_json: string | null }>();
      assert.equal(row!.state, "pending");
      assert.ok(row!.terminal_json);
      assert.equal(
        f.store.get(`studyPublication:${queued.lessonId}`),
        undefined,
      );
      // Queued at the operator: completed ahead of chain time, so the
      // operator holds it unsent.
      f.advance(3600_000);
      const held = await complete(f);
      const job = f.store.get<{ receipt: { state: string } }>(
        `studyPublication:${held.lessonId}`,
      );
      assert.equal(job!.receipt.state, "pending");
      assert.deepEqual(f.store.entries("intent:record_result:"), []);
      // V4 becomes the records; the learner signs in and turns public
      // results off, with no V4 lesson started.
      await becomeV4(f);
      const auth = await f.login();
      await turnOff(f, auth);
      await sweep(f);
      const sessions = [
        await privateWithdrawn(f, queued.lessonId),
        await privateWithdrawn(f, held.lessonId),
      ];
      await sweep(f);
      await nothingOnV3(f, sessions);
      await turnOn(f, auth);
      await sweep(f);
      await nothingOnV3(f, sessions);
    } finally {
      await f.dispose();
    }
  },
);
