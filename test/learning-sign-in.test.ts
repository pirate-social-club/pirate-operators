// V4 sign-in on the application's D1 schema: the challenge is SignIn typed
// data, verification creates the same account, binding and session as SIWE,
// and only a verified V4 sign-in stores a pending publication authorization.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountSession,
  loginChallenge,
  loginVerify,
  signInFromMessage,
  type SignInChallenge,
  type SignInV4,
} from "../packages/community/accounts.ts";
import { signInIdV4 } from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  publicResults,
  recordedAuthorization,
  relaySignIn,
} from "../services/learning-sign-in.ts";
import { verifyLoginOffline } from "../harness/login-verifier.ts";

const origin = "https://community.example";
const context = {
  origin,
  communityId: `0x${"aa".repeat(32)}`,
} as const;
// Public local fixture key. Never fund it.
const learner = privateKeyToAccount(`0x${"21".repeat(32)}`);
const subject = learner.address.toLowerCase();
const v4: SignInV4 = {
  chainId: 6343,
  contract: "0x00000000000000000000000000000000000000c4",
  communityId: context.communityId,
  publicationPolicy: learningV4PublicityPolicy,
  policyVersion: 4,
};

async function database(
  migrations = [
    "0001_setup.sql",
    "0002_first_song.sql",
    "0013_learning_authorization.sql",
  ],
) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  const db = await runtime.getD1Database("DB");
  const migrate = async (names: string[]) => {
    for (const name of names) {
      const sql = await readFile(
        new URL(
          `../apps/community-wizard/infra/migrations/${name}`,
          import.meta.url,
        ),
        "utf8",
      );
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
  };
  await migrate(migrations);
  const count = async (table: string) =>
    (await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
      .first<{ n: number }>())!.n;
  return { db, migrate, count, dispose: () => runtime.dispose() };
}
const signChallenge = (c: SignInChallenge, account = learner) =>
  account.signTypedData({
    domain: c.typedData.domain,
    types: c.typedData.types,
    primaryType: "SignIn",
    // The wallet signs exactly the decimal-string message it receives.
    message: c.typedData.message as never,
  });
async function v4Challenge(db: D1Database, time = Date.now()) {
  const c = await loginChallenge(db, context, learner.address, time, v4);
  assert.ok("kind" in c);
  return c;
}

