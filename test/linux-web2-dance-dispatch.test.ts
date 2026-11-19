import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountSession } from "../packages/community/accounts.ts";
import { canonical } from "../packages/community/common.ts";
import { DanceV2ActionStore, DANCE_V2_ACTIONS_SCHEMA_PROPOSAL } from "../services/dance-v2-action-store.ts";
import { dispatchCommittedDanceAction, nativeDanceDispatchReadyResponse } from "../services/linux-web2-dance-dispatch.ts";
import { assertNativeDanceDispatchProofCurrent, readNativeDanceDispatchProof } from "../services/native-dance-dispatch-proof.ts";
import { publicationAcceptSessionHeader, publicationHostOrigin } from "../services/native-publication-reference.ts";
import { nativeDanceDispatchPath, nativeDanceDispatchReadyPath, nativeDanceResponse, type NativeDanceRetainedReference } from "../services/native-dance-retained-reference.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";

const word = (digit: string) => ("0x" + digit.repeat(64)) as `0x${string}`;
const address = (digit: string) => ("0x" + digit.repeat(40)) as `0x${string}`;
const forward = "11".repeat(32), reverse = "22".repeat(32);
const origin = "https://dance.example";
const account = "00000000-0000-4000-8000-000000000001";

function fixture() {
  const local = new MemorySqliteD1();
  const db = local.asD1();
  local.sqlite.exec(`
    CREATE TABLE dance_transaction_guards (guard_id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
    CREATE TABLE fixture_current_dance_authority (media INTEGER, consent INTEGER, grant INTEGER);
    INSERT INTO fixture_current_dance_authority VALUES (1,1,1);
    CREATE TABLE community_accounts(account_id TEXT PRIMARY KEY, author_id TEXT);
    CREATE TABLE credential_bindings(binding_id TEXT PRIMARY KEY, account_id TEXT, namespace TEXT, network INTEGER, subject TEXT);
    CREATE TABLE community_sessions(session_hash TEXT PRIMARY KEY, account_id TEXT, binding_id TEXT,
      community_id TEXT, community_origin TEXT, csrf_token TEXT, expires_at INTEGER);
  `);
  for (const sql of DANCE_V2_ACTIONS_SCHEMA_PROPOSAL) local.sqlite.exec(sql);
  const scope = { chainId: 6343 as const, communityId: word("1"), installationId: word("2"),
    releaseSha256: word("3"), publisher: address("4"), verifier: address("5"), sourceHash: word("6") };
  const actor: AccountSession = {
    session_hash: word("7"), account_id: account, binding_id: "binding", author_id: word("8"),
    wallet: address("9"), csrf_token: "fixture-csrf", expires_at: Date.now() + 60000,
  };
  local.sqlite.prepare("INSERT INTO community_accounts VALUES (?,?)").run(account, actor.author_id);
  local.sqlite.prepare("INSERT INTO credential_bindings VALUES (?,?,'moss',6343,?)").run(actor.binding_id, account, actor.wallet);
  const insertSession = (owner: AccountSession) => local.sqlite.prepare("INSERT INTO community_sessions VALUES (?,?,?,?,?,?,?)")
    .run(owner.session_hash, owner.account_id, owner.binding_id, scope.communityId, origin, owner.csrf_token, owner.expires_at);
  insertSession(actor);
  const store = new DanceV2ActionStore(db);
  const capture = word("a");
  const original = store.original(scope.communityId, capture, "register", account, { commandId: "register-original" });
  const ready = { command_id: original.command_id, source_hash: scope.sourceHash, publisher: scope.publisher,
    command_hash: word("b"), resource_id: word("c"), encoded: "0x12" as const, calldata: "0x1234" as const };
  const ref: NativeDanceRetainedReference = {
    schema: "pirate.native-dance-retained-reference/1", installationId: scope.installationId,
    releaseSha256: scope.releaseSha256, original: { chainId: 6343, communityId: scope.communityId, kind: "register",
      verifier: scope.verifier, publisher: scope.publisher, sourceHash: scope.sourceHash, commandId: original.command_id,
      commandHash: ready.command_hash, resourceId: ready.resource_id },
  };
  const mount = { db, scope, origin, async assertCurrent() {} };
  const commit = async () => {
    await store.reserve(original, word("d")).run();
    await db.batch([store.prepare(ready), store.prepareDispatchSession(ready, actor)]);
  };
  const request = (reference = ref, access = reverse, session = actor.session_hash) =>
    new Request(origin + nativeDanceDispatchReadyPath, {
      method: "POST", body: canonical(reference),
      headers: { authorization: "Bearer " + access, "content-type": "application/json",
        [publicationAcceptSessionHeader]: session },
    });
  return { local, actor, insertSession, store, original, ready, ref, mount, commit, request };
}

