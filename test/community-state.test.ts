import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import {
  accountSession,
  authenticatedWrite,
  ensureCommunityIdentity,
  loginChallenge,
  loginVerify,
} from "../packages/community/accounts.ts";
import {
  configureBudget,
  reserveBudget,
  settleBudget,
} from "../packages/community/budgets.ts";

const origin = "https://community.example";
const context = {
  origin,
  communityId:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;
const wallet = "0x1111111111111111111111111111111111111111";
const signature = "0x1234";
const verifyFixtureSignature = async () => true;
// Run concurrent D1 work with the native Worker binding. The fixture keeps
// its account, session and request-security assertions in the host.
const concurrentLoginWorker = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      import { loginChallenge, loginVerify } from './packages/community/accounts.ts';
      export default { async fetch(request, env) {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/fixture/concurrent-logins')
          return new Response('not_found', { status: 404 });
        const { context, wallet, signature } = await request.json();
        const challenges = await Promise.all(Array.from({ length: 8 },
          () => loginChallenge(env.DB, context, wallet)));
        const sessions = await Promise.all(challenges.map(c =>
          loginVerify(env.DB, context, c.id, signature, async () => true)));
        return Response.json(sessions);
      }};
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["node:*"],
});
async function fixture() {
  // The pinned local engine supports dates through August 6. This fixture tests
  // D1 semantics, not the November 4 deployed Worker's compatibility profile.
  const runtime = new Miniflare({
    modules: true,
    script: concurrentLoginWorker.outputFiles[0].text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of [
      "0001_setup.sql",
      "0002_first_song.sql",
      "0013_learning_authorization.sql",
    ]) {
      const sql = await readFile(
        new URL(
          `../apps/community-wizard/infra/migrations/${name}`,
          import.meta.url,
        ),
        "utf8",
      );
      const statements = sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(statements.map((s) => db.prepare(s)));
    }
    return {
      db,
      async concurrentLogins() {
        const response = await runtime.dispatchFetch(
          origin + "/fixture/concurrent-logins",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ context, wallet, signature }),
          },
        );
        assert.equal(response.status, 200);
        return (await response.json()) as Awaited<
          ReturnType<typeof loginVerify>
        >[];
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
const keys = [
  { scope: "community:one", period: "2026-11-04", asset: "test:units" },
  { scope: "account:one", period: "2026-11-04", asset: "test:units" },
];

test("concurrent verified MOSS logins converge on one private account and separate author", async () => {
  const f = await fixture();
  try {
    const sessions = await f.concurrentLogins();
    assert.equal(sessions.length, 8);
    assert.equal(new Set(sessions.map((session) => session.cookie)).size, 8);
    const account = await f.db
      .prepare("SELECT * FROM community_accounts")
      .all<{ account_id: string; author_id: string }>();
    assert.equal(account.results.length, 1);
    assert.match(account.results[0]!.author_id, /^0x[0-9a-f]{64}$/);
    assert.notEqual(
      account.results[0]!.author_id,
      account.results[0]!.account_id,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM credential_bindings")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_sessions")
        .first<{ n: number }>())!.n,
      8,
    );
    const request = new Request(origin + "/api/session", {
      headers: { cookie: sessions[0]!.cookie.split(";")[0]! },
    });
    const session = await accountSession(request, f.db, context);
    assert.equal(session.account_id, account.results[0]!.account_id);
    assert.equal(session.wallet, wallet);
    await assert.rejects(
      authenticatedWrite(
        new Request(origin + "/api/submit", {
          headers: { cookie: sessions[0]!.cookie.split(";")[0]!, origin },
        }),
        f.db,
        context,
      ),
      /csrf_required/,
    );
    await assert.rejects(
      authenticatedWrite(
        new Request(origin + "/api/submit", {
          headers: {
            cookie: sessions[0]!.cookie.split(";")[0]!,
            origin: "https://attacker.example",
            "x-csrf-token": sessions[0]!.csrf,
          },
        }),
        f.db,
        context,
      ),
      /wrong_origin/,
    );
  } finally {
    await f.dispose();
  }
});