test("a V4 challenge is the SignIn typed data for this learner, community and policy", async () => {
  const f = await database();
  try {
    const time = 1_800_000_000_123;
    const c = await v4Challenge(f.db, time);
    assert.equal(c.kind, "sign-in-v4");
    assert.match(c.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(c.typedData.domain, {
      name: "Pirate Learning Results",
      version: "4",
      chainId: 6343,
      verifyingContract: getAddress(v4.contract),
    });
    assert.equal(c.typedData.primaryType, "SignIn");
    const m = c.typedData.message;
    assert.equal(m.learner, learner.address);
    assert.equal(m.communityId, context.communityId);
    assert.equal(m.origin, origin);
    assert.equal(m.publicationPolicy, learningV4PublicityPolicy);
    assert.match(m.nonce, /^0x[0-9a-f]{64}$/);
    assert.equal(m.issuedAt, "1800000000");
    assert.equal(m.expiresAt, "1800000300");
    assert.ok(!("message" in c));
    const row = await f.db
      .prepare(
        "SELECT kind,policy_version,subject,expires_at FROM login_challenges WHERE challenge_id=?",
      )
      .bind(c.id)
      .first();
    assert.deepEqual(row, {
      kind: "sign-in-v4",
      policy_version: 4,
      subject,
      expires_at: time + 300_000,
    });
    // Each challenge has its own single-use nonce.
    const other = await v4Challenge(f.db, time);
    assert.notEqual(other.typedData.message.nonce, m.nonce);
    // Without V4 the challenge is the SIWE message, exactly as before.
    const siwe = await loginChallenge(f.db, context, learner.address, time);
    assert.deepEqual(Object.keys(siwe).sort(), ["id", "message"]);
    assert.ok(siwe.message.includes("Chain ID: 6343"));
    assert.equal(
      (await f.db
        .prepare("SELECT kind FROM login_challenges WHERE challenge_id=?")
        .bind(siwe.id)
        .first<{ kind: string }>())!.kind,
      "siwe",
    );
    await assert.rejects(
      loginChallenge(f.db, context, learner.address, time, {
        ...v4,
        communityId: `0x${"bb".repeat(32)}`,
      }),
      /sign_in_unavailable/,
    );
  } finally {
    await f.dispose();
  }
});

test("V4 verify creates the SIWE account, binding and session plus one pending authorization", async () => {
  const f = await database();
  try {
    const c = await v4Challenge(f.db);
    const signature = await signChallenge(c);
    const verified = await loginVerify(
      f.db,
      context,
      c.id,
      signature,
      verifyLoginOffline,
    );
    const id = signInIdV4(
      6343,
      v4.contract,
      signInFromMessage(c.typedData.message),
    );
    assert.equal(verified.authorizationId, id);
    const binding = await f.db
      .prepare(
        "SELECT account_id,namespace,network,subject FROM credential_bindings",
      )
      .all<{ account_id: string }>();
    assert.equal(binding.results.length, 1);
    assert.deepEqual(
      { ...binding.results[0], account_id: undefined },
      { account_id: undefined, namespace: "moss", network: 6343, subject },
    );
    assert.equal(await f.count("community_accounts"), 1);
    assert.equal(await f.count("community_sessions"), 1);
    const session = await accountSession(
      new Request(origin + "/api/session", {
        headers: { cookie: verified.cookie.split(";")[0]! },
      }),
      f.db,
      context,
    );
    assert.equal(session.wallet, subject);
    assert.equal(session.csrf_token, verified.csrf);
    const rows = await f.db
      .prepare("SELECT * FROM learning_authorizations")
      .all<Record<string, unknown>>();
    assert.equal(rows.results.length, 1);
    const row = rows.results[0]!;
    assert.equal(row.authorization_id, id);
    assert.equal(row.account_id, binding.results[0]!.account_id);
    assert.equal(row.subject, subject);
    assert.equal(row.state, "pending");
    assert.equal(row.policy_hash, learningV4PublicityPolicy);
    assert.equal(row.policy_version, 4);
    assert.equal(row.issued_at, Number(c.typedData.message.issuedAt));
    assert.equal(row.signature, signature.toLowerCase());
    assert.equal(row.tx_hash, null);
    assert.deepEqual(
      JSON.parse(String(row.sign_in_json)),
      c.typedData.message,
    );
    assert.equal(
      await publicResults(f.db, session.account_id, true),
      "pending",
    );
    assert.equal(
      await publicResults(f.db, session.account_id, false),
      "unavailable",
    );
    // Replaying the consumed challenge is refused and stores nothing more.
    await assert.rejects(
      loginVerify(f.db, context, c.id, signature, verifyLoginOffline),
      /expired_or_replayed_challenge/,
    );
    assert.equal(await f.count("learning_authorizations"), 1);
    assert.equal(await f.count("community_sessions"), 1);
    // Once a sign-in is recorded, later sign-ins need no relay.
    await f.db
      .prepare("UPDATE learning_authorizations SET state='recorded'")
      .run();
    assert.equal(await publicResults(f.db, session.account_id, true), "on");
    const again = await v4Challenge(f.db);
    const second = await loginVerify(
      f.db,
      context,
      again.id,
      await signChallenge(again),
      verifyLoginOffline,
    );
    assert.equal(second.authorizationId, undefined);
    assert.equal(await f.count("learning_authorizations"), 1);
    assert.equal(await f.count("community_sessions"), 2);
    assert.equal(await f.count("credential_bindings"), 1);
  } finally {
    await f.dispose();
  }
});

test("a withdrawn account signs in but gets no authorization row", async () => {
  const f = await database();
  try {
    // A first SIWE sign-in creates the account; the learner then withdraws.
    const siwe = await loginChallenge(f.db, context, learner.address);
    await loginVerify(
      f.db,
      context,
      siwe.id,
      await learner.signMessage({ message: siwe.message }),
      verifyLoginOffline,
    );
    const { account_id } = (await f.db
      .prepare("SELECT account_id FROM credential_bindings")
      .first<{ account_id: string }>())!;
    await f.db
      .prepare(
        "INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES(?1,?2,?2)",
      )
      .bind(account_id, Date.now())
      .run();
    const c = await v4Challenge(f.db);
    const verified = await loginVerify(
      f.db,
      context,
      c.id,
      await signChallenge(c),
      verifyLoginOffline,
    );
    assert.equal(verified.authorizationId, undefined);
    assert.equal(await f.count("community_sessions"), 2);
    assert.equal(await f.count("learning_authorizations"), 0);
    assert.equal(await publicResults(f.db, account_id, true), "off");
  } finally {
    await f.dispose();
  }
});

test("after a withdrawal and turn-on, only a sign-in issued after the last withdrawal counts", async () => {
  const f = await database();
  try {
    const t0 = 1_800_000_000_000;
    const signInAt = async (time: number) => {
      const c = await v4Challenge(f.db, time);
      return loginVerify(
        f.db,
        context,
        c.id,
        await signChallenge(c),
        verifyLoginOffline,
        time,
      );
    };
    const first = await signInAt(t0);
    assert.ok(first.authorizationId);
    const { account_id } = (await f.db
      .prepare("SELECT account_id FROM credential_bindings")
      .first<{ account_id: string }>())!;
    await f.db
      .prepare("UPDATE learning_authorizations SET state='recorded'")
      .run();
    assert.equal(await publicResults(f.db, account_id, true), "on");
    assert.deepEqual(
      await recordedAuthorization(f.db, account_id, subject, t0 / 1000 + 60),
      { id: first.authorizationId },
    );
    // Withdrawn: a sign-in signs in but records nothing.
    const withdrawnAt = t0 + 10_000;
    await f.db
      .prepare(
        "INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES(?1,?2,?2)",
      )
      .bind(account_id, withdrawnAt)
      .run();
    assert.equal(await publicResults(f.db, account_id, true), "off");
    assert.equal((await signInAt(t0 + 20_000)).authorizationId, undefined);
    assert.equal(await f.count("learning_authorizations"), 1);
    // Turned on: the withdrawal is cleared and its time kept.
    await f.db
      .prepare(
        "UPDATE learning_settings SET public_results_withdrawn_at=NULL WHERE account_id=?",
      )
      .bind(account_id)
      .run();
    // The older recorded sign-in no longer counts for anything.
    assert.equal(await publicResults(f.db, account_id, true), "off");
    assert.deepEqual(
      await recordedAuthorization(f.db, account_id, subject, t0 / 1000 + 60),
      { id: null, pending: false },
    );
    // A sign-in in the withdrawal's own second is not after it.
    const sameSecond = await signInAt(withdrawnAt);
    assert.ok(sameSecond.authorizationId);
    assert.equal(await publicResults(f.db, account_id, true), "off");
    const relayed: string[] = [];
    const env = {
      KARAOKE_OPERATOR: {
        async fetch() {
          relayed.push("relay");
          return Response.json({ error: "operator_unavailable" }, { status: 503 });
        },
      },
    } as never;
    await relaySignIn(env, f.db, sameSecond.authorizationId!, withdrawnAt + 1);
    assert.deepEqual(relayed, []);
    assert.equal(
      (await f.db
        .prepare("SELECT state FROM learning_authorizations WHERE authorization_id=?")
        .bind(sameSecond.authorizationId)
        .first<{ state: string }>())!.state,
      "refused",
    );
    // The next sign-in is stored despite the older recorded row, and counts.
    const next = await signInAt(t0 + 30_000);
    assert.ok(next.authorizationId);
    assert.equal(await publicResults(f.db, account_id, true), "pending");
    assert.deepEqual(
      await recordedAuthorization(f.db, account_id, subject, t0 / 1000 + 60),
      { id: null, pending: true },
    );
    await f.db
      .prepare(
        "UPDATE learning_authorizations SET state='recorded' WHERE authorization_id=?",
      )
      .bind(next.authorizationId)
      .run();
    assert.equal(await publicResults(f.db, account_id, true), "on");
    assert.deepEqual(
      await recordedAuthorization(f.db, account_id, subject, t0 / 1000 + 60),
      { id: next.authorizationId },
    );
    // Once recorded since the withdrawal, later sign-ins need no relay again.
    assert.equal((await signInAt(t0 + 40_000)).authorizationId, undefined);
    // While withdrawn the settings row must keep the withdrawal time.
    await assert.rejects(
      f.db
        .prepare(
          "UPDATE learning_settings SET public_results_withdrawn_at=1,last_withdrawn_at=NULL",
        )
        .run(),
    );
  } finally {
    await f.dispose();
  }
});

test("SIWE challenges and signatures never produce an authorization", async () => {
  const f = await database(["0001_setup.sql", "0002_first_song.sql"]);
  try {
    // A challenge issued before migration 0011 is SIWE once migrated.
    const old = await loginChallenge(f.db, context, learner.address);
    await f.migrate(["0013_learning_authorization.sql"]);
    const verified = await loginVerify(
      f.db,
      context,
      old.id,
      await learner.signMessage({ message: old.message }),
      verifyLoginOffline,
    );
    assert.equal(verified.authorizationId, undefined);
    assert.equal(await f.count("community_sessions"), 1);
    // Even a verifier that accepts anything cannot turn SIWE into permission.
    const siwe = await loginChallenge(f.db, context, learner.address);
    await loginVerify(f.db, context, siwe.id, "0x1234", async (_a, proof) => {
      assert.equal(typeof proof, "string");
      return true;
    });
    assert.equal(await f.count("community_sessions"), 2);
    // A personal (SIWE-style) signature over a V4 challenge does not verify.
    const c = await v4Challenge(f.db);
    await assert.rejects(
      loginVerify(
        f.db,
        context,
        c.id,
        await learner.signMessage({ message: JSON.stringify(c.typedData) }),
        verifyLoginOffline,
      ),
      /invalid_login_signature/,
    );
    // Nor does another wallet's typed signature.
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    await assert.rejects(
      loginVerify(
        f.db,
        context,
        c.id,
        await signChallenge(c, other),
        verifyLoginOffline,
      ),
      /invalid_login_signature/,
    );
    assert.equal(await f.count("learning_authorizations"), 0);
    assert.equal(await f.count("community_sessions"), 2);
  } finally {
    await f.dispose();
  }
});

test("expired and concurrently replayed V4 challenges are refused as today", async () => {
  const f = await database();
  try {
    const time = Date.now();
    const expired = await v4Challenge(f.db, time - 300_000);
    await assert.rejects(
      loginVerify(
        f.db,
        context,
        expired.id,
        await signChallenge(expired),
        verifyLoginOffline,
      ),
      /expired_or_replayed_challenge/,
    );
    // Expiry during asynchronous verification creates nothing.
    const racing = await v4Challenge(f.db, time);
    const racingSignature = await signChallenge(racing);
    await assert.rejects(
      loginVerify(f.db, context, racing.id, racingSignature, async (...a) => {
        await f.db
          .prepare(
            "UPDATE login_challenges SET expires_at=? WHERE challenge_id=?",
          )
          .bind(Date.now() - 1, racing.id)
          .run();
        return verifyLoginOffline(...a);
      }),
      /expired_or_replayed_challenge/,
    );
    assert.equal(await f.count("community_accounts"), 0);
    assert.equal(await f.count("learning_authorizations"), 0);
    const c = await v4Challenge(f.db, time);
    const signature = await signChallenge(c);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        loginVerify(f.db, context, c.id, signature as Hex, verifyLoginOffline),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results)
      if (r.status === "rejected")
        assert.match(String(r.reason), /expired_or_replayed_challenge/);
    assert.equal(await f.count("community_sessions"), 1);
    assert.equal(await f.count("community_accounts"), 1);
    assert.equal(await f.count("learning_authorizations"), 1);
  } finally {
    await f.dispose();
  }
});
