// V4 Study: the learner's sign-in is the publication permission. Actual
// community routes, D1, operator and a local LearningResultsV4 contract; the
// posts RPC, IPFS transport and speech provider are the fixture's simulations.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, zeroHash, type Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV4Abi,
  signInIdV4,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import type { SignInChallenge } from "../packages/community/accounts.ts";
import {
  STUDY_LESSON_NO_DEADLINE,
  STUDY_OPEN_LESSON_MAX_MS,
  studyCloseBound,
} from "../packages/study/lesson.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import type { StudyLessonOfferV4 } from "../packages/study/operator-contract.ts";
import { communityScheduled } from "../services/community-application.ts";
import { acceptAuthorization } from "../services/learning-authorization.ts";
import { intentOf } from "../services/operator-tx.ts";
import { bindManagedStudy } from "../services/study-operator-client.ts";
import {
  studyBinding,
  type StudyAuthorizationBinding,
} from "../services/study-operator.ts";
import { closedStudyPublication } from "../services/study-private-publication.ts";
import { resumeStudyPublications } from "../services/study-publication-recovery.ts";
import { deleteExpiredStudyHistory } from "../services/study-retention.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";
import {
  STUDY_CLOSE_BOUND_SQL,
  studyCloseBoundBinds,
} from "../services/study-lessons.ts";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import {
  json,
  lessonPath,
  studyPublicationFixture,
  studyPublicationFixtureV4,
} from "./study-publication-fixture.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { lessonState } from "./study-close-bound-fixture.ts";
import type { StudyLesson, StudySong } from "../packages/study/lesson.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";

type Fixture = Awaited<ReturnType<typeof studyPublicationFixtureV4>>;

/** The learner's authorizations as the application recorded them. */
async function recorded(f: { db: D1Database }, learner = 5) {
  return (
    await f.db
      .prepare(
        "SELECT authorization_id,issued_at,state FROM learning_authorizations WHERE subject=? ORDER BY issued_at",
      )
      .bind(accounts[learner].address.toLowerCase())
      .all<{ authorization_id: Hex; issued_at: number; state: string }>()
  ).results;
}
const v4Binding = (f: Fixture, id: string) =>
  studyBinding(f.store, id) as StudyAuthorizationBinding;
/** A sign-in made through the application's challenge, relayed directly. */
async function signInOnChain(f: Fixture, learner: number) {
  const challenge = (await (
    await f.post("/api/auth/challenge", { address: accounts[learner].address })
  ).json()) as SignInChallenge;
  assert.equal(challenge.kind, "sign-in-v4");
  const message: SignIn = {
    ...challenge.typedData.message,
    issuedAt: BigInt(challenge.typedData.message.issuedAt),
    expiresAt: BigInt(challenge.typedData.message.expiresAt),
  };
  const signature = await accounts[learner].signTypedData({
    ...challenge.typedData,
    message: challenge.typedData.message as never,
  });
  let receipt = await acceptAuthorization(
    f.operatorEnv,
    f.store,
    message,
    signature,
  );
  for (let i = 0; i < 3 && receipt.state !== "success"; i++)
    receipt = await acceptAuthorization(
      f.operatorEnv,
      f.store,
      message,
      signature,
    );
  assert.equal(receipt.state, "success");
  return { id: signInIdV4(31337, f.v4, message), message };
}
const revokeOnChain = (f: Fixture, learner = 5) =>
  f.evm.write(
    f.v4,
    "LearningResultsV4",
    "revoke",
    [accounts[learner].address, 0n, "0x"],
    learner,
  );
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
async function publicationRow(f: Fixture, id: string) {
  return (await f.db
    .prepare(
      "SELECT state,binding_json,source_json,terminal_json,receipt_json FROM study_publications WHERE lesson_id=?",
    )
    .bind(id)
    .first<{
      state: string;
      binding_json: string;
      source_json: string;
      terminal_json: string | null;
      receipt_json: string | null;
    }>())!;
}
async function sync(f: Fixture, id: string) {
  return json<{
    state: string;
    receipt: {
      state: string;
      reason?: string;
      neverSubmitted?: boolean;
    } | null;
  }>(await f.post(lessonPath(id) + "/publication", {}, f.auth));
}
const resultIntent = (f: Fixture, id: string) =>
  intentOf(f.store, "record_result", "study:" + id + ":1");
