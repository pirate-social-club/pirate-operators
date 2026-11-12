// The learner may withdraw by calling `revoke` on the V4 contract directly,
// never reaching the operator's acceptRevocationV4. Their V3 results not yet
// sent still stay private as authorization_withdrawn: before sending, the
// operator reads `revokedAt` from the V4 contract, which only `revoke` writes
// and a later sign-in never resets, and records a withdrawal it finds as the
// same marker the settings path sets. When the application notices such a
// withdrawal, it closes the account's open lessons in the community as
// consent_ended, as turning off does. Actual community routes, D1, operator
// and local V3 and V4 contracts; the posts RPC, IPFS transport and speech
// provider are the fixture's simulations.
import test from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector, zeroHash, type Address, type Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";
import type { StudyAttempt } from "../packages/study/contracts.ts";
import {
  signInMessageV4,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { digest } from "../packages/protocol/index.ts";
import { communityScheduled } from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  acceptEnrollment,
  publicationV2,
  publishV2,
} from "../services/learning-results.ts";
import { intentOf } from "../services/operator-tx.ts";
import {
  resumeStudyPublication,
  type PublicationJob,
} from "../services/study-publication.ts";
import { resumeStudyPublications } from "../services/study-publication-recovery.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
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
    firstSong.origin,
  ]);
  await f.evm.write(
    v4,
    "LearningResultsV4",
    "setGrader",
    [accounts[2].address, 2, true],
    3,
  );
  await f.applyV4Migration();
  await f.enableV4Authority(v4);
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
/** The learner's own `revoke` call on the V4 contract, outside the application. */
async function revokeDirectly(f: Fixture, v4: Address, index = 5) {
  const learner = accounts[index].address;
  const nonce = await f.evm.read(v4, "LearningResultsV4", "nextNonce", [
    learner,
  ]);
  await f.evm.write(
    v4,
    "LearningResultsV4",
    "revoke",
    [learner, nonce, "0x"],
    index,
  );
  const revokedAt = (await f.evm.read(v4, "LearningResultsV4", "revokedAt", [
    learner,
  ])) as bigint;
  assert.ok(revokedAt > 0n);
  return revokedAt;
}
async function sync(f: Fixture, id: string, auth: Auth = f.auth) {
  return json<{
    state: string;
    receipt: {
      state: string;
      sessionId: Hex;
      reason?: string;
      neverSubmitted?: boolean;
      transactionHash: Hex | null;
    } | null;
  }>(await f.post(lessonPath(id) + "/publication", {}, auth));
}
/** One answer through the community's routes, as `auth`'s learner. */
async function answerAs(
  f: Fixture,
  auth: Auth,
  lesson: StudyLesson,
  correct: boolean,
) {
  const opened = await json<{ attempt: StudyAttempt }>(
    await f.post(
      lessonPath(lesson.lessonId) + "/attempts",
      {
        presentationNumber: lesson.current!.presentationNumber,
        takeNumber: lesson.current!.takeNumber,
      },
      auth,
    ),
  );
  f.heard(correct ? opened.attempt.line.text : "unrelated words");
  return (
    await json<{ lesson: StudyLesson }>(
      await f.call(
        lessonPath(lesson.lessonId) +
          "/attempts/" +
          opened.attempt.attemptId +
          "/audio",
        {
          method: "PUT",
          headers: {
            ...auth,
            origin: firstSong.origin,
            "content-type": "audio/webm",
            "x-study-duration-ms": "1000",
          },
          body: new Uint8Array([
            0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 1,
          ]),
        },
      ),
    )
  ).lesson;
}
async function finishLesson(f: Fixture, auth: Auth, lesson: StudyLesson) {
  while (lesson.status === "active")
    lesson = await answerAs(f, auth, lesson, true);
  assert.equal(lesson.status, "completed");
  return lesson;
}
async function completeAs(f: Fixture, auth: Auth) {
  const lesson = await json<StudyLesson>(
    await f.post(
      "/api/study/lessons",
      { requestId: crypto.randomUUID(), song: f.song },
      auth,
    ),
  );
  return finishLesson(f, auth, await answerAs(f, auth, lesson, false));
}
/** A V3 result the operator holds unsent: completed ahead of chain time. */
async function heldAtOperator(f: Fixture, auth: Auth = f.auth) {
  const held = await completeAs(f, auth);
  const job = f.store.get<PublicationJob>(`studyPublication:${held.lessonId}`);
  assert.equal(job!.target.version, 3);
  assert.equal(job!.receipt.state, "pending");
  assert.equal(
    intentOf(f.store, "record_result", `study:${held.lessonId}:1`),
    undefined,
  );
  return held;
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
async function privateWithdrawn(f: Fixture, id: string, auth: Auth = f.auth) {
  const publication = await sync(f, id, auth);
  assert.equal(publication.state, "private");
  assert.equal(publication.receipt!.reason, "authorization_withdrawn");
  assert.equal(publication.receipt!.neverSubmitted, true);
  assert.equal(publication.receipt!.transactionHash, null);
  return publication.receipt!.sessionId;
}
const revokedAtSelector = toFunctionSelector("revokedAt(address)").slice(2);
/**
 * Watches the JSON-RPC traffic for V4 `revokedAt` reads; with `fail`, each
 * such read fails as an RPC outage would.
 */
function watchRevokedAtReads(options: { fail?: boolean } = {}) {
  const real = globalThis.fetch;
  const seen = { reads: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes('"eth_call"') && body.includes(revokedAtSelector)) {
      seen.reads++;
      if (options.fail) throw new TypeError("fixture RPC outage");
    }
    return real(input, init);
  }) as typeof fetch;
  return {
    seen,
    restore() {
      globalThis.fetch = real;
    },
  };
}
const enrollmentsSelector = toFunctionSelector("enrollments(address)").slice(2);
/**
 * Runs `during` once, just before the first V3 `enrollments` read the
 * dispatch makes between its first withdrawal check and the pre-send one.
 */
