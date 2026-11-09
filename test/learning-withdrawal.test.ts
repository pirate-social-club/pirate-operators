// V4 withdrawal from account settings and the later turn-on, on a local chain.
// Actual community routes, D1, the operator's Study and relay routes and a
// local LearningResultsV4; the posts RPC, IPFS transport and speech provider
// are the Study fixture's explicit simulations. Nothing here is an exercise
// prompt: turning public results off and on are settings actions.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { accounts } from "../harness/runtime.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { revocationIdV4 } from "../services/learning-authorization.ts";
import { resultsTarget } from "../services/learning-contract.ts";
import { intentOf } from "../services/operator-tx.ts";
import {
  studyBinding,
  type StudyAuthorizationBinding,
} from "../services/study-operator.ts";
import {
  json,
  lessonPath,
  studyPublicationFixtureV4,
} from "./study-publication-fixture.ts";

type Fixture = Awaited<ReturnType<typeof studyPublicationFixtureV4>>;
type Auth = Record<string, string>;
const learner = accounts[5]!;

async function rows(f: Fixture) {
  return (
    await f.db
      .prepare(
        "SELECT authorization_id,issued_at,state FROM learning_authorizations WHERE subject=? ORDER BY issued_at",
      )
      .bind(learner.address.toLowerCase())
      .all<{ authorization_id: Hex; issued_at: number; state: string }>()
  ).results;
}
const settings = (f: Fixture) =>
  f.db
    .prepare(
      "SELECT public_results_withdrawn_at AS withdrawn,last_withdrawn_at AS last FROM learning_settings",
    )
    .first<{ withdrawn: number | null; last: number | null }>();
const read = <T>(f: Fixture, functionName: string, args: unknown[]) =>
  f.evm.publicClient.readContract({
    address: f.v4,
    abi: resultsV4Abi,
    functionName,
    args,
  } as never) as Promise<T>;
const publicResults = async (f: Fixture, auth: Auth) =>
  (await json<{ publicResults: string }>(
    await f.call("/api/session", { headers: auth }),
  )).publicResults;
const startWith = (f: Fixture, auth: Auth) =>
  f.post("/api/study/lessons", { requestId: crypto.randomUUID(), song: f.song }, auth);

/** "Turn off public results" as the settings menu does it: sign, then relay. */
async function turnOff(f: Fixture, auth: Auth) {
  const request = await json<{
    target: { version: number; contract: string };
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: { learner: string; nonce: string };
  }>(await f.post("/api/learning/public-results/off", {}, auth));
  assert.equal(request.primaryType, "Revocation");
  assert.equal(request.target.version, 4);
  assert.equal(
    String(request.domain.verifyingContract).toLowerCase(),
    f.v4.toLowerCase(),
  );
  const signature = await learner.signTypedData(request as never);
  let relayed = { state: "pending", publicResults: "" };
  for (let i = 0; i < 4 && relayed.state !== "success"; i++)
    relayed = await json(
      await f.post(
        "/api/learning/public-results/off",
        { message: request.message, signature },
        auth,
      ),
    );
  assert.equal(relayed.state, "success");
  assert.equal(relayed.publicResults, "off");
  return { request, signature };
}
/** "Turn on public results": clear the withdrawal, then a normal sign-in. */
async function turnOn(f: Fixture, auth: Auth) {
  assert.deepEqual(
    await json(await f.post("/api/learning/public-results/on", {}, auth)),
    { publicResults: "off" },
  );
  // A sign-in in the withdrawal's own second can never authorize again.
  f.advance(2000);
  await f.mineClock();
  const renewed = await f.login();
  for (let i = 0; i < 3 && (await rows(f)).at(-1)!.state !== "recorded"; i++)
    await f.recordSignIns();
  return renewed;
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
async function finish(f: Fixture, auth: Auth, lesson: StudyLesson) {
  const answer = async (current: StudyLesson, correct: boolean) => {
    const opened = await json<{ attempt: { attemptId: string; line: { text: string } } }>(
      await f.post(
        lessonPath(current.lessonId) + "/attempts",
        {
          presentationNumber: current.current!.presentationNumber,
          takeNumber: current.current!.takeNumber,
        },
        auth,
      ),
    );
    f.heard(correct ? opened.attempt.line.text : "unrelated words");
    return (
      await json<{ lesson: StudyLesson }>(
        await f.call(
          `${lessonPath(current.lessonId)}/attempts/${opened.attempt.attemptId}/audio`,
          {
            method: "PUT",
            headers: {
              ...auth,
              origin: firstSong.origin,
              "content-type": "audio/webm",
              "x-study-duration-ms": "1000",
            },
            body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 1]),
          },
        ),
      )
    ).lesson;
  };
  while (lesson.status === "active") lesson = await answer(lesson, true);
  assert.equal(lesson.status, "completed");
  return lesson;
}

