import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { getAddress, keccak256 } from "viem";
import { communityRuntime } from "./community-runtime.ts";
import { accountSession } from "../packages/community/accounts.ts";
import { hashText } from "../packages/community/common.ts";
import { communityNamesApi, type CommunityMemberPorts } from "../services/community-names-api.ts";
import { CommunityMemberJournal, type OriginalGrant, type OriginalTransaction } from "../packages/community-names/member-journal.ts";
import { canonicalMemberLabel, decimal, parseConsent, nativeProfileDigest, type MemberHex } from "../packages/community-names/member-api.ts";
import type { MemberContext, MemberNamePorts, NameObservation, NamePreparation } from "../packages/community-names/member-authorization.ts";

// ALL UNRUN. Real Miniflare D1/session primitives; policy, preparation,
// signature, observation and envelope ports below are EXPLICIT SIMULATIONS.
// No generated V4 ABI exists in this packet. None of these fixtures represents
// a supported wallet, real issuer, signature or canonical receipt acceptance.
const h=(n:string)=>`0x${n.repeat(64)}` as MemberHex;
const origin="https://community.example",key="name-request-00000001",label="eightaaa";
async function fixture() {
  const runtime=await communityRuntime(),db=runtime.db as unknown as D1Database;let now=Date.now();
  const ddl=await readFile(new URL("../schema/community-member-operations.sql",import.meta.url),"utf8");
  await db.batch(ddl.split("-- @statement\n").slice(1).map(s=>db.prepare(s.trim())));
  await db.prepare("INSERT INTO application_identity VALUES(1,?,?)").bind(h("1"),origin).run();
  await db.prepare("CREATE TABLE member_fixture_authority(epoch INTEGER NOT NULL)").run();
  await db.prepare("INSERT INTO member_fixture_authority VALUES(1)").run();
  const context:MemberContext={installationId:h("2"),linuxInstallationId:"linux:fixture-a/original",communityId:h("1"),origin,profileDigest:nativeProfileDigest("3".repeat(64)),
    fence:{sql:"EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=?)",values:[h("1")]},
    name:{namespaceId:h("4"),tld:"example",sourceSha256:"5".repeat(64),interfaceDigest:h("6"),protocolVersion:4}};
  const users=new Map<string,{cookie:string;csrf:string;wallet:MemberHex}>();
  for(const [id,digit] of [["a","a"],["b","b"]]) {
    const token=digit.repeat(64),csrf=`csrf-${id}`,wallet=`0x${digit.repeat(40)}` as MemberHex;
    await db.batch([
      db.prepare("INSERT INTO community_accounts VALUES(?,?,?)").bind(`account-${id}`,h(digit),now),
      db.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)").bind(`binding-${id}`,`account-${id}`,wallet,now),
      db.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)").bind(hashText(token),h("1"),origin,`account-${id}`,`binding-${id}`,csrf,now+3600000),
    ]);users.set(id,{cookie:`__Host-community_session=${token}`,csrf,wallet});
  }
  const decision=()=>({policyId:"fixture-explicit",revision:"1",evidenceDigest:h("7"),validUntilMs:now+600000,
    fence:{sql:"EXISTS(SELECT 1 FROM member_fixture_authority WHERE epoch=?)",values:[1]}});
  let preparations=0,verifications=0,observations=0;
  let observationState:NameObservation["state"]="unknown",usable=false;
  const names:MemberNamePorts={
    policy:{authorize:async input=>({...decision(),budgets:[{role:"community",bucket:h("8"),limitWei:"2000000"},{role:"subject",bucket:input.session.account_id==="account-b"?h("a"):h("9"),limitWei:"2000000"}]}),revalidate:async()=>{}},
    preparation:{prepare:async input=>{
      preparations++;
      return {requestId:input.requestId,installationId:context.installationId,communityId:context.communityId,namespaceId:context.name!.namespaceId,
        sourceSha256:context.name!.sourceSha256,interfaceDigest:context.name!.interfaceDigest,recipient:getAddress(input.session.wallet),label:input.label,
        expectedTokenId:"123",generation:"1",terms:{initialPriceAtomic:"0",initialTermDays:365,
          annualRenewal:{token:`0x${"d".repeat(40)}`,amountAtomic:"12345"},gas:{payerAddress:`0x${"e".repeat(40)}`,maxTotalWei:"1000000"}},
        quote:{basePriceAtomic:"0",premiumAtomic:"0",effectivePriceAtomic:"0",maxCostAtomic:"0",digest:h("b"),validUntilMs:now+300000},
        consent:{digest:h("c"),expiresAtMs:now+300000,typedData:{domain:{name:"UNQUALIFIED-FIXTURE",version:"0",chainId:31337,verifyingContract:`0x${"f".repeat(40)}`},
          primaryType:"ClaimAcceptance",types:{ClaimAcceptance:[{name:"fixture",type:"bytes32"}]},message:{fixture:h("c")}}},original:{fixtureOnly:true}} satisfies NamePreparation;
    }},
    recipientVerifier:{verify:async input=>{verifications++;return {requestId:input.preparation.requestId,planDigest:input.planDigest,recipient:input.preparation.recipient,
      consentDigest:input.preparation.consent.digest,evidenceDigest:h("d"),validUntilMs:now+300000};}},
    observation:{observe:async input=>{
      observations++;return {requestId:input.preparation.requestId,planDigest:input.planDigest,sourceSha256:input.preparation.sourceSha256,evidenceDigest:h("e"),
        observedAtMs:now,validUntilMs:now+10000,state:observationState,...(observationState==="consumed"?{
          receipt:{transactionHash:h("f"),tokenId:"123",generation:"1",expiryMs:now+100000,blockNumber:"100",blockHash:h("a")},
          current:usable?{state:"usable" as const,recipient:input.preparation.recipient,tokenId:"123",generation:"1",expiresAtMs:now+100000}:{state:"not_usable" as const}}:{})};
    }},
  };
  const ports:CommunityMemberPorts={db,context:async()=>structuredClone(context),joinPolicy:{authorize:async()=>decision(),revalidate:async()=>{}},names,now:()=>now};
  function rawRequest(path:string,method="GET",body?:unknown,id="a",extra:RequestInit={}) {
    const u=users.get(id)!;return new Request(origin+path,{method,headers:{cookie:u.cookie,origin,"sec-fetch-site":"same-origin","content-type":"application/json","x-csrf-token":u.csrf},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),...extra});
  }
  async function request(path:string,method="GET",body?:unknown,id="a",extra:RequestInit={}) {
    const response=await communityNamesApi(rawRequest(path,method,body,id,extra),ports);assert.ok(response);return response;
  }
  const join=async(id="a")=>{const r=await request("/api/community/join","POST",{idempotencyKey:`join-request-${id}-000001`},id);assert.equal(r.status,200);};
  const prepare=async(k=key,l=label,id="a")=>request("/api/member-name/claims","POST",{idempotencyKey:k,label:l},id);
  const count=async(table="community_member_operations")=>(await db.prepare(`SELECT count(*) n FROM ${table}`).first<{n:number}>())!.n;
  const session=async(id="a")=>accountSession(rawRequest("/api/member-name","GET",undefined,id),db,context,now);
  return {runtime,db,ports,names,context,users,request,join,prepare,count,session,now:()=>now,advance:(ms:number)=>{now+=ms;},
    metrics:()=>({preparations,verifications,observations}),observation:(state:NameObservation["state"],isUsable=false)=>{observationState=state;usable=isUsable;}};
}