async function complete(f: Fixture) {
  let lesson = await f.start();
  lesson = (await f.answer(lesson, false)).lesson;
  while (lesson.status === "active")
    lesson = (await f.answer(lesson, true)).lesson;
  assert.equal(lesson.status, "completed");
  return lesson;
}
/** Erases a closed lesson's private history once the export window passes. */
async function eraseOnSchedule(f: Fixture, lesson: StudyLesson) {
  const closed = await lessonState(f.db, lesson.lessonId);
  f.advance(
    closed.completedAt! + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock() - 1,
  );
  assert.equal(
    await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
    0,
  );
  f.advance(2);
  assert.equal(
    await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
    1,
  );
  await communityScheduled(f.env, f.ports);
  // The operator's own alarm erases its copy with a fresh never-sent proof.
  await resumeStudyPublications(f.operatorEnv, f.store);
  const row = await publicationRow(f, lesson.lessonId);
  assert.equal(row.state, "private");
  assert.equal(row.binding_json, "{}");
  assert.equal(row.source_json, "{}");
  assert.equal(row.terminal_json, null);
  const receipt = JSON.parse(row.receipt_json!);
  assert.equal(receipt.reason, "private_history_expired");
  assert.equal(receipt.neverSubmitted, true);
  assert.equal(receipt.privateHistoryErased, true);
  assert.equal(receipt.commitment, zeroHash);
  assert.equal(studyBinding(f.store, lesson.lessonId), undefined);
  assert.equal(
    closedStudyPublication(f.store, lesson.lessonId)!.receipt
      .privateHistoryErased,
    true,
  );
  assert.equal(
    (await f.db
      .prepare("SELECT count(*) AS n FROM study_attempts WHERE lesson_id=?")
      .bind(lesson.lessonId)
      .first<{ n: number }>())!.n,
    0,
  );
}