test(
  "the V4 revocation the settings sign has the contract's own revocationDigest",
  { timeout: 120000 },
  async () => {
    const f = await studyPublicationFixtureV4(19961);
    try {
      const target = resultsTarget(f.operatorEnv, 4);
      for (const nonce of [0n, 1n, 7n])
        assert.equal(
          revocationIdV4(target, learner.address as Address, nonce),
          await read<Hex>(f, "revocationDigest", [learner.address, nonce]),
        );
      // The relayed transaction is keyed by that digest.
      const { request } = await turnOff(f, f.auth);
      const id = await read<Hex>(f, "revocationDigest", [
        learner.address,
        BigInt(request.message.nonce),
      ]);
      assert.equal(intentOf(f.store, "record_revoke", id)?.to.toLowerCase(), f.v4.toLowerCase());
      assert.equal(await read<bigint>(f, "nextNonce", [learner.address]), 1n);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "turning public results off refuses new Study work and closes the open lesson; turning them on binds a new sign-in",
  { timeout: 180000 },
  async () => {
    const f = await studyPublicationFixtureV4(19962);
    try {
      const [first] = await rows(f);
      assert.equal(first!.state, "recorded");
      assert.equal(await publicResults(f, f.auth), "on");
      // A lesson finished before the withdrawal whose result is not sent yet,
      // and a lesson still open.
      const release = holdTerminals(f);
      const finished = await finish(f, f.auth, await f.start());
      assert.equal((await f.publication(finished.lessonId)).receipt, null);
      release();
      let open = await f.start();
      open = (await f.answer(open, false)).lesson;
      assert.equal(open.status, "active");
      await f.mineClock();

      await turnOff(f, f.auth);
      assert.equal(await read<bigint>(f, "authorizedSince", [learner.address]), 0n);
      assert.ok((await read<bigint>(f, "revokedAt", [learner.address])) > 0n);
      assert.equal(await publicResults(f, f.auth), "off");
      const withdrawn = (await settings(f))!;
      assert.ok(withdrawn.withdrawn && withdrawn.last === withdrawn.withdrawn);

      // New work is refused before any lesson or operator binding.
      const lessons = f.store.entries("studyBinding:").length;
      const refused = await startWith(f, f.auth);
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), {
        error: "study_authorization_required",
      });
      assert.equal(f.store.entries("studyBinding:").length, lessons);
      // The open lesson closes privately on its next recording, unheard.
      const calls = f.counts().calls;
      const closed = await f.answer(open, true);
      assert.equal(closed.lesson.status, "abandoned");
      assert.equal(closed.lesson.completionReason, "consent_ended");
      assert.equal(f.counts().calls, calls);
      assert.equal((await f.publication(open.lessonId)).receipt!.reason, "unfinished");

      // A sign-in while withdrawn signs in but records and relays nothing.
      const relays = f.store.entries("tx:").length;
      const whileOff = await f.login();
      assert.equal((await rows(f)).length, 1);
      assert.equal(await publicResults(f, whileOff), "off");
      await f.recordSignIns();
      assert.equal(f.store.entries("tx:").length, relays);

      // Turned on: the next sign-in is stored and relayed despite the older
      // recorded row, and permission restarts at it.
      const renewed = await turnOn(f, whileOff);
      const all = await rows(f);
      assert.equal(all.length, 2);
      const [, second] = all;
      assert.equal(second!.state, "recorded");
      assert.ok(second!.issued_at > first!.issued_at);
      assert.equal(
        await read<bigint>(f, "authorizedSince", [learner.address]),
        BigInt(second!.issued_at),
      );
      assert.equal(await publicResults(f, renewed), "on");
      assert.equal((await settings(f))!.withdrawn, null);
      assert.equal((await settings(f))!.last, withdrawn.last);

      // New work binds the new sign-in and publishes under it.
      const fresh = await json<StudyLesson>(await startWith(f, renewed));
      const binding = studyBinding(f.store, fresh.lessonId) as StudyAuthorizationBinding;
      assert.equal(binding.authorization.id, second!.authorization_id);
      const done = await finish(f, renewed, fresh);
      const published = await f.publication(done.lessonId);
      assert.equal(published.state, "published", JSON.stringify(published));

      // The lesson finished before the withdrawal stays unpublishable, even
      // though permission is in force again.
      await f.call(lessonPath(finished.lessonId), { headers: f.auth });
      const kept = await json<{
        state: string;
        receipt: { reason?: string } | null;
      }>(
        await f.post(lessonPath(finished.lessonId) + "/publication", {}, f.auth),
      );
      assert.equal(kept.state, "private", JSON.stringify(kept));
      assert.equal(kept.receipt!.reason, "authorization_withdrawn");
      assert.equal(intentOf(f.store, "record_result", `study:${finished.lessonId}:1`), undefined);
      const results = await f.readResults();
      assert.equal(results.length, 1);
      assert.equal(results[0]!.verified, true);
      assert.equal(results[0]!.result.enrollmentId, second!.authorization_id);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a withdrawal made directly on chain is noticed when Study is refused, shows off, and nothing is relayed until turned on",
  { timeout: 180000 },
  async () => {
    const f = await studyPublicationFixtureV4(19963);
    try {
      const [first] = await rows(f);
      await f.mineClock();
      await f.evm.write(
        f.v4,
        "LearningResultsV4",
        "revoke",
        [learner.address, 0n, "0x"],
        5,
      );
      const revokedAt = Number(await read<bigint>(f, "revokedAt", [learner.address]));
      // The application still believes permission is on until the operator refuses.
      assert.equal(await publicResults(f, f.auth), "on");
      const refused = await startWith(f, f.auth);
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), {
        error: "study_authorization_required",
      });
      assert.deepEqual(await settings(f), {
        withdrawn: revokedAt * 1000,
        last: revokedAt * 1000,
      });
      assert.equal(await publicResults(f, f.auth), "off");
      // Refused again at once, now without asking the operator to bind.
      const again = await startWith(f, f.auth);
      assert.deepEqual(await again.json(), {
        error: "study_authorization_required",
      });
      // Never auto-relayed: a later sign-in stores and sends nothing.
      f.advance(2000);
      await f.mineClock();
      const relays = f.store.entries("tx:").length;
      const later = await f.login();
      await f.recordSignIns();
      assert.deepEqual((await rows(f)).map((r) => r.authorization_id), [
        first!.authorization_id,
      ]);
      assert.equal(f.store.entries("tx:").length, relays);
      assert.equal(await read<bigint>(f, "authorizedSince", [learner.address]), 0n);
      // Settings turn it back on, with a normal sign-in.
      const renewed = await turnOn(f, later);
      assert.equal(await publicResults(f, renewed), "on");
      const [, second] = await rows(f);
      assert.ok(second!.issued_at > revokedAt);
      const fresh = await json<StudyLesson>(await startWith(f, renewed));
      assert.equal(
        (studyBinding(f.store, fresh.lessonId) as StudyAuthorizationBinding)
          .authorization.id,
        second!.authorization_id,
      );
      // Once turned on, the earlier chain revocation is not noticed again.
      assert.equal((await settings(f))!.withdrawn, null);
    } finally {
      await f.dispose();
    }
  },
);