function beforeEnrollmentRead(during: () => Promise<unknown>) {
  const real = globalThis.fetch;
  const seen = { fired: false };
  let busy = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      !seen.fired &&
      !busy &&
      body.includes('"eth_call"') &&
      body.includes(enrollmentsSelector)
    ) {
      busy = true;
      try {
        await during();
      } finally {
        busy = false;
      }
      seen.fired = true;
    }
    return real(input, init);
  }) as typeof fetch;
  return {
    seen,
    restore() {
      globalThis.fetch = real;
    },
  };
}
const marker = (f: Fixture, index = 5) =>
  f.store.get<{ source?: string }>(
    `legacyResultsWithheld:${accounts[index].address.toLowerCase()}`,
  );

test(
  "a direct V4 revoke keeps a held V3 result private and never sent; the application then closes the open V3 and V4 lessons",
  { timeout: 300000 },
  async () => {
    const f = await studyPublicationFixture(19721, {
      operatorAuthorityStore: true,
    });
    try {
      // A V3 result held at the operator, and a V3 lesson still open.
      f.advance(3600_000);
      const held = await heldAtOperator(f);
      let open = await f.start();
      open = (await f.answer(open, false)).lesson;
      assert.equal(open.status, "active");
      // V4 becomes the records; the learner signs in and starts V4.
      const v4 = await becomeV4(f);
      const auth = await f.login();
      await f.mineClock();
      const fresh = await startV4(f, auth);
      // The learner revokes on the V4 contract, outside the application.
      await revokeDirectly(f, v4);
      assert.equal(marker(f), undefined);
      await sweep(f);
      const session = await privateWithdrawn(f, held.lessonId);
      assert.equal(marker(f)!.source, "chain");
      await nothingOnV3(f, [session]);
      // The application notices when the operator refuses new work; the
      // account's open lessons in the community then close as consent_ended.
      const refused = await f.post(
        "/api/study/lessons",
        { requestId: crypto.randomUUID(), song: f.song },
        auth,
      );
      assert.equal(refused.status, 409, await refused.clone().text());
      assert.equal(
        ((await refused.json()) as { error: string }).error,
        "study_authorization_required",
      );
      for (const id of [open.lessonId, fresh.lessonId]) {
        const closed = await lessonState(f.db, id);
        assert.equal(closed.status, "abandoned");
        assert.equal(closed.completionReason, "consent_ended");
      }
      const settings = await f.db
        .prepare(
          "SELECT public_results_withdrawn_at FROM learning_settings WHERE account_id=(SELECT account_id FROM study_lessons WHERE lesson_id=?)",
        )
        .bind(open.lessonId)
        .first<{ public_results_withdrawn_at: number | null }>();
      assert.notEqual(settings?.public_results_withdrawn_at ?? null, null);
      await sweep(f);
      const closedSession = await privateWithdrawn(f, open.lessonId);
      await sweep(f);
      await nothingOnV3(f, [session, closedSession]);
      // Turning public results back on and signing in again restores V4
      // permission; V3 publication never resumes.
      await json(await f.post("/api/learning/public-results/on", {}, auth));
      await f.mineClock();
      const again = await f.login();
      await startV4(f, again);
      await sweep(f);
      assert.equal((await sync(f, held.lessonId)).state, "private");
      assert.equal((await sync(f, open.lessonId)).state, "private");
      await nothingOnV3(f, [session, closedSession]);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a direct V4 revoke followed by a new sign-in before dispatch still keeps the held V3 result and the open V3 lesson's later result private",
  { timeout: 300000 },
  async () => {
    const f = await studyPublicationFixture(19722, {
      operatorAuthorityStore: true,
    });
    try {
      f.advance(3600_000);
      const held = await heldAtOperator(f);
      let open = await f.start();
      open = (await f.answer(open, false)).lesson;
      const v4 = await becomeV4(f);
      const auth = await f.login();
      await f.mineClock();
      await startV4(f, auth);
      const revokedAt = await revokeDirectly(f, v4);
      // The learner signs in again after the withdrawal and relays it
      // themselves, so permission is in force again on chain before the held
      // result is dispatched. The application is never told.
      await f.mineClock();
      const learner = accounts[5].address;
      const issuedAt = BigInt(Math.floor(f.clock() / 1000));
      assert.ok(issuedAt > revokedAt);
      const signIn: SignIn = {
        learner,
        nonce: digest("sign-in-after-direct-revoke"),
        issuedAt,
      };
      const signature = await accounts[5].signMessage({
        message: signInMessageV4(
          {
            origin: firstSong.origin,
            chainId: 31337,
            contract: v4.toLowerCase() as Address,
            communityId: f.config.communityId,
            publicationPolicy: learningV4PublicityPolicy,
          },
          signIn,
        ),
      });
      await f.evm.write(
        v4,
        "LearningResultsV4",
        "authorize",
        [signIn, signature],
        5,
      );
      assert.ok(
        ((await f.evm.read(v4, "LearningResultsV4", "authorizedSince", [
          learner,
        ])) as bigint) === issuedAt,
      );
      // A later sign-in never resets revokedAt.
      assert.equal(
        await f.evm.read(v4, "LearningResultsV4", "revokedAt", [learner]),
        revokedAt,
      );
      assert.equal(marker(f), undefined);
      await sweep(f);
      const session = await privateWithdrawn(f, held.lessonId);
      // The V3 lesson open across the withdrawal finishes; its result stays
      // private too.
      const view = await f.get(open.lessonId);
      assert.equal(view.status, "active");
      await finishLesson(f, f.auth, view);
      await sweep(f);
      const later = await privateWithdrawn(f, open.lessonId);
      await sweep(f);
      await nothingOnV3(f, [session, later]);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a failed V4 read during the check sends nothing; the held V3 result stays pending and the retry keeps it private",
  { timeout: 300000 },
  async () => {
    const f = await studyPublicationFixture(19723, {
      operatorAuthorityStore: true,
    });
    try {
      f.advance(3600_000);
      const held = await heldAtOperator(f);
      const v4 = await becomeV4(f);
      await revokeDirectly(f, v4);
      await f.mineClock();
      const before = f.store.get<PublicationJob>(
        `studyPublication:${held.lessonId}`,
      )!;
      const outage = watchRevokedAtReads({ fail: true });
      try {
        await resumeStudyPublications(f.operatorEnv, f.store);
        await assert.rejects(
          resumeStudyPublication(f.operatorEnv, f.store, held.lessonId),
          /fixture RPC outage|HTTP request failed|fetch/i,
        );
      } finally {
        outage.restore();
      }
      assert.ok(outage.seen.reads > 0);
      const during = f.store.get<PublicationJob>(
        `studyPublication:${held.lessonId}`,
      )!;
      assert.equal(during.receipt.state, "pending");
      assert.ok(during.lastTriedAt >= before.lastTriedAt);
      assert.equal(marker(f), undefined);
      assert.deepEqual(f.store.entries("intent:record_result:"), []);
      assert.equal(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          during.result.sessionId,
        ]),
        zeroHash,
      );
      // The read recovers; the scheduled retry keeps it private.
      await sweep(f);
      const session = await privateWithdrawn(f, held.lessonId);
      await nothingOnV3(f, [session]);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "another learner's direct V4 revoke never withholds this learner's V3 result",
  { timeout: 300000 },
  async () => {
    const f = await studyPublicationFixture(19724, {
      operatorAuthorityStore: true,
    });
    try {
      await f.enroll(6);
      const other = await f.login(6);
      f.advance(3600_000);
      const mine = await heldAtOperator(f);
      const theirs = await heldAtOperator(f, other);
      const v4 = await becomeV4(f);
      await revokeDirectly(f, v4, 6);
      await f.mineClock();
      // The other learner's result is dispatched first and withheld, which
      // records their marker.
      await resumeStudyPublication(f.operatorEnv, f.store, theirs.lessonId);
      const theirSession = await privateWithdrawn(f, theirs.lessonId, other);
      assert.equal(marker(f, 6)!.source, "chain");
      for (let i = 0; i < 3; i++) await sweep(f);
      const publication = await sync(f, mine.lessonId);
      assert.equal(publication.state, "published");
      assert.notEqual(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          publication.receipt!.sessionId,
        ]),
        zeroHash,
      );
      assert.equal(marker(f, 5), undefined);
      assert.deepEqual(
        f.store.entries("legacyResultsWithheld:").map(({ key }) => key),
        [`legacyResultsWithheld:${accounts[6].address.toLowerCase()}`],
      );
      assert.equal(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          theirSession,
        ]),
        zeroHash,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a plain V3 community with no V4 contract publishes as before and never reads V4",
  { timeout: 300000 },
  async () => {
    const f = await studyPublicationFixture(19725);
    const watch = watchRevokedAtReads();
    try {
      assert.equal(f.operatorEnv.RESULTS_V4_CONTRACT, undefined);
      f.advance(3600_000);
      const held = await heldAtOperator(f);
      for (let i = 0; i < 3; i++) await sweep(f);
      const publication = await sync(f, held.lessonId);
      assert.equal(publication.state, "published");
      assert.notEqual(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          publication.receipt!.sessionId,
        ]),
        zeroHash,
      );
      assert.equal(watch.seen.reads, 0);
      assert.equal(marker(f), undefined);
    } finally {
      watch.restore();
      await f.dispose();
    }
  },
);

test(
  "Karaoke: a direct V4 revoke, then a new sign-in, keeps enrollment-bound V3 results not yet sent private",
  { timeout: 180000 },
  async () => {
    const communityId = `0x${"5e".repeat(32)}` as const;
    const f = await learningBindingFixture(19726, communityId, undefined, {
      operatorAuthorityStore: true,
    });
    try {
      f.env.RESULTS_V3_CONTRACT = f.v3;
      const learner = accounts[5]!.address as Address;
      const enrollment = await f.enrollment(3);
      let enrolled = await acceptEnrollment(
        f.env,
        f.store,
        enrollment.e,
        enrollment.signature,
      );
      for (let i = 0; !enrolled?.mined && i < 5; i++)
        enrolled = await acceptEnrollment(
          f.env,
          f.store,
          enrollment.e,
          enrollment.signature,
        );
      assert.equal(enrolled?.mined?.status, "success");
      const finished = await f.prepare("v3-run-finished-before-direct-revoke");
      const first = await f.finish(finished);
      const open = await f.prepare("v3-run-open-at-direct-revoke");
      const v4 = await f.evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
        firstSong.origin,
      ]);
      await f.enableV4Authority(v4);
      f.env.RESULTS_V4_CONTRACT = v4;
      // The learner revokes on V4 directly, then signs in again.
      await f.evm.write(
        v4,
        "LearningResultsV4",
        "revoke",
        [learner, 0n, "0x"],
        5,
      );
      const revokedAt = (await f.evm.read(
        v4,
        "LearningResultsV4",
        "revokedAt",
        [learner],
      )) as bigint;
      await f.evm.rpc("evm_setNextBlockTimestamp", [Number(revokedAt) + 2]);
      await f.evm.rpc("evm_mine", []);
      const signIn: SignIn = {
        learner,
        nonce: digest("karaoke-sign-in-after-direct-revoke"),
        issuedAt: revokedAt + 2n,
      };
      const signature = await accounts[5]!.signMessage({
        message: signInMessageV4(
          {
            origin: firstSong.origin,
            chainId: 31337,
            contract: v4.toLowerCase() as Address,
            communityId,
            publicationPolicy: learningV4PublicityPolicy,
          },
          signIn,
        ),
      });
      await f.evm.write(
        v4,
        "LearningResultsV4",
        "authorize",
        [signIn, signature],
        2,
      );
      assert.equal(
        await f.evm.read(v4, "LearningResultsV4", "authorizedSince", [learner]),
        revokedAt + 2n,
      );
      assert.equal(
        await f.evm.read(v4, "LearningResultsV4", "revokedAt", [learner]),
        revokedAt,
      );
      const second = await f.finish(open);
      for (const [take, result] of [
        [finished, first],
        [open, second],
      ] as const) {
        const id = take.ticket.ticketId;
        for (let i = 0; i < 3; i++) await publishV2(f.env, f.store, id);
        assert.deepEqual(publicationV2(f.store, id), {
          state: "private",
          revision: 1,
          reason: "authorization_withdrawn",
        });
        assert.equal(intentOf(f.store, "record_result", `${id}:1`), undefined);
        assert.equal(
          await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
            result.attemptId,
          ]),
          zeroHash,
        );
      }
      assert.equal(
        f.store.get<{ source?: string }>(
          `legacyResultsWithheld:${learner.toLowerCase()}`,
        )?.source,
        "chain",
      );
    } finally {
      await f.stop();
    }
  },
);

