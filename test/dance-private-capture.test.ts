/** SOURCE ONLY / UNRUN. Real HTTP, cryptographic plain login and native D1.
 * Catalogue resource bytes are explicit fixture metadata, not a qualified
 * production catalogue, canonical media observation or publication permission. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { privateKeyToAccount } from "viem/accounts";
import { danceCaptureV2Fixture, word } from "./fixtures/dance-capture-v2.ts";
import { parseDanceCaptureV2, type PrivateCaptureV2 } from "../packages/dance/capture-v2.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";

const shape = danceCaptureV2Fixture();
const { captureId: _id, reservedAtMs: _time, ...selected } = shape.privateSnapshot;
const template = { ...selected, reference: null, offer: null };
const context = { origin: "https://private-capture.invalid", communityId: template.communityId };
const policy = { accepted: true, version: "private-media-fixture-v2", termsHash: template.termsHash,
  publicityPolicyHash: shape.pin.publicityPolicyHash };
// Public offline test keys. Never fund these fixture identities.
const signer = privateKeyToAccount(`0x${"33".repeat(32)}`);
const other = privateKeyToAccount(`0x${"34".repeat(32)}`);
const worker = await build({ stdin: { resolveDir: process.cwd(), contents: `
  import {verifyMessage} from 'viem';
  import {loginChallenge,loginVerify} from './packages/community/accounts.ts';
  import {canonical,CommunityError,insist} from './packages/community/common.ts';
  import {DancePrivateRequestSession} from './services/dance-private-session.ts';
  import {DancePrivateCaptureService} from './services/dance-private-capture.ts';
  const context=${JSON.stringify(context)};
  let selections=0,currents=0;
  export default {async fetch(request,env){try{
    const path=new URL(request.url).pathname;
    if(path==='/fixture/stats') return Response.json({selections,currents});
    if(path==='/api/login/challenge')return Response.json(await loginChallenge(env.DB,context,(await request.json()).wallet));
    if(path==='/api/login/verify'){
      const b=await request.json();return Response.json(await loginVerify(env.DB,context,b.id,b.signature,
        (address,message,signature)=>verifyMessage({address,message,signature})));
    }
    let fired=false;
    // Fault injection changes/drops native delivery only; statements and all
    // session/resource authority decisions execute unchanged in actual D1.
    const loss=request.headers.get('x-fixture-loss'),race=request.headers.get('x-fixture-race');
    const queries=new WeakMap(),originals=new WeakMap();
    function statement(raw,sql){const proxy=new Proxy(raw,{get(t,k){
      if(k==='bind')return(...values)=>statement(t.bind(...values),sql);
      const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;
    }});queries.set(proxy,sql);originals.set(proxy,raw);return proxy;}
    const actual=new Proxy(env.DB,{get(target,key){
      if(key==='prepare')return sql=>{const s=statement(target.prepare(sql),sql);queries.set(s,sql);return s;};
      if(key==='batch')return async statements=>{
        const capture=statements.some(s=>(queries.get(s)||'').includes('INSERT INTO dance_captures'));
        const consent=statements.some(s=>(queries.get(s)||'').includes('INSERT INTO dance_consents'));
        const matching=!fired&&((loss==='reserve'&&capture)||(loss==='consent'&&consent)||
          (race==='reserve-resource'&&capture)||(race==='consent-resource'&&consent)||(race==='reserve-session'&&capture));
        if(matching){fired=true;
          if(race==='reserve-session')await target.prepare('DELETE FROM community_sessions').run();
          else if(race)await target.prepare('UPDATE dance_host_selections SET revision=revision+1').run();
        }
        const result=await target.batch(statements.map(s=>originals.get(s)||s));
        if(matching&&loss)throw Error('fixture_lost_'+loss+'_ack');
        return result;
      };
      const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
    }});
    const session=await DancePrivateRequestSession.open(request,actual,context);
    function targetOf(c){return{communityId:c.communityId,songKey:c.songKey,songRevision:c.songRevision,
      audioSha256:c.audioSha256,reference:c.reference?{id:c.reference.id,revision:c.reference.revision}:null,offerId:c.offer?.offerId??null};}
    async function resource(actor,target){
      const row=await env.DB.prepare('SELECT rowid,revision,body_json FROM dance_host_selections WHERE community_id=? AND song_key=? AND reference_id=? AND offer_id=?')
        .bind(target.communityId,target.songKey,target.reference?.id??'',target.offerId??'').first();
      insist(row,'fixture_resource_unavailable',409);
      const body=JSON.parse(row.body_json),capture={...body.capture,learner:{accountId:actor.accountId,wallet:actor.wallet}};
      insist(canonical(targetOf(capture))===canonical(target),'fixture_target_changed',409);
      return {row,capture,consentPolicy:body.consentPolicy,fences:[{
        sql:'EXISTS(SELECT 1 FROM dance_host_selections WHERE rowid=? AND community_id=? AND song_key=? AND reference_id=? AND offer_id=? AND revision=? AND body_json=?)',
        values:[row.rowid,target.communityId,target.songKey,target.reference?.id??'',target.offerId??'',row.revision,row.body_json]}]};
    }
    const catalogue={
      async select(actor,target){selections++;const r=await resource(actor,target);
        const bad=request.headers.get('x-fixture-bad-selection');
        if(bad==='actor')r.capture.learner.accountId='foreign_account';
        if(bad==='target')r.capture.songRevision++;
        if(bad==='consent')r.consentPolicy={...r.consentPolicy,termsHash:'0x'+'ef'.repeat(32)};
        if(bad==='held')r.consentPolicy={...r.consentPolicy,admission:'review_pending'};
        if(bad==='fences')r.fences=[];
        return r;
      },
      async current(actor,capture){currents++;const r=await resource(actor,targetOf(capture));
        const{captureId,captureHash,consent,reservedAtMs,...core}=capture;
        insist(r.row.revision===capture.expected.configurationRevision&&canonical(r.capture)===canonical(core),
          'fixture_resource_changed',409);return r.fences;
      }
    };
    const service=new DancePrivateCaptureService({db:actual,session,catalogue,communityId:context.communityId});
    const capture=path==='/api/private/captures'?await service.capture(await request.json()):
      await service.access(path.slice('/api/private/captures/'.length));
    await session.check();return Response.json(capture);
  }catch(e){return Response.json({error:e instanceof Error?e.message:'unknown'},
    {status:e instanceof CommunityError?e.status:503});}}};
` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:*"] });

async function fixture() {
  const runtime = new Miniflare({ modules: true, script: worker.outputFiles[0].text,
    compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"] });
  try {
    const db = await runtime.getD1Database("DB");
    for (const file of ["0001_setup.sql", "0002_first_song.sql"]) {
      const sql = await readFile(new URL(`../apps/community-wizard/infra/migrations/${file}`, import.meta.url), "utf8");
      await db.batch(sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    const dance = await readFile(new URL("../packages/dance/schema.sql", import.meta.url), "utf8");
    for (const table of ["dance_captures", "dance_consents", "dance_transaction_guards"]) {
      const sql = dance.match(new RegExp("CREATE TABLE " + table + "[^;]*;")); assert.ok(sql); await db.prepare(sql[0]).run();
    }
    for (const trigger of dance.matchAll(/CREATE TRIGGER dance_(?:capture|consent)_no_(?:update|delete)[\s\S]*?END;/g))
      await db.prepare(trigger[0]).run();
    const host = await readFile(new URL("../services/dance-account-facts-store.ts", import.meta.url), "utf8");
    const resourceTable = host.match(/CREATE TABLE dance_host_selections[^;]*;/); assert.ok(resourceTable);
    await db.prepare(resourceTable[0]).run();
    const body = { capture: { ...template, expiresAtMs: Date.now() + 120000 },
      consentPolicy: { version: policy.version, termsHash: policy.termsHash, publicityPolicyHash: policy.publicityPolicyHash,
        text: "Fixture private-media consent.", admission: "admitted" } };
    await db.prepare("INSERT INTO dance_host_selections VALUES(?,?,?,?,?,?)")
      .bind(context.communityId, template.songKey, "", "", template.expected.configurationRevision, JSON.stringify(body)).run();
    async function login(account = signer) {
      const c = await runtime.dispatchFetch(context.origin + "/api/login/challenge", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: account.address }) });
      assert.equal(c.status, 200); const challenge = await c.json() as { id: string; message: string };
      const v = await runtime.dispatchFetch(context.origin + "/api/login/verify", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id: challenge.id,
          signature: await account.signMessage({ message: challenge.message }) }) });
      assert.equal(v.status, 200); return await v.json() as { cookie: string; csrf: string };
    }
    const auth = await login();
    const target = { communityId: template.communityId, songKey: template.songKey, songRevision: template.songRevision,
      audioSha256: template.audioSha256, reference: null, offerId: null };
    const request = { version: "pirate.dance-capture-request/2", commandId: "private_capture_command_01",
      target, publication: { kind: "private" }, consent: policy };
    async function send(value: unknown = request, headers: Record<string, string> = {}, as = auth) {
      return runtime.dispatchFetch(context.origin + "/api/private/captures", { method: "POST",
        headers: { cookie: as.cookie.split(";")[0], origin: context.origin, "sec-fetch-site": "same-origin",
          "x-csrf-token": as.csrf, "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
    }
    async function access(id: string, as = auth) {
      return runtime.dispatchFetch(context.origin + "/api/private/captures/" + id,
        { headers: { cookie: as.cookie.split(";")[0], "x-csrf-token": as.csrf } });
    }
    const count = async (table: "dance_captures" | "dance_consents") =>
      await db.prepare("SELECT count(*) n FROM " + table).first<number>("n");
    const stats = async () => await (await runtime.dispatchFetch(context.origin + "/fixture/stats")).json() as { selections: number; currents: number };
    return { runtime, db, body, auth, request, send, access, login, count, stats, close: () => runtime.dispose() };
  } catch (e) { await runtime.dispose(); throw e; }
}

async function accepted(response: Response): Promise<PrivateCaptureV2> {
  assert.equal(response.status, 200, await response.clone().text());
  const capture = parseDanceCaptureV2(await response.json());
  assert.ok(capture.version === "pirate.dance/2" && capture.publication.kind === "private" && capture.canonical === null);
  return capture as PrivateCaptureV2;
}

test("actual HTTP/D1 reserves a fresh bytes32 private capture then separately records exact media consent", async () => {
  const f = await fixture(); try {
    const first = await accepted(await f.send());
    assert.match(first.captureId, /^0x[0-9a-f]{64}$/); assert.notEqual(first.captureId, word(0));
    assert.equal(first.canonical, null); assert.equal(Object.hasOwn(first.learner, "authorizationId"), false);
    assert.ok(first.consent!.acceptedAtMs >= first.reservedAtMs && first.consent!.acceptedAtMs < first.expiresAtMs);
    const row = await f.db.prepare("SELECT capture_json FROM dance_captures WHERE capture_id=?").bind(first.captureId).first<string>("capture_json");
    assert.equal(JSON.parse(row!).consent, null); assert.equal(await f.count("dance_consents"), 1);
    assert.deepEqual(await accepted(await f.access(first.captureId)), first);
    const second = await accepted(await f.send({ ...f.request, commandId: "private_capture_command_02" }));
    assert.notEqual(second.captureId, first.captureId); assert.equal(await f.count("dance_captures"), 2);
    const tables = await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
    assert.ok(!tables.results.some(r => /publication_v1_|learning_authorizations|publication_installation|operator_transactions/.test(r.name)));
  } finally { await f.close(); }
});

test("accepted request replay returns original bytes before fresh catalogue selection; changed input conflicts", async () => {
  const f = await fixture(); try {
    const original = await accepted(await f.send()), before = await f.stats();
    assert.deepEqual(await accepted(await f.send()), original); assert.equal((await f.stats()).selections, before.selections);
    const changed = await f.send({ ...f.request, consent: { ...policy, version: "different-version" } });
    assert.equal(changed.status, 409); assert.equal(await f.count("dance_captures"), 1); assert.equal(await f.count("dance_consents"), 1);
  } finally { await f.close(); }
});

test("publication-bound requests fail explicitly without a private downgrade or fresh selection", async () => {
  const f = await fixture(); try {
    const response = await f.send({ ...f.request, publication: { kind: "publication-bound", publicationCommandId: word(99) } });
    assert.equal(response.status, 503); assert.match(await response.text(), /dance_publication_capture_unavailable/);
    assert.equal((await f.stats()).selections, 0); assert.equal(await f.count("dance_captures"), 0);
  } finally { await f.close(); }
});

for (const kind of ["actor", "target", "consent", "held", "fences"])
  test(`fresh resource selection refuses ${kind} mismatch before reservation`, async () => {
    const f = await fixture(); try {
      const response = await f.send(f.request, { "x-fixture-bad-selection": kind });
      assert.ok(response.status >= 400); assert.equal(await f.count("dance_captures"), 0); assert.equal(await f.count("dance_consents"), 0);
    } finally { await f.close(); }
  });

test("lost reserve acknowledgement reconciles the original request without allocating a second persisted capture", async () => {
  const f = await fixture(); try {
    const original = await accepted(await f.send(f.request, { "x-fixture-loss": "reserve" }));
    assert.equal(await f.count("dance_captures"), 1); assert.equal((await f.stats()).selections, 1);
    assert.deepEqual(await accepted(await f.send()), original);
  } finally { await f.close(); }
});

test("lost consent acknowledgement leaves the original receipt, and retry cannot replace its trusted time", async () => {
  const f = await fixture(); try {
    assert.equal((await f.send(f.request, { "x-fixture-loss": "consent" })).status, 503);
    const before = await f.db.prepare("SELECT consent_json FROM dance_consents").first<string>("consent_json"); assert.ok(before);
    const original = await accepted(await f.send());
    assert.equal(original.consent!.acceptedAtMs, JSON.parse(before).acceptedAtMs);
    assert.equal(await f.db.prepare("SELECT consent_json FROM dance_consents").first<string>("consent_json"), before);
    assert.equal((await f.stats()).selections, 1); assert.equal(await f.count("dance_captures"), 1);
  } finally { await f.close(); }
});

for (const race of ["reserve-resource", "consent-resource", "reserve-session"])
  test(`native accepting batch rejects ${race}, retaining only any original reservation`, async () => {
    const f = await fixture(); try {
      assert.equal((await f.send(f.request, { "x-fixture-race": race })).status, 409);
      assert.equal(await f.count("dance_captures"), race === "consent-resource" ? 1 : 0);
      assert.equal(await f.count("dance_consents"), 0); assert.equal((await f.stats()).selections, 1);
      if (race === "consent-resource") {
        assert.equal((await f.send()).status, 409); assert.equal((await f.stats()).selections, 1);
      }
    } finally { await f.close(); }
  });

test("another real private account cannot access a known capture ID", async () => {
  const f = await fixture(); try {
    const original = await accepted(await f.send()), b = await f.login(other);
    assert.equal((await f.access(original.captureId, b)).status, 404);
    assert.deepEqual(await accepted(await f.access(original.captureId)), original);
  } finally { await f.close(); }
});

test("resource replacement holds original capture and consent bytes rather than refreshing selection on replay", async () => {
  const f = await fixture(); try {
    await accepted(await f.send());
    const before = (await f.db.prepare("SELECT * FROM dance_captures").all()).results;
    const receipts = (await f.db.prepare("SELECT * FROM dance_consents").all()).results;
    await f.db.prepare("UPDATE dance_host_selections SET revision=revision+1").run();
    assert.equal((await f.send()).status, 409); assert.equal((await f.stats()).selections, 1);
    assert.deepEqual((await f.db.prepare("SELECT * FROM dance_captures").all()).results, before);
    assert.deepEqual((await f.db.prepare("SELECT * FROM dance_consents").all()).results, receipts);
  } finally { await f.close(); }
});

test("actual DB-time expiry denies private access without replacing an immutable capture", async () => {
  const f = await fixture(); try {
    f.body.capture.expiresAtMs = Date.now() + 2500;
    await f.db.prepare("UPDATE dance_host_selections SET body_json=?").bind(JSON.stringify(f.body)).run();
    const original = await accepted(await f.send());
    const until = Date.now() + 4000; let now = 0;
    do { now = await f.db.prepare("SELECT " + DANCE_DB_NOW + " n").first<number>("n") ?? 0;
      if (now < original.expiresAtMs) await pause(5); } while (now < original.expiresAtMs && Date.now() < until);
    assert.ok(now >= original.expiresAtMs);
    assert.equal((await f.access(original.captureId)).status, 410); assert.equal(await f.count("dance_captures"), 1);
  } finally { await f.close(); }
});
