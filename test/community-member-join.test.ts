import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { communityRuntime } from "./community-runtime.ts";
import { hashText } from "../packages/community/common.ts";
import { communityNamesApi, type CommunityMemberPorts } from "../services/community-names-api.ts";
import type { CommunityJoinPolicy, MemberContext } from "../packages/community-names/member-authorization.ts";
import { memberContext } from "../packages/community-names/member-authorization.ts";
import { nativeProfileDigest } from "../packages/community-names/member-api.ts";

// SOURCE ONLY / UNRUN. Real pinned Miniflare D1 and real accountSession /
// authenticatedWrite, with explicitly simulated policy decisions. These
// simulations qualify neither an actual admission policy nor V4 issuance.
const h=(n:string)=>`0x${n.repeat(64)}` as `0x${string}`;
const origin="https://community.example",key="join-request-00000001";
async function fixture() {
  const runtime=await communityRuntime(),db=runtime.db as unknown as D1Database,now=Date.now();
  const ddl=await readFile(new URL("../schema/community-member-operations.sql",import.meta.url),"utf8");
  await db.batch(ddl.split("-- @statement\n").slice(1).map(s=>db.prepare(s.trim())));
  await db.prepare("INSERT INTO application_identity VALUES(1,?,?)").bind(h("1"),origin).run();
  const context:MemberContext={installationId:h("2"),linuxInstallationId:"linux:fixture-a/original",communityId:h("1"),origin,profileDigest:nativeProfileDigest("3".repeat(64)),
    fence:{sql:"EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)",values:[h("1"),origin]}};
  const users=new Map<string,{cookie:string;csrf:string}>();
  async function user(id:string,digit:string) {
    const token=digit.repeat(64),csrf=`csrf-${id}`,account=`account-${id}`,binding=`binding-${id}`,wallet=`0x${digit.repeat(40)}`;
    await db.batch([
      db.prepare("INSERT INTO community_accounts VALUES(?,?,?)").bind(account,h(digit),now),
      db.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)").bind(binding,account,wallet,now),
      db.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)").bind(hashText(token),h("1"),origin,account,binding,csrf,now+3600000),
    ]); users.set(id,{cookie:`__Host-community_session=${token}`,csrf});
  }
  await user("a","a");await user("b","b");
  const policy:CommunityJoinPolicy={authorize:async()=>({policyId:"fixture-explicit-policy",revision:"1",evidenceDigest:h("4"),validUntilMs:now+3600000,fence:context.fence}),revalidate:async()=>{}};
  const ports:CommunityMemberPorts={db,context:async()=>structuredClone(context),joinPolicy:policy,now:()=>now};
  async function request(path="/api/community/join",method="GET",body?:unknown,id="a",overrides:Record<string,string>={}) {
    const u=users.get(id)!;
    const headers={cookie:u.cookie,origin,"sec-fetch-site":"same-origin","content-type":"application/json","x-csrf-token":u.csrf,...overrides};
    const response=await communityNamesApi(new Request(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),ports);
    assert.ok(response);return response;
  }
  const count=async()=>(await db.prepare("SELECT count(*) n FROM community_member_operations").first<{n:number}>())!.n;
  return {runtime,db,ports,context,policy,users,request,count};
}