test(
  "a direct V4 revoke mined during the dispatch's reads is caught by the pre-send check, for Study and Karaoke",
  { timeout: 300000 },
  async () => {
    const f = await studyPublicationFixture(19727, {
      operatorAuthorityStore: true,
    });
    try {
      f.advance(3600_000);
      const held = await heldAtOperator(f);
      const v4 = await becomeV4(f);
      await f.mineClock();
      // The first check reads no withdrawal; the revoke lands before the
      // dispatch's V3 enrollment read, ahead of the pre-send check.
      const hook = beforeEnrollmentRead(() => revokeDirectly(f, v4));
      try {
        await resumeStudyPublication(f.operatorEnv, f.store, held.lessonId);
      } finally {
        hook.restore();
      }
      assert.equal(hook.seen.fired, true);
      const session = await privateWithdrawn(f, held.lessonId);
      await sweep(f);
      await nothingOnV3(f, [session]);
    } finally {
      await f.dispose();
    }
    const communityId = `0x${"5f".repeat(32)}` as const;
    const k = await learningBindingFixture(19728, communityId, undefined, {
      operatorAuthorityStore: true,
    });
    try {
      k.env.RESULTS_V3_CONTRACT = k.v3;
      const learner = accounts[5]!.address as Address;
      const enrollment = await k.enrollment(3);
      let enrolled = await acceptEnrollment(
        k.env,
        k.store,
        enrollment.e,
        enrollment.signature,
      );
      for (let i = 0; !enrolled?.mined && i < 5; i++)
        enrolled = await acceptEnrollment(
          k.env,
          k.store,
          enrollment.e,
          enrollment.signature,
        );
      assert.equal(enrolled?.mined?.status, "success");
      const run = await k.prepare("v3-run-revoked-during-dispatch");
      const result = await k.finish(run);
      const v4 = await k.evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
        firstSong.origin,
      ]);
      await k.enableV4Authority(v4);
      k.env.RESULTS_V4_CONTRACT = v4;
      const hook = beforeEnrollmentRead(() =>
        k.evm.write(v4, "LearningResultsV4", "revoke", [learner, 0n, "0x"], 5),
      );
      const id = run.ticket.ticketId;
      try {
        await publishV2(k.env, k.store, id);
      } finally {
        hook.restore();
      }
      assert.equal(hook.seen.fired, true);
      for (let i = 0; i < 2; i++) await publishV2(k.env, k.store, id);
      assert.deepEqual(publicationV2(k.store, id), {
        state: "private",
        revision: 1,
        reason: "authorization_withdrawn",
      });
      assert.equal(intentOf(k.store, "record_result", `${id}:1`), undefined);
      assert.equal(
        await k.evm.read(k.v3, "LearningResultsV3", "commitments", [
          result.attemptId,
        ]),
        zeroHash,
      );
    } finally {
      await k.stop();
    }
  },
);
