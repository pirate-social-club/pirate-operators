// Source-only preparation. Failure cases precede service implementation.
// Cover real HTTP/D1 session + CSRF, account/credential incarnations, origin/community,
// expiry and changes after awaits. Private practice must not query public permissions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { privateKeyToAccount } from "viem/accounts";
import type { AuthContext } from "../packages/community/accounts.ts";
import { CommunityError, hashText } from "../packages/community/common.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import { DancePrivateRequestSession } from "../services/dance-private-session.ts";

const context: AuthContext = {
  origin: "https://private-dance.invalid",
  communityId: `0x${"a1".repeat(32)}`,
};
// Public offline fixture keys, never managed credentials or funded accounts.
const signer = privateKeyToAccount(`0x${"31".repeat(32)}`);
const other = privateKeyToAccount(`0x${"32".repeat(32)}`);
const worker = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
  import {verifyMessage} from 'viem';
  import {loginChallenge,loginVerify} from './packages/community/accounts.ts';
  import {CommunityError} from './packages/community/common.ts';
  import {DanceStore} from './packages/dance/store.ts';
  import {DancePrivateRequestSession} from './services/dance-private-session.ts';
  const context=${JSON.stringify(context)};
  export default {async fetch(request,env){try{
    const path=new URL(request.url).pathname;
    if(path==='/api/login/challenge') return Response.json(await loginChallenge(env.DB,context,(await request.json()).wallet));
    if(path==='/api/login/verify'){
      const body=await request.json();
      return Response.json(await loginVerify(env.DB,context,body.id,body.signature,
        (address,message,signature)=>verifyMessage({address,message,signature})));
    }
    if(path!=='/api/private') return new Response('not_found',{status:404});
    const session=await DancePrivateRequestSession.open(request,env.DB,context);
    await session.check();
    const fences=session.fences;
    await new DanceStore(env.DB).assert([...fences]);
    await session.check();
    return Response.json({actor:session.actor,fenceCount:fences.length});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'unknown'},
    {status:e instanceof CommunityError?e.status:503});}}};
