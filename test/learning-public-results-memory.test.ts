import test from "node:test";
import assert from "node:assert/strict";
import { communityFetch } from "../services/community-application.ts";
import { liveStudy } from "../services/study-community.ts";
import {
  closeWithdrawnStudyLessons,
  noteChainWithdrawal,
  publicationSignInAtLogin,
  turnOffPublicResults,
  turnOnPublicResults,
} from "../services/learning-public-results.ts";
import {
  practiceAuthorization,
  publicResults,
  signInV4,
} from "../services/learning-sign-in.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { loginChallenge } from "../packages/community/accounts.ts";
import {
  withdrawalFixture,
  wallet,
} from "./learning-public-results-memory-fixture.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("local operation waited for external I/O")),
          500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Fixture = Awaited<ReturnType<typeof withdrawalFixture>>;
async function closedLocally(f: Fixture) {
  const state = f.store.state(await f.store.row(f.owner, f.row.lesson_id));
  assert.equal(state.status, "abandoned");
  assert.equal(state.completionReason, "consent_ended");
  const attempt = await f.attempts.get(f.owner, f.take.attemptId);
  assert.equal(attempt.state, "uncertain");
  assert.equal(attempt.failure, "study_lesson_closed");
  assert.equal(attempt.audio_digest, f.audioDigest);
  assert.equal(attempt.audio_duration_ms, 2000);
  assert.equal(attempt.grade_json, null);
  assert.equal(await publicResults(f.db, "a", true), "off");
  const publication = (await f.publication())!;
  assert.ok(publication.terminal_json, "terminal facts are durably queued");
  assert.equal(JSON.parse(publication.terminal_json).status, "abandoned");
  assert.equal(
    f.store.state(
      await f.store.row(
        { accountId: "b", communityId: f.owner.communityId },
        f.foreign.lesson_id,
      ),
    ).status,
    "active",
  );
  return publication;
}
const request = (path: string, body: unknown) =>
  new Request(firstSong.origin + path, {
    method: "POST",
    headers: { origin: firstSong.origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

for (const publicationState of ["bound", "pending"] as const)
  test(`actual login closes locally while ${publicationState} Study speech-status stays unresolved`, async () => {
    const f = await withdrawalFixture(publicationState),
      entered = deferred<void>(),
      provider = deferred<Response>();
    let statuses = 0,
      terminals = 0;
    let reconciliation: Promise<unknown> | undefined;
    try {
      await f.withdraw();
      const retained = (await f.publication())!;
      f.env.KARAOKE_OPERATOR = {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const req = new Request(input, init),
            path = new URL(req.url).pathname;
          if (path === "/study/speech/status") {
            statuses++;
            entered.resolve();
            return provider.promise;
          }
          assert.equal(path, "/study/terminal");
          terminals++;
          return Response.json(
            { error: "fixture_operator_still_unavailable" },
            { status: 503 },
          );
        },
      } as unknown as Fetcher;
      // This is the real legacy shared callback, including the real signed
      // managed Study status call. Keep its provider response unresolved until
      // BOTH actual login challenges and local cleanup have completed.
      reconciliation = liveStudy(f.ports, {
        account_id: "a",
        wallet,
      }).endForWithdrawal(f.now);
      await bounded(entered.promise);
      for (let login = 0; login < 2; login++) {
        const response = await bounded(
          communityFetch(
            request("/api/auth/challenge", { address: wallet }),
            f.env,
            f.dependencies,
          ),
        );
        const challenge = (await response.json()) as {
          id: string;
          message: string;
          kind?: string;
        };
        assert.equal(response.status, 200, JSON.stringify(challenge));
        assert.equal(
          challenge.kind,
          undefined,
          "withdrawal gives plain SIWE only",
        );
        assert.ok(challenge.message.includes("Sign in to this community."));
        const publication = await closedLocally(f);
        assert.equal(publication.state, publicationState);
        assert.equal(publication.source_json, retained.source_json);
        assert.equal(publication.binding_json, retained.binding_json);
        assert.equal(
          publication.receipt_json,
          retained.receipt_json,
          "uncertain transaction/provider evidence is retained",
        );
        assert.equal(
          statuses,
          1,
          "login never starts the legacy reconciliation callback",
        );
        assert.equal(
          terminals,
          0,
          "login never dispatches terminal publication",
        );
        // Actual verification/session SQL, with an explicit local signature
        // verifier mock. No real wallet, provider, chain or fresh key.
        const verified = await bounded(
          communityFetch(
            request("/api/auth/verify", {
              id: challenge.id,
              signature: "0x11",
            }),
            f.env,
            {
              ...f.dependencies,
              verifyLogin: async (address) => address === wallet,
            },
          ),
        );
        assert.equal(verified.status, 200, await verified.clone().text());
        assert.ok(verified.headers.get("set-cookie"));
      }
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) n FROM learning_authorizations")
          .first<{ n: number }>())!.n,
        1,
        "plain login stores no new authorization",
      );
      assert.deepEqual(
        await practiceAuthorization(
          f.env,
          f.db,
          "a",
          wallet,
          f.now / 1000,
          f.now,
        ),
        { id: null, pending: false },
      );
      assert.equal(statuses, 1);
      // Terminal bound/pending rows are precisely the existing recovery
      // journal; its actual scheduled drain is a later Worker integration gate.
      assert.equal(
        (await f.db
          .prepare(
            `SELECT count(*) n FROM study_lessons l JOIN study_publications p ON p.lesson_id=l.lesson_id
        WHERE l.account_id='a' AND json_extract(l.state_json,'$.status')!='active' AND p.state IN ('bound','pending')`,
          )
          .first<{ n: number }>())!.n,
        1,
      );
      // Resolve only after both logins and their cleanup assertions.
      // Even a valid late assessment cannot reopen or grade the closed lesson.
      provider.resolve(
        Response.json({
          audioDigest: f.audioDigest,
          parameters: {
            lessonId: f.row.lesson_id,
            attemptId: f.take.attemptId,
            lineId: f.take.line.lineId,
            presentationNumber: 1,
            takeNumber: 1,
            durationMs: 2000,
            contentType: "audio/webm",
          },
          receipt: {
            state: "assessed",
            transcript: { text: f.take.line.text, language: "en" },
          },
        }),
      );
      await bounded(reconciliation);
      const afterRecovery = await closedLocally(f);
      assert.equal(afterRecovery.source_json, retained.source_json);
      assert.equal(afterRecovery.binding_json, retained.binding_json);
      assert.equal(afterRecovery.receipt_json, retained.receipt_json);
    } finally {
      provider.resolve(
        Response.json({ error: "fixture_unavailable" }, { status: 503 }),
      );
      await reconciliation;
      f.close();
    }
  });