test("a database and authenticated session cannot silently become another community", async () => {
  const f = await fixture();
  try {
    const challenge = await loginChallenge(f.db, context, wallet);
    const session = await loginVerify(
      f.db,
      context,
      challenge.id,
      signature,
      verifyFixtureSignature,
    );
    const other = {
      ...context,
      communityId:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    } as const;
    await assert.rejects(
      ensureCommunityIdentity(f.db, other),
      /database_community_mismatch/,
    );
    const request = new Request(origin + "/api/session", {
      headers: { cookie: session.cookie.split(";")[0]! },
    });
    await assert.rejects(
      accountSession(request, f.db, other),
      /session_required/,
    );
    await assert.rejects(
      loginVerify(f.db, other, challenge.id, signature, verifyFixtureSignature),
      /expired_or_replayed_challenge/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_accounts")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("expiry during asynchronous signature verification creates no accepted session", async () => {
  const f = await fixture();
  try {
    const challenge = await loginChallenge(f.db, context, wallet);
    await assert.rejects(
      loginVerify(f.db, context, challenge.id, signature, async () => {
        await f.db
          .prepare(
            "UPDATE login_challenges SET expires_at=? WHERE challenge_id=?",
          )
          .bind(Date.now() - 1, challenge.id)
          .run();
        return true;
      }),
      /expired_or_replayed_challenge/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_accounts")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_sessions")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("replaying a concurrently verified login challenge creates exactly one session", async () => {
  const f = await fixture();
  try {
    const c = await loginChallenge(f.db, context, wallet);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        loginVerify(f.db, context, c.id, signature, verifyFixtureSignature),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_sessions")
        .first<{ n: number }>())!.n,
      1,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_accounts")
        .first<{ n: number }>())!.n,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("invalid proof and expiry cannot create an account or session", async () => {
  const f = await fixture();
  try {
    const time = Date.now(),
      c = await loginChallenge(f.db, context, wallet, time);
    await assert.rejects(
      loginVerify(f.db, context, c.id, signature, async () => false, time),
      /invalid_login_signature/,
    );
    await assert.rejects(
      loginVerify(
        f.db,
        context,
        c.id,
        signature,
        verifyFixtureSignature,
        time + 300_000,
      ),
      /expired_or_replayed_challenge/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_accounts")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM community_sessions")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("concurrent reservations enforce both account and community caps atomically", async () => {
  const f = await fixture();
  try {
    await configureBudget(f.db, keys[0]!, "3");
    await configureBudget(f.db, keys[1]!, "2");
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        reserveBudget(f.db, `job:${i}`, `request:${i}`, keys, "1"),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    const rows = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .all<{ reserved: string; spent: string }>();
    assert.deepEqual(
      rows.results.map((r) => [r.reserved, r.spent]),
      [
        ["2", "0"],
        ["2", "0"],
      ],
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM spending_reservations")
        .first<{ n: number }>())!.n,
      4,
    );
  } finally {
    await f.dispose();
  }
});

test("large native amounts stay exact and a retry cannot reserve a second charge", async () => {
  const f = await fixture();
  try {
    const k = [keys[0]!],
      value = "1152921504606846977";
    await configureBudget(f.db, k[0]!, value);
    await reserveBudget(f.db, "one", "same-request", k, value);
    await reserveBudget(f.db, "one", "same-request", k, value);
    await assert.rejects(
      reserveBudget(f.db, "one", "different-request", k, value),
      /reservation_conflict/,
    );
    await assert.rejects(
      reserveBudget(f.db, "two", "another-request", k, "1"),
      /funding_cap_exhausted/,
    );
    const row = await f.db
      .prepare("SELECT reserved FROM spending_budgets")
      .first<{ reserved: string }>();
    assert.equal(row!.reserved, value);
  } finally {
    await f.dispose();
  }
});

test("concurrent settlement releases unused funds exactly once while preserving other reservations", async () => {
  const f = await fixture();
  try {
    for (const k of keys) await configureBudget(f.db, k, "10");
    await reserveBudget(f.db, "one", "one-request", keys, "4");
    await reserveBudget(f.db, "two", "two-request", keys, "3");
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => settleBudget(f.db, "one", keys, "2")),
    );
    for (const outcome of outcomes)
      assert.equal(
        outcome.status,
        "fulfilled",
        outcome.status === "rejected" ? String(outcome.reason) : undefined,
      );
    const rows = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .all<{ reserved: string; spent: string }>();
    assert.deepEqual(
      rows.results.map((r) => [r.reserved, r.spent]),
      [
        ["3", "2"],
        ["3", "2"],
      ],
    );
    await assert.rejects(
      settleBudget(f.db, "one", keys, "3"),
      /settlement_conflict/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM transaction_guards")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("failure in a later reservation rolls back every earlier bucket write", async () => {
  const f = await fixture();
  try {
    for (const k of keys) await configureBudget(f.db, k, "10");
    await f.db.exec(
      "CREATE TRIGGER fixture_reservation_failure BEFORE INSERT ON spending_reservations WHEN NEW.scope='account:one' BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;",
    );
    await assert.rejects(
      reserveBudget(f.db, "one", "one-request", keys, "4"),
      /fixture_failure/,
    );
    const rows = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .all<{ reserved: string; spent: string }>();
    assert.deepEqual(
      rows.results.map((r) => [r.reserved, r.spent]),
      [
        ["0", "0"],
        ["0", "0"],
      ],
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM spending_reservations")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM transaction_guards")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

// Run a real competing transaction between reads. Unbatched SELECTs expose a
// mixed snapshot; a read batch returns its coherent snapshot before the winner
// commits, so the caller must lose its CAS and reconcile the existing result.
function interleaveReservationRead(
  db: D1Database,
  winner: () => Promise<void>,
) {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const reservationSelects = new WeakSet<object>();
  let started = false;
  let selectCount = 0;
  let releaseRead!: () => void;
  const firstWinner = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let competing: Promise<void> | undefined;
  function compete() {
    if (!started) {
      started = true;
      competing = winner().finally(releaseRead);
    }
    return competing!;
  }
  function statement(
    raw: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    const wrapped = new Proxy(raw, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        if (
          property === "first" &&
          sql.startsWith("SELECT * FROM spending_reservations")
        ) {
          return async (...args: unknown[]) => {
            if (selectCount++ > 0) await firstWinner;
            const result = await Reflect.apply(target.first, target, args);
            await compete();
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, raw);
    if (sql.startsWith("SELECT * FROM spending_reservations"))
      reservationSelects.add(wrapped);
    return wrapped;
  }
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const raw = statements.map((s) => originals.get(s) ?? s);
          const result = await target.batch(raw);
          // Reservation SELECT results have amount/request_hash, while empty
          // results are also possible. Track SQL explicitly rather than values.
          if (statements.some((s) => reservationSelects.has(s)))
            await compete();
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, triggered: () => started, drain: () => competing };
}

for (const operation of ["reserve", "settle"] as const) {
  test(`${operation} reconciles a winning request across the complete budget snapshot`, async () => {
    const f = await fixture();
    let race: ReturnType<typeof interleaveReservationRead> | undefined;
    try {
      for (const k of keys) await configureBudget(f.db, k, "4");
      if (operation === "settle")
        await reserveBudget(f.db, "one", "request", keys, "4");
      const run = (db: D1Database) =>
        operation === "reserve"
          ? reserveBudget(db, "one", "request", keys, "4")
          : settleBudget(db, "one", keys, "2");
      race = interleaveReservationRead(f.db, () => run(f.db));
      await run(race.db);
      assert.equal(race.triggered(), true);
      const rows = await f.db
        .prepare("SELECT reserved,spent FROM spending_budgets")
        .all();
      assert.deepEqual(
        rows.results.map((r) => [r.reserved, r.spent]),
        operation === "reserve"
          ? [
              ["4", "0"],
              ["4", "0"],
            ]
          : [
              ["0", "2"],
              ["0", "2"],
            ],
      );
      assert.equal(
        (await f.db
          .prepare("SELECT COUNT(*) AS n FROM transaction_guards")
          .first())!.n,
        0,
      );
    } finally {
      await race?.drain();
      await f.dispose();
    }
  });
}