test("native Dance effect is unavailable before the ready row and its session pin commit", async () => {
  const f = fixture();
  try {
    let forwarded = 0;
    const ports = { forward, reverse, host: {
      async fetch(input: RequestInfo | URL) {
        const request = new Request(input);
        forwarded++;
        assert.equal(request.url, publicationHostOrigin + nativeDanceDispatchPath);
        assert.equal(request.headers.get(publicationAcceptSessionHeader), f.actor.session_hash);
        assert.equal(request.headers.get("cookie"), null);
        assert.equal(request.headers.get("x-csrf-token"), null);
        assert.deepEqual(await request.json(), f.ref);
        return nativeDanceResponse(f.ref, { nonce: 0, hash: word("e") });
      },
    } };
    await f.store.reserve(f.original, word("d")).run();
    await assert.rejects(f.mount.db.batch([
      f.store.prepare(f.ready), f.mount.db.prepare("INSERT INTO absent_stage_table VALUES (1)"),
    ]));
    await assert.rejects(dispatchCommittedDanceAction(f.ready.command_id, f.actor, f.mount, ports));
    assert.equal(forwarded, 0);
    await f.mount.db.batch([f.store.prepare(f.ready), f.store.prepareDispatchSession(f.ready, f.actor)]);
    await dispatchCommittedDanceAction(f.ready.command_id, f.actor, f.mount, ports);
    assert.equal(forwarded, 1);
  } finally {
    f.local.sqlite.close();
  }
});

test("private reverse Dance effect binds directional capability, exact ready reference and accepted live session", async () => {
  const f = fixture();
  try {
    await f.commit();
    const otherSession = { ...f.actor, session_hash: word("f") };
    f.insertSession(otherSession);
    let ran = 0;
    const resolve = (request: Request, capabilities = { forward, reverse }) =>
      nativeDanceDispatchReadyResponse(request, capabilities, async () => f.mount,
        async (action, ready, session) => {
          ran++;
          assert.equal(action.account_id, account);
          assert.deepEqual(ready, f.ready);
          assert.deepEqual(session, f.actor);
          return { fences: [], expiresAtMs: f.actor.expires_at + 1000 };
        });
    assert.equal((await resolve(f.request(f.ref, forward))).status, 404);
    const withoutSession = f.request();
    withoutSession.headers.delete(publicationAcceptSessionHeader);
    assert.equal((await resolve(withoutSession)).status, 503);
    assert.equal((await resolve(f.request(), { forward: reverse, reverse })).status, 404);
    const changedReference = { ...f.ref, original: { ...f.ref.original, commandHash: word("e") } };
    assert.equal((await resolve(f.request(changedReference))).status, 503);
    assert.equal((await resolve(f.request(f.ref, reverse, otherSession.session_hash))).status, 503);
    assert.equal(ran, 0);

    const positive = await resolve(f.request());
    assert.equal(positive.status, 200);
    assert.deepEqual(readNativeDanceDispatchProof(await positive.text(), f.ref),
      { calldata: f.ready.calldata, expiresAtMs: f.actor.expires_at });
    assert.equal(ran, 1);

    f.local.sqlite.prepare("UPDATE credential_bindings SET subject=? WHERE binding_id=?").run(address("a"), f.actor.binding_id);
    assert.equal((await resolve(f.request())).status, 503);
    f.local.sqlite.prepare("UPDATE credential_bindings SET subject=? WHERE binding_id=?").run(f.actor.wallet, f.actor.binding_id);
    const revoked = await nativeDanceDispatchReadyResponse(f.request(), { forward, reverse }, async () => f.mount,
      async () => {
        f.local.sqlite.prepare("DELETE FROM community_sessions WHERE session_hash=?").run(f.actor.session_hash);
        return { fences: [], expiresAtMs: f.actor.expires_at };
      });
    assert.equal(revoked.status, 503);
    assert.equal((await resolve(f.request())).status, 503);
    assert.equal(ran, 1);
  } finally {
    f.local.sqlite.close();
  }
});