test("every completed cleanup SQL response can be interrupted and retried, including closure before outbox freeze", async (t) => {
  const baseline = await withdrawalFixture();
  let responses: number;
  try {
    await baseline.withdraw();
    baseline.memory.responses = [];
    await closeWithdrawnStudyLessons(baseline.db, "a", baseline.now);
    responses = baseline.memory.responses.length;
    assert.ok(
      baseline.memory.responses.some(({ kind }) => kind === "batch"),
      "actual canonical lesson/attempt batch exercised",
    );
    assert.ok(
      baseline.memory.responses.some(
        ({ kind, sql }) =>
          kind === "run" &&
          sql.startsWith("UPDATE study_publications SET terminal_json="),
      ),
      "actual terminal freeze exercised",
    );
    await closedLocally(baseline);
  } finally {
    baseline.close();
  }
  for (let stop = 1; stop <= responses!; stop++) {
    const f = await withdrawalFixture();
    try {
      await f.withdraw();
      const retained = (await f.publication())!;
      let response = 0;
      f.memory.afterResponse = () => {
        if (++response === stop) throw Error("interrupted_response");
      };
      await assert.rejects(
        closeWithdrawnStudyLessons(f.db, "a", f.now),
        /interrupted_response/,
        `response ${stop}`,
      );
      f.memory.afterResponse = undefined;
      await closeWithdrawnStudyLessons(f.db, "a", f.now);
      const saved = await closedLocally(f);
      assert.equal(saved.receipt_json, retained.receipt_json);
      assert.equal(saved.binding_json, retained.binding_json);
      const terminal = saved.terminal_json;
      await closeWithdrawnStudyLessons(f.db, "a", f.now + 10000);
      assert.equal(
        (await f.publication())!.terminal_json,
        terminal,
        `terminal stable after response ${stop}`,
      );
    } finally {
      f.close();
    }
  }
  t.diagnostic(
    `Interrupted and retried all ${responses!} completed SQL responses, including atomic closure and terminal freeze.`,
  );
});

for (const entry of [
  "new chain observation at login",
  "turn off",
  "chain refusal notice",
] as const)
  test(`${entry} commits local cleanup without invoking an unresolved legacy callback`, async () => {
    const f = await withdrawalFixture();
    let callbacks = 0;
    const never = async () => {
      callbacks++;
      return new Promise<never>(() => {});
    };
    try {
      f.env.KARAOKE_OPERATOR = {
        fetch: async () =>
          Response.json({
            state: "pending",
            since: 0,
            revokedAt: f.now / 1000,
            revocationNonce: "1",
            pendingWithdrawal: false,
          }),
      } as unknown as Fetcher;
      const learner = { account_id: "a", wallet };
      if (entry === "new chain observation at login")
        assert.equal(
          await bounded(
            publicationSignInAtLogin(
              f.env,
              f.db,
              wallet,
              signInV4(f.env, f.ports.config),
              never,
            ),
          ),
          undefined,
        );
      else if (entry === "turn off")
        await bounded(
          turnOffPublicResults(
            f.env,
            f.db,
            f.ports.config,
            learner,
            { signature: "0x11", message: { learner: wallet, nonce: "1" } },
            f.now,
            never,
          ),
        );
      else
        assert.equal(
          await bounded(
            noteChainWithdrawal(
              f.env,
              f.db,
              learner,
              never,
              {
                since: 0,
                revokedAt: f.now / 1000,
                revocationNonce: "1",
                pendingWithdrawal: false,
              },
              f.now,
            ),
          ),
          true,
        );
      assert.equal(callbacks, 0);
      await closedLocally(f);
    } finally {
      f.close();
    }
  });