test("strict unchanged 8+ labels, zero initial price, 365-day term and explicit renewal/gas",async()=>{
  assert.equal(canonicalMemberLabel("eightaaa"),"eightaaa");assert.equal(canonicalMemberLabel("nineaaaaa"),"nineaaaaa");
  for(const s of ["sevenaa","Eightaaa"," eightaa","eightaaa ","eightaaa\n","eight.aa","xn--eightaaa","-eightaa","eightaa-","éightaaa","a".repeat(64)]) assert.throws(()=>canonicalMemberLabel(s));
  assert.throws(()=>decimal("0\n"));assert.throws(()=>parseConsent({planDigest:h("1")+"\n",recipientSignature:"0xab"}));
  const f=await fixture();try {
    const noJoin=await f.prepare();assert.equal(noJoin.status,403);assert.equal(f.metrics().preparations,0);
    await f.join();const p=await f.prepare();assert.equal(p.status,200);const v=await p.json();assert.equal(v.state,"awaiting_consent");
    assert.equal(v.terms.initialPriceAtomic,"0");assert.equal(v.terms.initialTermDays,365);assert.equal(v.terms.annualRenewal.amountAtomic,"12345");assert.equal(v.terms.gas.maxTotalWei,"1000000");
    assert.equal(Object.hasOwn(v,"joined"),false);assert.equal(Object.hasOwn(v,"membership"),false);
  }finally{await f.runtime.dispose();}
});
test("lost prepare ACK and concurrent duplicates recover one exact original and one reservation",async()=>{
  const f=await fixture();try {
    await f.join();const replies=await Promise.all([f.prepare(),f.prepare(),f.prepare()]);
    for(const r of replies)assert.equal(r.status,200);const bodies=await Promise.all(replies.map(r=>r.json()));
    assert.equal(new Set(bodies.map(b=>b.claim.requestId)).size,1);assert.equal(new Set(bodies.map(b=>b.claim.planDigest)).size,1);
    assert.equal(await f.count(),2);assert.equal(await f.count("community_member_artifacts"),1);
    const budgets=(await f.db.prepare("SELECT reserved_wei,revision FROM community_member_budgets").all<{reserved_wei:string;revision:number}>()).results;
    assert.equal(budgets.length,2);for(const b of budgets){assert.equal(b.reserved_wei,"1000000");assert.equal(b.revision,1);}
    const current=await(await f.request("/api/member-name")).json();assert.equal(current.claim.requestId,bodies[0].claim.requestId);
    const original=await(await f.request(`/api/member-name/claims/${current.claim.requestId}`)).json();assert.deepEqual(original,current);
    assert.equal((await f.prepare("name-request-00000002","otheraaa")).status,409);assert.equal(await f.count(),2);
  }finally{await f.runtime.dispose();}
});
test("private original lookup, installation/account binding and client overrides are refused",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json(),path=`/api/member-name/claims/${v.claim.requestId}`;
    assert.equal((await f.request(path,"GET",undefined,"b")).status,404);
    f.context.installationId=h("0").replace(/0$/,"1") as MemberHex;assert.equal((await f.request(path)).status,404);f.context.installationId=h("2");
    assert.equal((await f.request(`/api/member-name/claims/${h("b")}`)).status,404);
    const overrides=await f.request("/api/member-name/claims","POST",{idempotencyKey:key,label,recipient:`0x${"b".repeat(40)}`,rpc:"https://untrusted.example",issuer:h("a")});assert.equal(overrides.status,400);
    const before=f.metrics();await f.request("/api/member-name");assert.equal(f.metrics().preparations,before.preparations);assert.equal(f.metrics().verifications,before.verifications);assert.equal(await f.count(),2);
  }finally{await f.runtime.dispose();}
});
test("missing issuer versus unavailable verifier versus unsupported recipient remain precise",async()=>{
  const f=await fixture();try {
    await f.join();const prep=f.names.preparation;f.names.preparation=undefined;
    const noIssuer=await f.prepare();assert.equal(noIssuer.status,503);assert.equal((await noIssuer.json()).reason,"issuer_unavailable");assert.equal(await f.count(),1);
    f.names.preparation=prep;const verifier=f.names.recipientVerifier;f.names.recipientVerifier=undefined;
    const missing=await f.prepare();assert.equal(missing.status,503);assert.equal((await missing.json()).reason,"service_unavailable");assert.equal(await f.count(),1);
    f.names.recipientVerifier=verifier;const v=await(await f.prepare()).json(),path=`/api/member-name/claims/${v.claim.requestId}/consent`,input={planDigest:v.claim.planDigest,recipientSignature:"0xab"};
    f.names.recipientVerifier={verify:async()=>null};const unsupported=await f.request(path,"POST",input);assert.equal(unsupported.status,422);assert.equal((await unsupported.json()).reason,"recipient_unsupported");
    f.names.recipientVerifier=undefined;const absent=await f.request(path,"POST",input);assert.equal(absent.status,503);assert.equal((await absent.json()).reason,"service_unavailable");assert.equal(await f.count("community_member_artifacts"),1);
  }finally{await f.runtime.dispose();}
});
test("consent survives response loss/UI abort/logout; membership remains accepted and retry allocates nothing",async()=>{
  const f=await fixture();try {
    await f.join();const joined=await(await f.request("/api/community/join")).json(),v=await(await f.prepare()).json();
    const path=`/api/member-name/claims/${v.claim.requestId}`,input={planDigest:v.claim.planDigest,recipientSignature:"0xab"};
    const abort=new AbortController();abort.abort();
    const r=await f.request(path+"/consent","POST",input,"a",{signal:abort.signal});assert.equal(r.status,503);assert.equal((await r.json()).reason,"issuer_unavailable");
    const saved=(await f.db.prepare("SELECT payload_json FROM community_member_artifacts WHERE kind='consent'").first<{payload_json:string}>())!.payload_json;
    const retry=await f.request(path+"/consent","POST",input);assert.equal(retry.status,503);assert.equal(f.metrics().verifications,1);
    assert.equal((await f.request(path+"/consent","POST",{...input,recipientSignature:"0xcd"})).status,409);
    await f.db.prepare("DELETE FROM community_sessions WHERE account_id='account-a'").run();assert.equal((await f.request(path)).status,401);
    assert.equal((await f.db.prepare("SELECT payload_json FROM community_member_artifacts WHERE kind='consent'").first<{payload_json:string}>())!.payload_json,saved);
    await f.db.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)").bind(hashText("a".repeat(64)),h("1"),origin,"account-a","binding-a","csrf-a",Date.now()+3600000).run();
    assert.equal((await(await f.request(path)).json()).state,"blocked");assert.deepEqual(await(await f.request("/api/community/join")).json(),joined);
    assert.equal(await f.count("community_member_artifacts"),2);assert.equal(await f.count(),2);
  }finally{await f.runtime.dispose();}
});
test("fresh canonical evidence separates consumption from usability; a saved observation is insufficient",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json(),path=`/api/member-name/claims/${v.claim.requestId}`;
    f.observation("consumed",true);
    const reconciled=await f.request(path+"/reconcile","POST",{planDigest:v.claim.planDigest});assert.equal(reconciled.status,200);
    const consumed=await reconciled.json();assert.equal(consumed.state,"consumed");assert.equal(consumed.usability,"usable");
    f.observation("consumed",false);const transferred=await(await f.request(path+"/reconcile","POST",{planDigest:v.claim.planDigest})).json();assert.equal(transferred.state,"consumed");assert.equal(transferred.usability,"not_usable");
    f.names.observation=undefined;const unavailable=await f.request(path+"/reconcile","POST",{planDigest:v.claim.planDigest});assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).reason,"service_unavailable");
    const read=await f.request(path);assert.equal(read.status,503);assert.equal((await read.json()).reason,"service_unavailable");
    assert.equal((await(await f.request("/api/community/join")).json()).state,"accepted");assert.equal(await f.count(),2);
  }finally{await f.runtime.dispose();}
});
test("expiry, changed source/epoch, wrong original receipt and uncertainty never create replacements",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json(),path=`/api/member-name/claims/${v.claim.requestId}`,originalObserve=f.names.observation!;
    f.names.observation={observe:async input=>({...await originalObserve.observe(input),requestId:h("b")})};
    assert.equal((await f.request(path+"/reconcile","POST",{planDigest:v.claim.planDigest})).status,409);
    f.names.observation=originalObserve;f.context.name!.sourceSha256="b".repeat(64);
    assert.equal((await f.request(path+"/consent","POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"})).status,409);
    f.context.name!.sourceSha256="5".repeat(64);f.advance(300001);
    const unknown=await(await f.request(path)).json();assert.equal(unknown.state,"unknown");assert.equal(unknown.claim.requestId,v.claim.requestId);
    f.observation("expired_unconsumed");const expired=await(await f.request(path+"/reconcile","POST",{planDigest:v.claim.planDigest})).json();assert.equal(expired.state,"expired_unconsumed");
    assert.equal((await f.prepare("name-request-replacement","otheraaa")).status,409);assert.equal(await f.count(),2);assert.equal((await(await f.request("/api/community/join")).json()).state,"accepted");
  }finally{await f.runtime.dispose();}
});
test("original/grant/consent/transaction custody is append-only, exact and requires actual verifier ports",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json(),s=await f.session(),plain=new CommunityMemberJournal(f.db),op=(await plain.byId(f.context,s,v.claim.requestId))!;
    await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"});
    const grant:OriginalGrant={requestId:op.original.requestId,planDigest:op.digest,sourceSha256:op.original.preparation!.sourceSha256,
      grantDigest:h("c"),issuerNonce:"7",nonceKey:h("d"),expiresAtMs:f.now()+10000,envelope:{fixtureOnly:true,signature:"0xcd"}};
    await assert.rejects(()=>plain.recordGrant(op,grant,f.context.fence,f.now()),/issuer_unavailable/);
    // Simulation only: future Root gate must replace with exact V4 envelope,
    // signature/calldata/authority validation, never these fixture verifiers.
    const journal=new CommunityMemberJournal(f.db,{grant:{verify:async()=>{}},transaction:{verify:async()=>{}}});
    await journal.recordGrant(op,grant,f.context.fence,f.now());await journal.recordGrant(op,grant,f.context.fence,f.now());
    await assert.rejects(()=>journal.recordGrant(op,{...grant,issuerNonce:"8"},f.context.fence,f.now()),/request_conflict/);
    const raw="0x1234",tx:OriginalTransaction={chainId:31337,sender:`0x${"e".repeat(40)}`,nonce:"0",raw,transactionHash:keccak256(raw),gasLimit:"21000",maxFeePerGas:"10",maxPriorityFeePerGas:"1"};
    await assert.rejects(()=>plain.persistTransaction(op,tx,f.context.fence,f.now()),/issuer_unavailable/);
    await journal.persistTransaction(op,tx,f.context.fence,f.now());await journal.persistTransaction(op,tx,f.context.fence,f.now());
    await assert.rejects(()=>journal.persistTransaction(op,{...tx,nonce:"1"},f.context.fence,f.now()),/request_conflict/);
    await assert.rejects(()=>journal.recordBroadcast(op,{transactionHash:h("b"),state:"unknown"},f.context.fence,f.now()),/request_conflict/);
    await journal.recordBroadcast(op,{transactionHash:tx.transactionHash,state:"unknown"},f.context.fence,f.now());
    const artifacts=await journal.artifacts(op);assert.equal(JSON.parse(artifacts.transaction).raw,raw);assert.equal(JSON.parse(artifacts.transaction).transactionHash,tx.transactionHash);
    assert.equal(JSON.parse(artifacts.broadcast).state,"unknown");assert.equal(await f.count("community_member_artifacts"),5);
    const read=await(await f.request(`/api/member-name/claims/${v.claim.requestId}`)).json();assert.equal(read.state,"unknown");assert.equal(read.claim.requestId,op.original.requestId);
    for(const sql of ["DELETE FROM community_member_operations","UPDATE community_member_operations SET label='otheraaa'","DELETE FROM community_member_artifacts","UPDATE community_member_artifacts SET payload_json='{}'","DELETE FROM community_member_budgets"]) await assert.rejects(()=>f.db.prepare(sql).run());
  }finally{await f.runtime.dispose();}
});
test("final consent policy/session fence rolls back custody on revocation",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json();
    f.names.policy!.revalidate=async()=>{await f.db.prepare("DELETE FROM community_sessions WHERE account_id='account-a'").run();};
    const r=await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"});assert.equal(r.status,503);
    assert.equal(await f.count("community_member_artifacts"),1);assert.equal(await f.count(),2);
  }finally{await f.runtime.dispose();}
});
test("changed policy epoch at final write refuses consent without deleting Join or original",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json(),verifier=f.names.recipientVerifier!;
    f.names.recipientVerifier={verify:async input=>{const e=await verifier.verify(input);await f.db.prepare("UPDATE member_fixture_authority SET epoch=2").run();return e;}};
    const r=await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"});
    assert.equal(r.status,503);assert.equal(await f.count("community_member_artifacts"),1);assert.equal((await(await f.request("/api/community/join")).json()).state,"accepted");
  }finally{await f.runtime.dispose();}
});
test("effective premium price, nonzero maxCost and exhausted budgets refuse before operation custody",async()=>{
  for(const bad of ["effectivePriceAtomic","maxCostAtomic","gasBudget"] as const) {
    const f=await fixture();try {
      await f.join();const provider=f.names.preparation!;
      f.names.preparation={prepare:async input=>{const p=await provider.prepare(input);
        if(bad==="gasBudget")p.terms.gas.maxTotalWei="2000001";
        else {p.quote.premiumAtomic="1";(p.quote as unknown as Record<string,string>)[bad]="1";}
        return p;}};
      const r=await f.prepare();assert.equal(r.status,409);assert.equal((await r.json()).reason,bad==="gasBudget"?"budget_exhausted":"not_free");
      assert.equal(await f.count(),1);assert.equal(await f.count("community_member_budgets"),0);assert.equal(await f.count("community_member_artifacts"),0);
    }finally{await f.runtime.dispose();}
  }
});
test("two accounts cannot reuse a grant nonce domain, sender nonce or signed transaction hash",async()=>{
  const f=await fixture();try {
    await f.join("a");await f.join("b");
    const a=await(await f.prepare()).json(),b=await(await f.prepare("name-request-b-000001","otheraaa","b")).json();
    const journal=new CommunityMemberJournal(f.db,{grant:{verify:async()=>{}},transaction:{verify:async()=>{}}});
    const oa=(await journal.byId(f.context,await f.session("a"),a.claim.requestId))!,ob=(await journal.byId(f.context,await f.session("b"),b.claim.requestId))!;
    for(const [v,id] of [[a,"a"],[b,"b"]] as const) await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"},id);
    const grant=(op:typeof oa,nonceKey:MemberHex):OriginalGrant=>({requestId:op.original.requestId,planDigest:op.digest,sourceSha256:op.original.preparation!.sourceSha256,
      grantDigest:h("c"),issuerNonce:"7",nonceKey,expiresAtMs:f.now()+10000,envelope:{fixtureOnly:true}});
    await journal.recordGrant(oa,grant(oa,h("c")),f.context.fence,f.now());
    await assert.rejects(()=>journal.recordGrant(ob,grant(ob,h("c")),f.context.fence,f.now()),/service_unavailable/);
    await journal.recordGrant(ob,grant(ob,h("d")),f.context.fence,f.now());
    const raw="0x1234",tx:OriginalTransaction={chainId:31337,sender:`0x${"e".repeat(40)}`,nonce:"0",raw,transactionHash:keccak256(raw),gasLimit:"21000",maxFeePerGas:"10",maxPriorityFeePerGas:"1"};
    await journal.persistTransaction(oa,tx,f.context.fence,f.now());
    await assert.rejects(()=>journal.persistTransaction(ob,{...tx,raw:"0x5678",transactionHash:keccak256("0x5678")},f.context.fence,f.now()),/service_unavailable/);
    await assert.rejects(()=>journal.persistTransaction(ob,{...tx,nonce:"1"},f.context.fence,f.now()),/service_unavailable/);
    assert.equal(Object.hasOwn(await journal.artifacts(ob),"transaction"),false);assert.equal(Object.hasOwn(await journal.artifacts(oa),"transaction"),true);
  }finally{await f.runtime.dispose();}
});
test("equal concurrent reservations cannot borrow another account's successful community CAS",{timeout:20000},async()=>{
  const f=await fixture();try {
    await f.join("a");await f.join("b");const policy=f.names.policy!;
    f.names.policy={...policy,authorize:async input=>{const d=await policy.authorize(input);return {...d,budgets:d.budgets.map(b=>b.role==="community"?{...b,limitWei:"1000000"}:b)};}};
    let readers=0,release!:()=>void;const bothRead=new Promise<void>(resolve=>{release=resolve;});
    // Scheduling wrapper only: every SQL/result is from actual D1. Hold the
    // first two community reads AFTER completion, forcing identical snapshots.
    const wrap=(stmt:ReturnType<D1Database["prepare"]>,values:unknown[]=[]):ReturnType<D1Database["prepare"]>=>new Proxy(stmt,{get(target,key){
      if(key==="bind")return (...bound:unknown[])=>wrap(target.bind(...bound),bound);
      if(key==="first" && values[0]===h("8"))return async(...args:unknown[])=>{
        const value=await (target.first as (...a:unknown[])=>Promise<unknown>)(...args);
        if(++readers===2)release();await bothRead;return value;
      };
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    f.ports.db=new Proxy(f.db,{get(target,key){
      if(key==="prepare")return (sql:string)=>sql.startsWith("SELECT limit_wei,reserved_wei,revision FROM community_member_budgets")?wrap(target.prepare(sql)):target.prepare(sql);
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    const replies=await Promise.all([f.prepare(key,label,"a"),f.prepare("name-request-b-000001","otheraaa","b")]);
    assert.equal(readers,2);assert.deepEqual(replies.map(r=>r.status).sort(),[200,503]);
    const winner=await replies.find(r=>r.status===200)!.json();
    const budget=await f.db.prepare("SELECT reserved_wei,revision,last_operation_id FROM community_member_budgets WHERE bucket=?").bind(h("8")).first<{reserved_wei:string;revision:number;last_operation_id:string}>();
    assert.deepEqual(budget,{reserved_wei:"1000000",revision:1,last_operation_id:winner.claim.requestId});
    assert.equal(await f.count(),3);assert.equal(await f.count("community_member_artifacts"),1);assert.equal(await f.count("community_member_budgets"),2);
  }finally{await f.runtime.dispose();}
});
test("REPLACE cannot bypass original/nonce/hash custody through alternate unique keys with recursive triggers OFF",async()=>{
  const f=await fixture();try {
    await f.db.prepare("PRAGMA recursive_triggers=OFF").run();
    assert.equal((await f.db.prepare("PRAGMA recursive_triggers").first<{recursive_triggers:number}>())?.recursive_triggers,0);
    await f.join("a");await f.join("b");
    const ja=(await f.db.prepare("SELECT * FROM community_member_operations WHERE kind='join' AND account_id='account-a'").first<Record<string,unknown>>())!;
    const jb=(await f.db.prepare("SELECT * FROM community_member_operations WHERE kind='join' AND account_id='account-b'").first<Record<string,unknown>>())!;
    async function replace(table:string,row:Record<string,unknown>,overrides:Record<string,unknown>,error:RegExp) {
      const proposed={...row,...overrides},columns=Object.keys(proposed);
      await assert.rejects(()=>f.db.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).bind(...columns.map(k=>proposed[k])).run(),error);
    }
    await replace("community_member_operations",ja,{operation_id:h("c")},/member_original_immutable/); // idempotency
    await replace("community_member_operations",ja,{idempotency_key:"join-alternate-000001"},/member_original_immutable/); // primary key
    await replace("community_member_operations",ja,{operation_id:h("c"),idempotency_key:"join-alternate-000001"},/member_original_immutable/); // owner index
    const a=await(await f.prepare()).json(),na=(await f.db.prepare("SELECT * FROM community_member_operations WHERE operation_id=?").bind(a.claim.requestId).first<Record<string,unknown>>())!;
    await replace("community_member_operations",na,{operation_id:h("c"),idempotency_key:"name-alternate-000001"},/member_original_immutable/); // name owner
    await replace("community_member_operations",na,{operation_id:h("c"),idempotency_key:"name-alternate-000001",account_id:jb.account_id,binding_id:jb.binding_id,recipient:jb.recipient,join_id:jb.operation_id},/member_original_immutable/); // namespace/label, other owner
    const b=await(await f.prepare("name-request-b-000001","otheraaa","b")).json();
    for(const [v,id] of [[a,"a"],[b,"b"]] as const) await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"},id);
    const journal=new CommunityMemberJournal(f.db,{grant:{verify:async()=>{}},transaction:{verify:async()=>{}}}),oa=(await journal.byId(f.context,await f.session("a"),a.claim.requestId))!;
    await journal.recordGrant(oa,{requestId:oa.original.requestId,planDigest:oa.digest,sourceSha256:oa.original.preparation!.sourceSha256,grantDigest:h("c"),issuerNonce:"7",nonceKey:h("d"),expiresAtMs:f.now()+10000,envelope:{fixtureOnly:true}},f.context.fence,f.now());
    const raw="0x1234",transactionHash=keccak256(raw);
    await journal.persistTransaction(oa,{chainId:31337,sender:`0x${"e".repeat(40)}`,nonce:"0",raw,transactionHash,gasLimit:"21000",maxFeePerGas:"10",maxPriorityFeePerGas:"1"},f.context.fence,f.now());
    const grant=(await f.db.prepare("SELECT * FROM community_member_artifacts WHERE operation_id=? AND kind='grant'").bind(a.claim.requestId).first<Record<string,unknown>>())!;
    const tx=(await f.db.prepare("SELECT * FROM community_member_artifacts WHERE operation_id=? AND kind='transaction'").bind(a.claim.requestId).first<Record<string,unknown>>())!;
    await replace("community_member_artifacts",grant,{operation_id:b.claim.requestId},/member_artifact_immutable/); // nonce_key
    await replace("community_member_artifacts",tx,{operation_id:b.claim.requestId,transaction_hash:h("c")},/member_artifact_immutable/); // sender nonce
    await replace("community_member_artifacts",tx,{operation_id:b.claim.requestId,nonce:"1"},/member_artifact_immutable/); // hash
    await replace("community_member_artifacts",tx,{payload_json:"{}"},/member_artifact_immutable/); // primary key
    const budget=(await f.db.prepare("SELECT * FROM community_member_budgets LIMIT 1").first<Record<string,unknown>>())!;
    await replace("community_member_budgets",budget,{reserved_wei:"0",revision:0,last_operation_id:null},/member_budget_retained/);
    await f.request(`/api/member-name/claims/${a.claim.requestId}/reconcile`,"POST",{planDigest:a.claim.planDigest});
    const observation=(await f.db.prepare("SELECT * FROM community_member_observations LIMIT 1").first<Record<string,unknown>>())!;
    await replace("community_member_observations",observation,{observation_json:"{}"},/member_observation_immutable/);
    assert.equal(JSON.parse((await journal.artifacts(oa)).transaction).transactionHash,transactionHash);assert.equal(await f.count(),4);
    const ob=(await journal.byId(f.context,await f.session("b"),b.claim.requestId))!;assert.equal(Object.hasOwn(await journal.artifacts(ob),"grant"),false);
  }finally{await f.runtime.dispose();}
});
test("deferred grant verification persists only its original operation, envelope and fence snapshots",{timeout:20000},async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json();
    await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"});
    const plain=new CommunityMemberJournal(f.db),session=await f.session(),op=(await plain.byId(f.context,session,v.claim.requestId))!;
    const grant:OriginalGrant={requestId:op.original.requestId,planDigest:op.digest,sourceSha256:op.original.preparation!.sourceSha256,grantDigest:h("c"),issuerNonce:"7",nonceKey:h("d"),expiresAtMs:f.now()+10000,envelope:{fixtureOnly:true,signature:"0xcd"}};
    const original=structuredClone({op,grant}),guard=structuredClone(f.context.fence);
    let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{signal=r;}),finish=new Promise<void>(r=>{release=r;});
    const journal=new CommunityMemberJournal(f.db,{grant:{verify:async(operation,payload)=>{
      assert.deepEqual(operation,original.op);assert.deepEqual(payload,original.grant);signal();await finish;
      assert.deepEqual(operation,original.op);assert.deepEqual(payload,original.grant);
    }}});
    const pending=journal.recordGrant(op,grant,guard,f.now());await entered;
    grant.envelope.signature="0xdead";grant.issuerNonce="8";op.digest=h("f");op.original.context.linuxInstallationId="linux:wrong";
    guard.sql="0";guard.values=[];release();await pending;
    const recovered=(await plain.byId(f.context,session,v.claim.requestId))!;
    assert.deepEqual(JSON.parse((await plain.artifacts(recovered)).grant),original.grant);
    assert.equal(recovered.digest,original.op.digest);assert.equal(recovered.original.context.linuxInstallationId,f.context.linuxInstallationId);
  }finally{await f.runtime.dispose();}
});
test("deferred transaction verification cannot be switched to another valid raw hash or mutable original",{timeout:20000},async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json();
    await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"});
    const plain=new CommunityMemberJournal(f.db),session=await f.session(),op=(await plain.byId(f.context,session,v.claim.requestId))!;
    const grant:OriginalGrant={requestId:op.original.requestId,planDigest:op.digest,sourceSha256:op.original.preparation!.sourceSha256,grantDigest:h("c"),issuerNonce:"7",nonceKey:h("d"),expiresAtMs:f.now()+10000,envelope:{fixtureOnly:true}};
    let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{signal=r;}),finish=new Promise<void>(r=>{release=r;});
    const raw="0x1234",tx:OriginalTransaction={chainId:31337,sender:`0x${"e".repeat(40)}`,nonce:"0",raw,transactionHash:keccak256(raw),gasLimit:"21000",maxFeePerGas:"10",maxPriorityFeePerGas:"1"};
    const original=structuredClone({op,tx}),guard=structuredClone(f.context.fence);
    const journal=new CommunityMemberJournal(f.db,{grant:{verify:async()=>{}},transaction:{verify:async(operation,payload)=>{
      assert.deepEqual(operation,original.op);assert.deepEqual(payload,original.tx);signal();await finish;
      assert.deepEqual(operation,original.op);assert.deepEqual(payload,original.tx);
    }}});
    await journal.recordGrant(op,grant,guard,f.now());
    const pending=journal.persistTransaction(op,tx,guard,f.now());await entered;
    tx.raw="0x5678";tx.transactionHash=keccak256(tx.raw);tx.nonce="1";op.original.preparation!.label="wrongaaa";
    guard.sql="0";guard.values=[];release();await pending;
    const recovered=(await plain.byId(f.context,session,v.claim.requestId))!,saved=JSON.parse((await plain.artifacts(recovered)).transaction);
    assert.equal(saved.raw,original.tx.raw);assert.equal(saved.transactionHash,original.tx.transactionHash);assert.equal(saved.nonce,"0");
    assert.equal(recovered.original.preparation!.label,label);
  }finally{await f.runtime.dispose();}
});
test("a verifier that rewrites its delegated copy cannot turn that copy into a persisted verified grant",async()=>{
  const f=await fixture();try {
    await f.join();const v=await(await f.prepare()).json();
    await f.request(`/api/member-name/claims/${v.claim.requestId}/consent`,"POST",{planDigest:v.claim.planDigest,recipientSignature:"0xab"});
    const plain=new CommunityMemberJournal(f.db),op=(await plain.byId(f.context,await f.session(),v.claim.requestId))!;
    const journal=new CommunityMemberJournal(f.db,{grant:{verify:async(_operation,payload)=>{await Promise.resolve();payload.envelope.signature="0xdead";}}});
    await assert.rejects(()=>journal.recordGrant(op,{requestId:op.original.requestId,planDigest:op.digest,sourceSha256:op.original.preparation!.sourceSha256,grantDigest:h("c"),issuerNonce:"7",nonceKey:h("d"),expiresAtMs:f.now()+10000,envelope:{fixtureOnly:true,signature:"0xcd"}},f.context.fence,f.now()),/authority_changed/);
    assert.equal(Object.hasOwn(await plain.artifacts(op),"grant"),false);
  }finally{await f.runtime.dispose();}
});
