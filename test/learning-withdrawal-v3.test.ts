// Turning public results off (the learner's signed V4 Revocation) closes every
// open Study lesson of the account in the community privately: V4 lessons,
// bound or not, and V3 lessons from before V4 became the learning records. It
// also stops the learner's V3 results not yet sent, so nothing more is
// published to V3, even after public results are turned back on. Actual
// community routes, D1, operator and local V3 and V4 contracts; the posts
// RPC, IPFS transport and speech provider are the fixture's simulations.
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
  studyPublicationFixtureV4,
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

/** Lessons of the fixture's learner, by request id. */
async function lessonByRequest(f: Fixture, requestId: string) {
  return (await f.db
    .prepare("SELECT lesson_id FROM study_lessons WHERE request_id=?")
    .bind(requestId)
    .first<{ lesson_id: string }>())!.lesson_id;
}
const bound = async (f: Fixture, id: string) =>
  !!(await f.db
    .prepare("SELECT 1 AS present FROM study_publications WHERE lesson_id=?")
    .bind(id)
    .first());
/** The lesson is closed as consent_ended and can never publish. */
async function closedPrivately(f: Fixture, id: string) {
  const closed = await lessonState(f.db, id);
  assert.equal(closed.status, "abandoned");
  assert.equal(closed.completionReason, "consent_ended");
  await f.mineClock();
  await resumeStudyPublications(f.operatorEnv, f.store);
  await communityScheduled(f.env, f.ports);
  const publication = await f.publication(id);
  assert.notEqual(publication.state, "published");
  assert.notEqual(publication.state, "pending");
  assert.deepEqual(f.store.entries("intent:record_result:"), []);
}
/** Wraps the operator binding; `after` runs once the operator answers. */
function aroundOperator(
  f: Fixture,
  path: string,
  options: { fail?: boolean; after?: () => Promise<void> },
) {
  const real = f.env.KARAOKE_OPERATOR as Fetcher;
  let fired = false;
  f.env.KARAOKE_OPERATOR = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      const matched = !fired && new URL(request.url).pathname === path;
      if (matched) fired = true;
      if (matched && options.fail) throw Error("fixture operator outage");
      const response = await real.fetch(request);
      if (matched && options.after) await options.after();
      return response;
    },
  } as Fetcher;
  return () => {
    f.env.KARAOKE_OPERATOR = real;
  };
}

test(
  "turning public results off closes a V4 lesson whose start failed after creating it",
  { timeout: 240000 },
  async () => {
    const f = await studyPublicationFixtureV4(19705);
    try {
      const requestId = crypto.randomUUID();
      const restore = aroundOperator(f, "/study/bind", { fail: true });
      const failed = await f.post(
        "/api/study/lessons",
        { requestId, song: f.song },
        f.auth,
      );
      restore();
      assert.notEqual(failed.status, 200);
      const id = await lessonByRequest(f, requestId);
      assert.equal((await lessonState(f.db, id)).status, "active");
      assert.equal(await bound(f, id), false);
      const offAt = f.clock();
      await turnOff(f, f.auth);
      assert.equal((await lessonState(f.db, id)).completedAt, offAt);
      // Retrying the same start never reopens or binds it.
      const retry = await f.post(
        "/api/study/lessons",
        { requestId, song: f.song },
        f.auth,
      );
      assert.equal(retry.status, 409);
      await closedPrivately(f, id);
      assert.equal(await bound(f, id), false);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a V4 binding that lands after the withdrawal finds its lesson closed; it never publishes",
  { timeout: 240000 },
  async () => {
    const f = await studyPublicationFixtureV4(19706);
    try {
      const requestId = crypto.randomUUID();
      // The operator binds the lesson; the turn-off completes before the
      // application stores that binding.
      const restore = aroundOperator(f, "/study/bind", {
        after: () => turnOff(f, f.auth),
      });
      const start = await f.post(
        "/api/study/lessons",
        { requestId, song: f.song },
        f.auth,
      );
      restore();
      assert.equal(start.status, 409, await start.clone().text());
      assert.equal(
        ((await start.json()) as { error: string }).error,
        "study_authorization_required",
      );
      const id = await lessonByRequest(f, requestId);
      assert.equal(await bound(f, id), true);
      await closedPrivately(f, id);
      const publication = await json<{
        state: string;
        receipt: { reason?: string } | null;
      }>(await f.post(lessonPath(id) + "/publication", {}, f.auth));
      assert.equal(publication.state, "private");
      assert.equal(publication.receipt!.reason, "unfinished");
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a withdrawal between a start's permission check and its new lesson closes that lesson at once",
  { timeout: 240000 },
  async () => {
    const f = await studyPublicationFixtureV4(19709);
    try {
      const requestId = crypto.randomUUID();
      const real = f.env.DB as D1Database;
      let hook: (() => Promise<void>) | undefined = () =>
        turnOff(f, f.auth);
      // The turn-off runs just before this start creates its lesson row.
      f.env.DB = new Proxy(real, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!hook || !sql.startsWith("INSERT INTO study_lessons("))
                return statement;
              return {
                bind: (...values: unknown[]) => {
                  const ready = statement.bind(...values);
                  return {
                    async run() {
                      const before = hook!;
                      hook = undefined;
                      await before();
                      return ready.run();
                    },
                  };
                },
              };
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const start = await f.post(
        "/api/study/lessons",
        { requestId, song: f.song },
        f.auth,
      );
      f.env.DB = real;
      assert.equal(hook, undefined);
      assert.equal(start.status, 409, await start.clone().text());
      const id = await lessonByRequest(f, requestId);
      await closedPrivately(f, id);
    } finally {
      await f.dispose();
    }
  },
);