test("Join requires an acknowledged durable acceptance; GET is private and observational",async()=>{
  const f=await fixture();try {
    const before=await f.request();assert.equal(before.status,200);assert.equal((await before.json()).state,"not_joined");assert.equal(await f.count(),0);
    assert.equal(before.headers.get("cache-control"),"no-store");assert.equal(before.headers.get("vary"),"Cookie");
    const accepted=await f.request(undefined,"POST",{idempotencyKey:key});assert.equal(accepted.status,200);
    const body=await accepted.json();assert.equal(body.state,"accepted");assert.ok(body.receipt.joinId);assert.equal(await f.count(),1);
    const read=await(await f.request()).json();assert.deepEqual(read,body);
    const other=await(await f.request(undefined,"GET",undefined,"b")).json();assert.equal(other.state,"not_joined");assert.notEqual(other.ownerScope,read.ownerScope);
    assert.equal(await f.count(),1);
  }finally{await f.runtime.dispose();}
});
test("missing/rejected actual policy never invents open admission or optimistic Joined",async()=>{
  const f=await fixture();try {
    f.ports.joinPolicy=undefined;
    const missing=await f.request(undefined,"POST",{idempotencyKey:key});assert.equal(missing.status,503);
    assert.deepEqual((await missing.json()).reason,"policy_unavailable");assert.equal(await f.count(),0);
    f.ports.joinPolicy={...f.policy,authorize:async()=>null};
    const refused=await f.request(undefined,"POST",{idempotencyKey:key});assert.equal(refused.status,403);assert.equal((await refused.json()).state,"blocked");
    assert.equal((await(await f.request()).json()).state,"not_joined");assert.equal(await f.count(),0);
  }finally{await f.runtime.dispose();}
});
test("same/different Join idempotency keys converge and lost response recovers the accepted original",async()=>{
  const f=await fixture();try {
    const replies=await Promise.all(Array.from({length:4},(_,i)=>f.request(undefined,"POST",{idempotencyKey:i%2?"join-request-00000002":key})));
    for(const r of replies)assert.equal(r.status,200);
    const bodies=await Promise.all(replies.map(r=>r.json()));assert.equal(new Set(bodies.map(b=>b.receipt.joinId)).size,1);assert.equal(await f.count(),1);
    // Discard every POST response: a subsequent GET still recovers the fact.
    f.ports.joinPolicy=undefined;
    const recovered=await(await f.request()).json();assert.equal(recovered.receipt.joinId,bodies[0].receipt.joinId);
    const retry=await f.request(undefined,"POST",{idempotencyKey:key});assert.equal(retry.status,200);assert.equal(await f.count(),1);
  }finally{await f.runtime.dispose();}
});
test("actual session/Origin/CSRF checks and strict DTOs precede durable writes",async()=>{
  const f=await fixture();try {
    for(const [headers,status] of [[{cookie:""},401],[{"x-csrf-token":"wrong"},403],[{origin:"https://elsewhere.example"},403],[{"sec-fetch-site":"cross-site"},403]] as const) {
      const r=await f.request(undefined,"POST",{idempotencyKey:key},"a",headers);assert.equal(r.status,status);
    }
    for(const body of [{idempotencyKey:key,recipient:h("a")},{idempotencyKey:key+"\n"},{idempotencyKey:"short"}]) {
      assert.equal((await f.request(undefined,"POST",body)).status,400);
    }
    assert.equal(await f.count(),0);
    assert.equal((await f.request("/api/community/join?account=other")).status,403);
    assert.equal((await f.request(undefined,"GET",undefined,"a",{origin:"https://elsewhere.example"})).status,403);
  }finally{await f.runtime.dispose();}
});
test("revocation during policy await aborts original and acceptance in the same D1 batch",async()=>{
  const f=await fixture();try {
    f.ports.joinPolicy={...f.policy,revalidate:async()=>{await f.db.prepare("DELETE FROM community_sessions WHERE account_id='account-a'").run();}};
    const r=await f.request(undefined,"POST",{idempotencyKey:key});assert.equal(r.status,503);assert.notEqual((await r.json()).state,"accepted");assert.equal(await f.count(),0);
    assert.equal((await f.request()).status,401);
    const guards=await f.db.prepare("SELECT count(*) n FROM transaction_guards").first<{n:number}>();assert.equal(guards?.n,0);
  }finally{await f.runtime.dispose();}
});
test("installation/context and credential changes do not silently remap original ownership",async()=>{
  const f=await fixture();try {
    const original=await(await f.request(undefined,"POST",{idempotencyKey:key})).json();
    f.context.installationId=h("5");assert.equal((await(await f.request()).json()).state,"not_joined");
    f.context.installationId=h("2");assert.equal((await(await f.request()).json()).receipt.joinId,original.receipt.joinId);
    await f.db.batch([
      f.db.prepare("INSERT INTO credential_bindings VALUES('replacement','account-a','moss',6343,?,?)").bind(`0x${"c".repeat(40)}`,Date.now()),
      f.db.prepare("UPDATE community_sessions SET binding_id='replacement' WHERE account_id='account-a'"),
    ]);
    assert.equal((await f.request()).status,404);assert.equal(await f.count(),1);
  }finally{await f.runtime.dispose();}
});
test("a failed/declined optional name step and missing issuer cannot erase accepted Join",async()=>{
  const f=await fixture();try {
    const joined=await(await f.request(undefined,"POST",{idempotencyKey:key})).json();
    const name=await f.request("/api/member-name/claims","POST",{idempotencyKey:"name-request-00000001",label:"eightaaa"});assert.equal(name.status,503);
    assert.equal((await name.json()).reason,"issuer_unavailable");
    assert.deepEqual(await(await f.request()).json(),joined);assert.equal(await f.count(),1);
  }finally{await f.runtime.dispose();}
});
test("native closed-schema admission remains explicit, not bypassed for Join",async()=>{
  const f=await fixture();try {
    await f.db.prepare("CREATE TABLE native_application_original(id INTEGER PRIMARY KEY)").run();
    const r=await f.request(undefined,"POST",{idempotencyKey:key});assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:"native_member_schema_not_admitted"});assert.equal(await f.count(),0);
  }finally{await f.runtime.dispose();}
});
test("native raw profile digest and Linux reference survive exactly beside Directory installation bytes32",async()=>{
  const f=await fixture();try {
    const raw="3".repeat(64),linux=f.context.linuxInstallationId;
    assert.equal(nativeProfileDigest(raw),raw);assert.equal(memberContext(f.context).profileDigest,raw);
    for(const invalid of ["0x"+raw,"F".repeat(64),raw+"\n","f".repeat(63)]) assert.throws(()=>nativeProfileDigest(invalid));
    assert.throws(()=>memberContext({...f.context,profileDigest:("0x"+raw) as MemberContext["profileDigest"]}));
    const original=await(await f.request(undefined,"POST",{idempotencyKey:key})).json();
    const row=await f.db.prepare("SELECT installation_id,linux_installation_id,original_json FROM community_member_operations").first<{installation_id:string;linux_installation_id:string;original_json:string}>();
    assert.equal(row?.installation_id,h("2"));assert.equal(row?.linux_installation_id,linux);
    assert.equal(JSON.parse(row!.original_json).context.profileDigest,raw);
    f.context.linuxInstallationId="linux:other/original";assert.equal((await(await f.request()).json()).state,"not_joined");
    f.context.linuxInstallationId=linux;assert.equal((await(await f.request()).json()).receipt.joinId,original.receipt.joinId);
  }finally{await f.runtime.dispose();}
});