test("the final primary batch refuses media, consent and grant changes after canonical revalidation", async () => {
  const f = fixture();
  try {
    await f.commit();
    for (const changed of ["media", "consent", "grant"] as const) {
      let verified = false;
      const mount = { ...f.mount, async assertCurrent() {
        if (verified) f.local.sqlite.exec(`UPDATE fixture_current_dance_authority SET ${changed}=0`);
      } };
      const outcome = await nativeDanceDispatchReadyResponse(f.request(), { forward, reverse }, async () => mount,
        async () => {
          const row = f.local.sqlite.prepare("SELECT * FROM fixture_current_dance_authority").get();
          assert.deepEqual({ ...row }, { media: 1, consent: 1, grant: 1 });
          verified = true;
          const fences = ["media", "consent", "grant"].map((name) => ({
            sql: `EXISTS(SELECT 1 FROM fixture_current_dance_authority WHERE ${name}=1)`, values: [],
          }));
          return { fences, expiresAtMs: f.actor.expires_at };
        });
      assert.equal(outcome.status, 503);
      assert.equal(await outcome.text(), "");
      f.local.sqlite.exec(`UPDATE fixture_current_dance_authority SET ${changed}=1`);
    }
    f.local.afterBatch = () => {
      f.local.beforeRead = () => { throw new Error("unexpected read after final primary batch"); };
    };
    const accepted = await nativeDanceDispatchReadyResponse(f.request(), { forward, reverse }, async () => f.mount,
      async () => ({
        fences: [{ sql: "EXISTS(SELECT 1 FROM fixture_current_dance_authority WHERE media=1 AND consent=1 AND grant=1)", values: [] }],
        expiresAtMs: f.actor.expires_at,
      }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(readNativeDanceDispatchProof(await accepted.text(), f.ref),
      { calldata: f.ready.calldata, expiresAtMs: f.actor.expires_at });
  } finally {
    f.local.sqlite.close();
  }
});

test("dispatch proof rejects bare calldata, wrong reference and a deadline reached in transit", async () => {
  const f = fixture();
  try {
    const raw = await nativeDanceResponse(f.ref, { calldata: f.ready.calldata, expiresAtMs: f.actor.expires_at }).text();
    const proof = readNativeDanceDispatchProof(raw, f.ref);
    assertNativeDanceDispatchProofCurrent(proof.expiresAtMs, proof.expiresAtMs - 1);
    assert.throws(() => assertNativeDanceDispatchProofCurrent(proof.expiresAtMs, proof.expiresAtMs),
      /native_dance_dispatch_proof_expired/);
    const legacy = await nativeDanceResponse(f.ref, f.ready.calldata).text();
    assert.throws(() => readNativeDanceDispatchProof(legacy, f.ref));
    const other = { ...f.ref, original: { ...f.ref.original, resourceId: word("e") } };
    assert.throws(() => readNativeDanceDispatchProof(raw, other), /native_dance_reply_changed/);
  } finally {
    f.local.sqlite.close();
  }
});

test("an earlier media or grant deadline expires a reference-bound reply in transit while the session is live", async t => {
  const f = fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  try {
    await f.commit();
    const originMs = now;
    for (const expiry of [
      { media: originMs + 20000, grant: originMs + 40000 },
      { media: originMs + 40000, grant: originMs + 20000 },
    ]) {
      now = originMs;
      const cutoff = Math.min(expiry.media, expiry.grant);
      const response = await nativeDanceDispatchReadyResponse(f.request(), { forward, reverse }, async () => f.mount,
        async () => ({ fences: [], expiresAtMs: cutoff }));
      assert.equal(response.status, 200);
      const raw = await response.text();
      now = cutoff - 1;
      assert.deepEqual(readNativeDanceDispatchProof(raw, f.ref), { calldata: f.ready.calldata, expiresAtMs: cutoff });
      now = cutoff;
      assert.ok(now < f.actor.expires_at);
      assert.throws(() => readNativeDanceDispatchProof(raw, f.ref), /native_dance_dispatch_proof_expired/);
    }
  } finally {
    f.local.sqlite.close();
  }
});

test("the final primary clock fence rejects a deadline already passed at D1 while Workerd remains pre-expiry", async t => {
  const f = fixture();
  try {
    await f.commit();
    const expiredAtMs = Date.now() - 10000;
    t.mock.method(Date, "now", () => expiredAtMs - 1);
    const response = await nativeDanceDispatchReadyResponse(f.request(), { forward, reverse }, async () => f.mount,
      async () => ({ fences: [], expiresAtMs: expiredAtMs }));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "");
  } finally {
    f.local.sqlite.close();
  }
});