test("a newer explicit turn-on wins a stale login observation without closing its lesson", async () => {
  const f = await withdrawalFixture();
  try {
    f.env.KARAOKE_OPERATOR = {
      async fetch() {
        await f.db
          .prepare(
            "INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at,acknowledged_revocation_nonce) VALUES('a',NULL,?,'2')",
          )
          .bind(f.now)
          .run();
        return Response.json({
          since: 0,
          revokedAt: f.now / 1000,
          revocationNonce: "2",
        });
      },
    } as unknown as Fetcher;
    const v4 = signInV4(f.env, f.ports.config);
    assert.equal(await publicationSignInAtLogin(f.env, f.db, wallet, v4), v4);
    assert.equal(
      f.store.state(await f.store.row(f.owner, f.row.lesson_id)).status,
      "active",
    );
    assert.equal((await f.publication())!.terminal_json, null);
  } finally {
    f.close();
  }
});

test("turn-on retries local cleanup and cannot clear withdrawal after an interrupted terminal freeze", async () => {
  const f = await withdrawalFixture();
  let observations = 0;
  try {
    await f.withdraw();
    f.env.KARAOKE_OPERATOR = {
      fetch: async () => {
        observations++;
        return Response.json({
          since: 0,
          revokedAt: f.now / 1000,
          revocationNonce: "1",
        });
      },
    } as unknown as Fetcher;
    f.memory.afterResponse = ({ sql, kind }) => {
      if (kind === "first" && sql.startsWith("SELECT state,source_json"))
        throw Error("interrupted_terminal_freeze");
    };
    await assert.rejects(
      turnOnPublicResults(f.env, f.db, f.ports.config, {
        account_id: "a",
        wallet,
      }),
      /interrupted_terminal_freeze/,
    );
    f.memory.afterResponse = undefined;
    assert.equal(
      observations,
      0,
      "finish local closure before reading the operator",
    );
    assert.equal(await publicResults(f.db, "a", true), "off");
    assert.equal((await f.publication())!.terminal_json, null);
    await turnOnPublicResults(f.env, f.db, f.ports.config, {
      account_id: "a",
      wallet,
    });
    assert.equal(observations, 1);
    assert.ok((await f.publication())!.terminal_json);
    assert.equal(
      f.store.state(await f.store.row(f.owner, f.row.lesson_id)).status,
      "abandoned",
    );
    assert.equal(
      (await f.attempts.get(f.owner, f.take.attemptId)).state,
      "uncertain",
    );
    assert.equal(
      (await f.db
        .prepare(
          "SELECT public_results_withdrawn_at withdrawn,acknowledged_revocation_nonce nonce FROM learning_settings WHERE account_id='a'",
        )
        .first<{ withdrawn: number | null; nonce: string }>())!.withdrawn,
      null,
    );
  } finally {
    f.close();
  }
});

for (const turnOn of [false, true])
  test(`an older V4 challenge completed after withdrawal cannot authorize again (turn-on=${turnOn})`, async () => {
    const f = await withdrawalFixture();
    try {
      // Remove the earlier recorded authorization so it cannot mask the
      // withdrawn-time/flag fence being tested by the actual verify batch.
      await f.db.prepare("DELETE FROM learning_authorizations").run();
      const challenge = await loginChallenge(
        f.db,
        { communityId: f.owner.communityId, origin: firstSong.origin },
        wallet,
        f.now - 10000,
        signInV4(f.env, f.ports.config),
      );
      await f.withdraw();
      await closeWithdrawnStudyLessons(f.db, "a", f.now);
      if (turnOn) {
        f.env.KARAOKE_OPERATOR = {
          fetch: async () =>
            Response.json({
              since: 0,
              revokedAt: f.now / 1000,
              revocationNonce: "1",
            }),
        } as unknown as Fetcher;
        await turnOnPublicResults(f.env, f.db, f.ports.config, {
          account_id: "a",
          wallet,
        });
      }
      const response = await communityFetch(
        request("/api/auth/verify", { id: challenge.id, signature: "0x11" }),
        f.env,
        {
          ...f.dependencies,
          verifyLogin: async (address) => address === wallet,
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok(response.headers.get("set-cookie"));
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) n FROM learning_authorizations")
          .first<{ n: number }>())!.n,
        0,
      );
      assert.equal(
        (await f.attempts.get(f.owner, f.take.attemptId)).state,
        "uncertain",
      );
      assert.equal(
        f.store.state(await f.store.row(f.owner, f.row.lesson_id)).status,
        "abandoned",
      );
    } finally {
      f.close();
    }
  });