`,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["node:*"],
});

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: worker.outputFiles[0].text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
  });
  try {
    const native = await runtime.getD1Database("DB");
    for (const name of ["0001_setup.sql", "0002_first_song.sql"]) {
      const sql = await readFile(
        new URL(
          `../apps/community-wizard/infra/migrations/${name}`,
          import.meta.url,
        ),
        "utf8",
      );
      await native.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => native.prepare(s)),
      );
    }
    const dance = await readFile(
      new URL("../packages/dance/schema.sql", import.meta.url),
      "utf8",
    );
    const guard = dance.match(/CREATE TABLE dance_transaction_guards[^;]*;/);
    assert.ok(guard);
    await native.prepare(guard[0]).run();
    async function login(account = signer) {
      const challengeResponse = await runtime.dispatchFetch(
        context.origin + "/api/login/challenge",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: account.address }),
        },
      );
      assert.equal(challengeResponse.status, 200);
      const challenge = (await challengeResponse.json()) as {
        id: string;
        message: string;
      };
      const verified = await runtime.dispatchFetch(
        context.origin + "/api/login/verify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: challenge.id,
            signature: await account.signMessage({
              message: challenge.message,
            }),
          }),
        },
      );
      assert.equal(verified.status, 200);
      const result = (await verified.json()) as {
        cookie: string;
        csrf: string;
        authorizationId?: string;
      };
      assert.equal(
        result.authorizationId,
        undefined,
        "plain private login creates no publication authorization",
      );
      const cookie = result.cookie.split(";")[0];
      const row = await native
        .prepare(
          "SELECT s.session_hash,s.account_id,s.binding_id,a.author_id,c.subject AS wallet FROM community_sessions s JOIN community_accounts a ON a.account_id=s.account_id JOIN credential_bindings c ON c.binding_id=s.binding_id WHERE s.session_hash=?",
        )
        .bind(hashText(cookie.slice(cookie.indexOf("=") + 1)))
        .first<{
          session_hash: string;
          account_id: string;
          binding_id: string;
          author_id: string;
          wallet: string;
        }>();
      assert.ok(row);
      return { ...result, cookie, row };
    }
    const auth = await login();
    const request = (method = "POST") =>
      new Request(context.origin + "/api/private", {
        method,
        headers: {
          cookie: auth.cookie,
          origin: context.origin,
          "sec-fetch-site": "same-origin",
          "x-csrf-token": auth.csrf,
          "x-dance-account": auth.row.account_id,
        },
      });
    return {
      runtime,
      native,
      db: native as unknown as D1Database,
      auth,
      request,
      login,
      close: () => runtime.dispose(),
    };
  } catch (e) {
    await runtime.dispose();
    throw e;
  }
}
const changed = (e: unknown) =>
  e instanceof CommunityError &&
  e.code === "dance_private_session_changed" &&
  e.status === 409;

/** Observe/delay delivery only. Every statement, bind, row and authority
 * decision comes from the native D1 engine and actual shared auth helpers. */
function observed(
  db: D1Database,
  after: (sql: string) => Promise<void> | void,
  queries: string[] = [],
) {
  function statement(
    native: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    return new Proxy(native, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        if (key === "first")
          return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            const row = await target.first(...args);
            queries.push(sql);
            await after(sql);
            return row;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => statement(target.prepare(sql), sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("actual HTTP + D1 plain login permits private GET/POST with no public-consent/install schema", async () => {
  const f = await fixture();
  try {
    for (const method of ["GET", "POST"]) {
      const req = f.request(method),
        response = await f.runtime.dispatchFetch(req.url, {
          method,
          headers: Object.fromEntries(req.headers),
        });
      assert.equal(response.status, 200);
      const result = (await response.json()) as {
        actor: Record<string, string>;
        fenceCount: number;
      };
      assert.deepEqual(result.actor, {
        accountId: f.auth.row.account_id,
        wallet: signer.address.toLowerCase(),
        bindingId: f.auth.row.binding_id,
        authorId: f.auth.row.author_id,
      });
      assert.ok(result.fenceCount > 0);
      assert.notEqual(result.actor.accountId, result.actor.wallet);
      assert.notEqual(result.actor.accountId, result.actor.authorId);
    }
    const tables = await f.native
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all<{ name: string }>();
    assert.ok(
      !tables.results.some((t) =>
        /^(publication_v1_|learning_authorizations$|publication_installation|operator_transactions$)/.test(
          t.name,
        ),
      ),
    );
  } finally {
    await f.close();
  }
});

for (const kind of [
  "cookie",
  "csrf",
  "read csrf",
  "origin",
  "fetch-site",
  "host",
  "expected account",
] as const)
  test(`actual private HTTP rejects wrong ${kind}`, async () => {
    const f = await fixture();
    try {
      const req = f.request(kind === "read csrf" ? "GET" : "POST");
      let url = req.url;
      if (kind === "cookie") req.headers.delete("cookie");
      if (kind === "csrf" || kind === "read csrf")
        req.headers.set("x-csrf-token", "wrong");
      if (kind === "origin")
        req.headers.set("origin", "https://foreign.invalid");
      if (kind === "fetch-site")
        req.headers.set("sec-fetch-site", "cross-site");
      if (kind === "host") url = "https://foreign.invalid/api/private";
      if (kind === "expected account")
        req.headers.set("x-dance-account", f.auth.row.author_id);
      const response = await f.runtime.dispatchFetch(url, {
        method: req.method,
        headers: Object.fromEntries(req.headers),
      });
      assert.equal(
        response.status,
        kind === "cookie" ? 401 : kind === "expected account" ? 409 : 403,
      );
      const body: unknown = await response.json();
      assert.ok(body !== null && typeof body === "object");
      assert.equal(Object.hasOwn(body, "actor"), false);
    } finally {
      await f.close();
    }
  });

test("optional expected-account header stays private-ID based; GET can use a plain cookie", async () => {
  const f = await fixture();
  try {
    const req = f.request("GET");
    req.headers.delete("x-dance-account");
    req.headers.delete("x-csrf-token");
    req.headers.delete("origin");
    const session = await DancePrivateRequestSession.open(req, f.db, {
      ...context,
    });
    await session.check();
    assert.equal(session.actor.accountId, f.auth.row.account_id);
    assert.ok(Object.isFrozen(session.actor));
    assert.ok(Object.isFrozen(session.fences));
    const queries: string[] = [];
    const plain = await DancePrivateRequestSession.open(
      req,
      observed(f.db, () => undefined, queries),
      { ...context },
    );
    await plain.check();
    assert.ok(queries.length > 0);
    assert.ok(
      !queries.some((sql) =>
        /grant|learning_|publication|installation|nonce/i.test(sql),
      ),
    );
  } finally {
    await f.close();
  }
});

for (const kind of [
  "logout",
  "csrf",
  "author",
  "wallet",
  "account created",
  "credential created",
  "account row",
  "credential row",
  "session row",
  "application community",
  "application origin",
] as const)
  test(`captured request + actual accepting D1 fences reject ${kind} replacement`, async () => {
    const f = await fixture();
    try {
      const session = await DancePrivateRequestSession.open(f.request(), f.db, {
        ...context,
      });
      const fences = session.fences;
      const sql =
        kind === "logout"
          ? "DELETE FROM community_sessions WHERE session_hash=?"
          : kind === "csrf"
            ? "UPDATE community_sessions SET csrf_token='renewed' WHERE session_hash=?"
            : kind === "author"
              ? "UPDATE community_accounts SET author_id='0x" +
                "b2".repeat(32) +
                "' WHERE account_id=?"
              : kind === "wallet"
                ? "UPDATE credential_bindings SET subject='" +
                  other.address.toLowerCase() +
                  "' WHERE binding_id=?"
                : kind === "account created"
                  ? "UPDATE community_accounts SET created_at=created_at+1 WHERE account_id=?"
                  : kind === "credential created"
                    ? "UPDATE credential_bindings SET created_at=created_at+1 WHERE binding_id=?"
                    : kind === "account row"
                      ? "UPDATE community_accounts SET rowid=rowid+100 WHERE account_id=?"
                      : kind === "credential row"
                        ? "UPDATE credential_bindings SET rowid=rowid+100 WHERE binding_id=?"
                        : kind === "session row"
                          ? "UPDATE community_sessions SET rowid=rowid+100 WHERE session_hash=?"
                          : kind === "application community"
                            ? "UPDATE application_identity SET community_id='0x" +
                              "c3".repeat(32) +
                              "' WHERE id=?"
                            : "UPDATE application_identity SET community_origin='https://replacement.invalid' WHERE id=?";
      const value = kind.startsWith("application")
        ? 1
        : ["author", "account created", "account row"].includes(kind)
          ? f.auth.row.account_id
          : ["wallet", "credential created", "credential row"].includes(kind)
            ? f.auth.row.binding_id
            : f.auth.row.session_hash;
      await f.native.prepare(sql).bind(value).run();
      await assert.rejects(session.check(), changed);
      await assert.rejects(
        new DanceStore(f.db).assert([...fences]),
        /dance_fence_changed/,
      );
      assert.equal(
        await f.native
          .prepare("SELECT count(*) n FROM dance_transaction_guards")
          .first<number>("n"),
        0,
      );
    } finally {
      await f.close();
    }
  });

for (const header of [
  "cookie",
  "x-csrf-token",
  "origin",
  "sec-fetch-site",
  "x-dance-account",
])
  test(`header change during a real D1 await is rejected: ${header}`, async () => {
    const f = await fixture();
    try {
      const req = f.request();
      let changedOnce = false;
      const db = observed(f.db, () => {
        if (!changedOnce) {
          changedOnce = true;
          req.headers.set(header, "changed-after-native-read");
        }
      });
      await assert.rejects(
        DancePrivateRequestSession.open(req, db, { ...context }),
        changed,
      );
    } finally {
      await f.close();
    }
  });

test("A-to-B-to-A headers and context cannot revive the original request capability", async () => {
  const f = await fixture();
  try {
    const req = f.request(),
      liveContext = { ...context };
    const session = await DancePrivateRequestSession.open(
      req,
      f.db,
      liveContext,
    );
    const saved = req.headers.get("cookie")!,
      b = await f.login(other);
    req.headers.set("cookie", b.cookie);
    await assert.rejects(session.check(), changed);
    req.headers.set("cookie", saved);
    await assert.rejects(session.check(), changed);
    assert.throws(() => session.fences, changed);
    const fresh = await DancePrivateRequestSession.open(req, f.db, liveContext);
    liveContext.origin = "https://replacement.invalid";
    await assert.rejects(fresh.check(), changed);
    liveContext.origin = context.origin;
    await assert.rejects(fresh.check(), changed);
  } finally {
    await f.close();
  }
});

test("same-account renewed login is a different session and cannot retarget pending private work", async () => {
  const f = await fixture();
  try {
    const req = f.request(),
      session = await DancePrivateRequestSession.open(req, f.db, {
        ...context,
      });
    const renewed = await f.login();
    assert.equal(renewed.row.account_id, f.auth.row.account_id);
    req.headers.set("cookie", renewed.cookie);
    req.headers.set("x-csrf-token", renewed.csrf);
    await assert.rejects(session.check(), changed);
    const fresh = await DancePrivateRequestSession.open(req, f.db, {
      ...context,
    });
    assert.equal(fresh.actor.accountId, f.auth.row.account_id);
    await fresh.check();
  } finally {
    await f.close();
  }
});

test("context replacement during a native await fails instead of trusting a copied old application", async () => {
  const f = await fixture();
  try {
    const live = { ...context };
    let changedOnce = false;
    const db = observed(f.db, () => {
      if (!changedOnce) {
        changedOnce = true;
        live.communityId = `0x${"b2".repeat(32)}`;
      }
    });
    await assert.rejects(
      DancePrivateRequestSession.open(f.request(), db, live),
      changed,
    );
  } finally {
    await f.close();
  }
});

test("native DB time independently expires an already checked accepting fence", async () => {
  const f = await fixture();
  try {
    const expiry = Date.now() + 1500;
    await f.native
      .prepare(
        "UPDATE community_sessions SET expires_at=? WHERE session_hash=?",
      )
      .bind(expiry, f.auth.row.session_hash)
      .run();
    const session = await DancePrivateRequestSession.open(f.request(), f.db, {
        ...context,
      }),
      fences = session.fences;
    const until = Date.now() + 3000;
    let now = 0;
    do {
      now =
        (await f.native
          .prepare("SELECT " + DANCE_DB_NOW + " n")
          .first<number>("n")) ?? 0;
      if (now < expiry) await pause(5);
    } while (now < expiry && Date.now() < until);
    assert.ok(now >= expiry, "actual D1 clock reached the exclusive expiry");
    await assert.rejects(session.check(), changed);
    await assert.rejects(
      new DanceStore(f.db).assert([...fences]),
      /dance_fence_changed/,
    );
  } finally {
    await f.close();
  }
});

test("temporary native delivery failure fails closed and permits a same-request retry without rebinding authority", async () => {
  const f = await fixture();
  try {
    let unavailable = false;
    const db = observed(f.db, () => {
      if (unavailable) throw Error("fixture_native_delivery_unavailable");
    });
    const session = await DancePrivateRequestSession.open(f.request(), db, {
      ...context,
    });
    unavailable = true;
    await assert.rejects(
      session.check(),
      (e: unknown) =>
        e instanceof CommunityError &&
        e.code === "dance_private_session_uncertain" &&
        e.status === 503,
    );
    unavailable = false;
    await session.check();
    assert.equal(session.actor.accountId, f.auth.row.account_id);
  } finally {
    await f.close();
  }
});