test(
  "a V4 lesson binds the recorded sign-in and a completed lesson publishes on chain as version 4",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixtureV4(19981);
    try {
      const [signIn] = await recorded(f);
      assert.equal(signIn.state, "recorded");
      // The footer links this V4 community's learning documents.
      assert.deepEqual(
        (await json<Record<string, unknown>>(await f.call("/api/capabilities")))
          .learningPolicy,
        {
          version: 4,
          termsUrl: "/learning/v4/terms",
          privacyUrl: "/learning/v4/privacy",
        },
      );
      const lesson = await complete(f);
      const binding = v4Binding(f, lesson.lessonId);
      assert.equal(binding.target.version, 4);
      assert.equal(binding.target.contract, f.v4.toLowerCase());
      assert.equal(binding.enrollment, undefined);
      assert.equal(binding.offer.authorizationId, signIn.authorization_id);
      assert.equal(binding.offer.expiresAt, STUDY_LESSON_NO_DEADLINE);
      assert.deepEqual(binding.authorization, {
        id: signIn.authorization_id,
        issuedAt: signIn.issued_at,
        target: binding.target,
      });
      const saved = JSON.parse(
        (await publicationRow(f, lesson.lessonId)).binding_json,
      );
      assert.deepEqual(saved, binding);
      const published = await f.publication(lesson.lessonId);
      assert.equal(published.state, "published", JSON.stringify(published));
      const receipt = published.receipt!;
      assert.equal(receipt.contract.toLowerCase(), f.v4.toLowerCase());
      assert.equal(
        receipt.sessionId,
        digest({
          schema: "pirate.study-result-id/1",
          enrollmentId: signIn.authorization_id,
          lessonId: lesson.lessonId,
        }),
      );
      const intent = resultIntent(f, lesson.lessonId)!;
      assert.equal(intent.to.toLowerCase(), f.v4.toLowerCase());
      const decoded = decodeFunctionData({
        abi: resultsV4Abi,
        data: intent.data,
      });
      assert.equal(decoded.functionName, "publish");
      if (decoded.functionName !== "publish") throw Error("expected publish");
      assert.equal(decoded.args[0].enrollmentId, signIn.authorization_id);
      assert.equal(decoded.args[0].status, 1);
      const evidence = await f.readResults();
      assert.equal(evidence.length, 1);
      assert.equal(
        evidence[0].verified,
        true,
        JSON.stringify(evidence[0].problems),
      );
      assert.equal(evidence[0].commitment, receipt.commitment);
      assert.equal(evidence[0].result.enrollmentId, signIn.authorization_id);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "Study start waits while the sign-in is being recorded, then starts the same request",
  { timeout: 120000 },
  async () => {
    const f = await studyCommunityFixture(19982, { v4: true });
    try {
      f.authorizationDown(true);
      const auth = await f.login();
      const [pending] = await recorded(f);
      assert.equal(pending.state, "pending");
      const song = await json<StudySong>(
        await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
          headers: auth,
        }),
      );
      const requestId = crypto.randomUUID();
      const refused = await f.post(
        "/api/study/lessons",
        { requestId, song },
        auth,
      );
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), {
        error: "study_authorization_pending",
      });
      // Refused before any lesson, binding or operator work.
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) AS n FROM study_lessons")
          .first<{ n: number }>())!.n,
        0,
      );
      assert.equal(f.store.entries("studyBinding:").length, 0);
      f.authorizationDown(false);
      for (let i = 0; i < 3 && (await recorded(f))[0].state !== "recorded"; i++)
        await f.recordSignIns();
      assert.equal((await recorded(f))[0].state, "recorded");
      const lesson = await json<StudyLesson>(
        await f.post("/api/study/lessons", { requestId, song }, auth),
      );
      assert.equal(lesson.status, "active");
      const binding = studyBinding(
        f.store,
        lesson.lessonId,
      ) as StudyAuthorizationBinding;
      assert.equal(binding.authorization.id, pending.authorization_id);
      // A session with no sign-in authorization is refused, not left pending.
      await f.db
        .prepare("UPDATE learning_authorizations SET state='refused'")
        .run();
      const none = await f.post(
        "/api/study/lessons",
        { requestId: crypto.randomUUID(), song },
        auth,
      );
      assert.equal(none.status, 409);
      assert.deepEqual(await none.json(), {
        error: "study_authorization_required",
      });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a later sign-in never interrupts or strands a lesson started under an earlier one",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixtureV4(19983);
    try {
      const [first] = await recorded(f);
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      f.advance(60000);
      await f.mineClock();
      const later = await signInOnChain(f, 5);
      assert.notEqual(later.id, first.authorization_id);
      assert.ok(Number(later.message.issuedAt) > first.issued_at);
      // Permission still starts at the first sign-in.
      assert.equal(
        await f.evm.publicClient.readContract({
          address: f.v4,
          abi: resultsV4Abi,
          functionName: "authorizedSince",
          args: [accounts[5].address],
        }),
        BigInt(first.issued_at),
      );
      const before = f.counts().calls;
      while (lesson.status === "active")
        lesson = (await f.answer(lesson, true)).lesson;
      assert.equal(lesson.status, "completed");
      assert.ok(f.counts().calls > before);
      const published = await f.publication(lesson.lessonId);
      assert.equal(published.state, "published", JSON.stringify(published));
      const evidence = await f.readResults();
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].verified, true);
      assert.equal(evidence[0].result.enrollmentId, first.authorization_id);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "an abandoned V4 lesson stays private as unfinished, is never sent, and is erased on schedule",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixtureV4(19984);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, true)).lesson;
      const ledger = f.store.get<{ spent: string; reserved: string }>(
        "sponsor:ledger",
      )!;
      lesson = await f.abandon(lesson.lessonId);
      assert.equal(lesson.status, "abandoned");
      assert.equal(lesson.completionReason, "left");
      const view = await f.publication(lesson.lessonId);
      assert.equal(view.state, "private");
      assert.equal(view.receipt!.reason, "unfinished");
      assert.equal(view.receipt!.neverSubmitted, true);
      assert.equal(view.receipt!.transactionHash, null);
      assert.equal(resultIntent(f, lesson.lessonId), undefined);
      assert.equal(f.store.entries("tx:").length, 1); // The sign-in only.
      for (const revision of [1, 2])
        assert.equal(
          f.store.get<{ state: string }>(
            `sponsor:reservation:record_result:study:${lesson.lessonId}:${revision}`,
          )?.state,
          "released",
        );
      // Nothing was spent; both result reservations were returned.
      const after = f.store.get<{ spent: string; reserved: string }>(
        "sponsor:ledger",
      )!;
      assert.equal(after.spent, ledger.spent);
      assert.ok(BigInt(after.reserved) < BigInt(ledger.reserved));
      assert.equal(after.reserved, "0");
      await eraseOnSchedule(f, lesson);
      assert.equal(f.store.entries("tx:").length, 1);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "turning public results off closes the open V4 lesson at once as consent_ended; it stays private and is erased on schedule",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixtureV4(19990);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, true)).lesson;
      assert.equal(lesson.status, "active");
      await f.mineClock();
      // "Turn off public results" from settings: request, sign, relay.
      const request = await json<{
        primaryType: string;
        message: { learner: string; nonce: string };
      }>(await f.post("/api/learning/public-results/off", {}, f.auth));
      assert.equal(request.primaryType, "Revocation");
      const signature = await accounts[5].signTypedData(request as never);
      const calls = f.counts().calls;
      const offAt = f.clock();
      const off = await json<{ state: string; publicResults: string }>(
        await f.post(
          "/api/learning/public-results/off",
          { message: request.message, signature },
          f.auth,
        ),
      );
      assert.ok(off.state === "success" || off.state === "pending");
      assert.equal(off.publicResults, "off");
      // Closed at once, at the withdrawal's time, with no further recording
      // and no speech call.
      const closed = await lessonState(f.db, lesson.lessonId);
      assert.equal(closed.status, "abandoned");
      assert.equal(closed.completionReason, "consent_ended");
      assert.equal(closed.completedAt, offAt);
      assert.equal(f.counts().calls, calls);
      const view = await json<StudyLesson>(
        await f.call(lessonPath(lesson.lessonId), { headers: f.auth }),
      );
      assert.equal(view.status, "abandoned");
      assert.equal(view.completionReason, "consent_ended");
      // The private result stays unpublished: never sent, nothing reserved.
      const publication = await sync(f, lesson.lessonId);
      assert.equal(publication.state, "private");
      assert.equal(publication.receipt!.reason, "unfinished");
      assert.equal(publication.receipt!.neverSubmitted, true);
      assert.equal(resultIntent(f, lesson.lessonId), undefined);
      // A repeated request closes nothing more.
      const again = await f.post(
        "/api/learning/public-results/off",
        { message: request.message, signature },
        f.auth,
      );
      assert.equal(again.status, 200, await again.clone().text());
      assert.equal((await lessonState(f.db, lesson.lessonId)).completedAt, offAt);
      await eraseOnSchedule(f, view);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "an open V4 lesson closes at the open limit, the SQL bound agrees, and it stays private and is erased",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixtureV4(19985);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      const owner = {
        accountId: (await f.db
          .prepare("SELECT account_id FROM study_lessons WHERE lesson_id=?")
          .bind(lesson.lessonId)
          .first<{ account_id: string }>())!.account_id,
        communityId: f.config.communityId,
      };
      // No consent end: the bound is thirty days after the start.
      const consent = await new StudyLessonStore(f.db).consentExpiry(
        owner,
        lesson.lessonId,
      );
      assert.equal(consent, Infinity);
      const state = await lessonState(f.db, lesson.lessonId);
      const bound = studyCloseBound(state, consent);
      const at = lesson.startedAt + STUDY_OPEN_LESSON_MAX_MS;
      assert.deepEqual(bound, {
        at,
        status: "abandoned",
        reason: "open_limit",
      });
      const sql = await f.db
        .prepare(
          `SELECT ${STUDY_CLOSE_BOUND_SQL} AS due FROM study_lessons l
          LEFT JOIN study_publications p ON p.lesson_id=l.lesson_id WHERE l.lesson_id=?`,
        )
        .bind(...studyCloseBoundBinds, lesson.lessonId)
        .first<{ due: number }>();
      assert.equal(sql!.due, at);
      // The open lesson's history stays exportable while it is open. Sessions
      // last thirty days, so reads this late sign in again.
      f.advance(at - 1 - f.clock());
      const auth = await f.login();
      const read = async (path: string) =>
        json<StudyLesson>(await f.call(path, { headers: auth }));
      const history = await f.post(
        lessonPath(lesson.lessonId) + "/history",
        {},
        auth,
      );
      assert.equal(history.status, 200);
      assert.equal(
        ((await history.json()) as { exportAvailableUntil: number })
          .exportAvailableUntil,
        at - 1 + STUDY_HISTORY_EXPORT_WINDOW_MS,
      );
      assert.equal((await read(lessonPath(lesson.lessonId))).status, "active");
      f.advance(1);
      const closed = await read(lessonPath(lesson.lessonId));
      assert.equal(closed.status, "abandoned");
      assert.equal(closed.completionReason, "open_limit");
      assert.equal(closed.completedAt, at);
      const view = await json<{
        state: string;
        receipt: { reason?: string } | null;
      }>(
        await f.call(lessonPath(lesson.lessonId) + "/publication", {
          headers: auth,
        }),
      );
      assert.equal(view.state, "private");
      assert.equal(view.receipt!.reason, "unfinished");
      assert.equal(resultIntent(f, lesson.lessonId), undefined);
      await eraseOnSchedule(f, closed);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "withdrawal on chain refuses speech before any provider call, ends the open lesson, and keeps a finished one private",
  { timeout: 150000 },
  async () => {
    const f = await studyPublicationFixtureV4(19986);
    try {
      // A finished lesson whose publication has not been sent yet.
      const release = holdTerminals(f);
      const finished = await complete(f);
      assert.equal((await f.publication(finished.lessonId)).receipt, null);
      release();
      let open = await f.start();
      open = (await f.answer(open, false)).lesson;
      await f.mineClock();
      await revokeOnChain(f);
      const counts = f.counts(),
        slots = f.store.entries("studySpeechSlot:").length;
      const refused = await f.answer(open, true);
      assert.equal(refused.attempt.state, "unavailable");
      assert.equal(
        (refused.attempt as { failure?: string }).failure,
        "enrollment_required",
      );
      assert.equal(refused.lesson.status, "abandoned");
      assert.equal(refused.lesson.completionReason, "consent_ended");
      assert.deepEqual(f.counts(), counts);
      assert.equal(f.store.entries("studySpeechSlot:").length, slots);
      const unfinished = await f.publication(open.lessonId);
      assert.equal(unfinished.receipt!.reason, "unfinished");
      // The finished lesson is never sent once permission is withdrawn.
      const withdrawn = await sync(f, finished.lessonId);
      assert.equal(withdrawn.state, "private");
      assert.equal(withdrawn.receipt!.reason, "authorization_withdrawn");
      assert.equal(withdrawn.receipt!.neverSubmitted, true);
      assert.equal(resultIntent(f, finished.lessonId), undefined);
      assert.equal(resultIntent(f, open.lessonId), undefined);
      assert.equal(f.store.entries("tx:").length, 1); // The sign-in only.
      assert.equal((await f.readResults()).length, 0);
      // New lessons are refused until permission is turned back on.
      await assert.rejects(f.start(), /study_authorization_required/);
      await eraseOnSchedule(f, finished);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "the operator refuses an authorization from before a withdrawal, or one belonging to another learner",
  { timeout: 150000 },
  async () => {
    const f = await studyPublicationFixtureV4(19987);
    try {
      const [first] = await recorded(f);
      const lesson = await f.start();
      const base = v4Binding(f, lesson.lessonId).offer;
      const offer = (
        changes: Partial<StudyLessonOfferV4>,
      ): StudyLessonOfferV4 => ({
        ...base,
        lessonId: crypto.randomUUID(),
        startedAt: f.clock(),
        ...changes,
      });
      // Another learner's recorded sign-in cannot bind this learner's lesson.
      await f.mineClock();
      const other = await signInOnChain(f, 6);
      await assert.rejects(
        bindManagedStudy(f.operator, offer({ authorizationId: other.id })),
        /study_authorization_mismatch/,
      );
      // An unknown authorization, or one issued after the lesson started.
      await assert.rejects(
        bindManagedStudy(
          f.operator,
          offer({ authorizationId: `0x${"ab".repeat(32)}` }),
        ),
        /study_authorization_mismatch/,
      );
      await assert.rejects(
        bindManagedStudy(
          f.operator,
          offer({
            authorizationId: first.authorization_id,
            startedAt: first.issued_at * 1000 - 1,
          }),
        ),
        /study_authorization_mismatch/,
      );
      // A V3-shaped offer under V4 authority binds nothing.
      const { authorizationId: _, ...v3 } = offer({});
      await assert.rejects(
        bindManagedStudy(f.operator, v3 as never),
        /invalid_study_lesson_binding/,
      );
      await revokeOnChain(f);
      f.advance(2000);
      await f.mineClock();
      const after = await signInOnChain(f, 5);
      // The sign-in made before the withdrawal no longer authorizes.
      await assert.rejects(
        bindManagedStudy(
          f.operator,
          offer({ authorizationId: first.authorization_id }),
        ),
        /study_authorization_required/,
      );
      const bound = await bindManagedStudy(
        f.operator,
        offer({ authorizationId: after.id, startedAt: f.clock() }),
      );
      assert.equal(bound.authorization.id, after.id);
      assert.equal(
        bound.authorization.issuedAt,
        Number(after.message.issuedAt),
      );
      // The lesson bound before the withdrawal can no longer speak.
      const counts = f.counts();
      const refused = await f.answer(lesson, true);
      assert.equal(refused.lesson.completionReason, "consent_ended");
      assert.deepEqual(f.counts(), counts);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a V3 lesson keeps its V3 binding and publishes to V3 after V4 becomes the default for new lessons",
  { timeout: 150000 },
  async () => {
    const f = await studyPublicationFixture(19988);
    try {
      let old = await f.start();
      old = (await f.answer(old, false)).lesson;
      // Release: V4 is deployed and becomes the directory's learning records.
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
      // The V4 release applies its sign-in schema to the V3 community.
      await f.applyV4Migration();
      f.operatorEnv.RESULTS_V4_CONTRACT = v4;
      (
        f.env as { STUDY_RESULTS_V4_CONTRACT?: string }
      ).STUDY_RESULTS_V4_CONTRACT = v4;
      (f.config as { learningRecords: string }).learningRecords =
        v4.toLowerCase();
      // The lesson in progress continues and publishes under V3.
      while (old.status === "active") old = (await f.answer(old, true)).lesson;
      assert.equal(old.status, "completed");
      const binding = studyBinding(f.store, old.lessonId)!;
      assert.equal(binding.target.version, 3);
      assert.ok(binding.enrollment);
      const published = await f.publication(old.lessonId);
      assert.equal(published.state, "published", JSON.stringify(published));
      assert.equal(
        published.receipt!.contract.toLowerCase(),
        f.v3.toLowerCase(),
      );
      assert.equal((await f.readResults()).length, 1);
      // A session signed in before V4 has no authorization; it signs in again.
      const refused = await f.post(
        "/api/study/lessons",
        { requestId: crypto.randomUUID(), song: f.song },
        f.auth,
      );
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), {
        error: "study_authorization_required",
      });
      const auth = await f.login();
      for (
        let i = 0;
        i < 3 && (await recorded(f))[0]?.state !== "recorded";
        i++
      )
        await f.recordSignIns();
      const fresh = await json<StudyLesson>(
        await f.post(
          "/api/study/lessons",
          { requestId: crypto.randomUUID(), song: f.song },
          auth,
        ),
      );
      const next = studyBinding(
        f.store,
        fresh.lessonId,
      ) as StudyAuthorizationBinding;
      assert.equal(next.target.version, 4);
      assert.equal(next.target.contract, v4.toLowerCase());
      assert.equal(
        next.authorization.id,
        (await recorded(f))[0].authorization_id,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a V3 community without migration 0013 signs in and studies normally",
  { timeout: 150000 },
  async () => {
    const f = await studyPublicationFixture(19989);
    try {
      // None of the V4 sign-in schema exists in a V3 community.
      const objects = (
        await f.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE 'learning_%'",
          )
          .all<{ name: string }>()
      ).results;
      assert.deepEqual(objects, []);
      const columns = (
        await f.db
          .prepare("SELECT name FROM pragma_table_info('login_challenges')")
          .all<{ name: string }>()
      ).results.map((c) => c.name);
      assert.equal(columns.includes("kind"), false);
      assert.equal(columns.includes("policy_version"), false);
      // SIWE sign-in, the session view and capabilities, as before V4.
      const auth = await f.login();
      const session = await json<{ publicResults: string }>(
        await f.call("/api/session", { headers: auth }),
      );
      assert.equal(session.publicResults, "unavailable");
      const capabilities = await json<Record<string, unknown>>(
        await f.call("/api/capabilities"),
      );
      // The footer links the V3 learning documents of this V3 community.
      assert.deepEqual(capabilities.learningPolicy, {
        version: 3,
        termsUrl: "/learning/v3/terms",
        privacyUrl: "/learning/v3/privacy",
      });
      // A V3 lesson binds the enrollment and publishes to V3.
      const lesson = await complete(f as unknown as Fixture);
      const binding = studyBinding(f.store, lesson.lessonId)!;
      assert.equal(binding.target.version, 3);
      assert.ok(binding.enrollment);
      const published = await f.publication(lesson.lessonId);
      assert.equal(published.state, "published", JSON.stringify(published));
      assert.equal((await f.readResults()).length, 1);
      // The V4 settings are refused before touching any V4 table.
      const off = await f.post("/api/learning/public-results/off", {}, auth);
      assert.equal(off.status, 409);
      assert.deepEqual(await off.json(), { error: "public_results_unavailable" });
    } finally {
      await f.dispose();
    }
  },
);
