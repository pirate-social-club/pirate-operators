import type { D1Database } from "@cloudflare/workers-types";
import { getAddress } from "viem";
import { accountSession, authenticatedWrite, type AccountSession } from "../packages/community/accounts.ts";
import { CommunityError, hashJson, jsonBody, publicId } from "../packages/community/common.ts";
import {
  MemberError, memberRequire, memberDigest, parseJoin, parsePrepare, parseConsent, parseReconcile, decimal, epoch,
  type CommunityJoinView, type MemberNameView, type NameClaimRef, type NameRefusal,
} from "../packages/community-names/member-api.ts";
import {
  assertMemberContext, memberContext, ownerScope, sessionFence, requireNameBinding, validateAdmission, validatePreparation,
  type MemberContext, type CommunityJoinPolicy, type MemberNamePorts, type NameObservation, type AtomicMemberFence,
} from "../packages/community-names/member-authorization.ts";
import { CommunityMemberJournal, type MemberOperation } from "../packages/community-names/member-journal.ts";

export interface CommunityMemberPorts {
  db: D1Database;
  /** Actual Root-owned installation/profile/source decoder. Not request input.
   * Preserve mapped Linux reference, Directory bytes32 installation and raw
   * native profileDigest separately. No implicit hashing or prefix conversion. */
  context(): Promise<MemberContext>;
  joinPolicy?: CommunityJoinPolicy;
  names?: MemberNamePorts;
  now?: () => number;
}
const corrections: Record<NameRefusal,string> = {
  invalid_label:"Use an unchanged lowercase ASCII label of 8–63 characters.",
  name_taken:"Choose another available name only after the original operation is resolved.",
  name_reserved:"This name is reserved.", not_free:"This operation requires an exact zero effective initial price.",
  budget_exhausted:"The community or account sponsorship budget is unavailable.",
  authority_changed:"The original source or authorization changed; retain this original operation for review.",
  issuer_unavailable:"Name issuance is unavailable. Saved consent and original custody are retained.",
  recipient_unsupported:"This wallet cannot provide the required claim acceptance signature.",
  request_conflict:"Recover the exact original operation; do not allocate a replacement.",
  service_unavailable:"The required original-source verifier is unavailable. Retain this operation and retry its readback.",
};
const refusal = (code: string): NameRefusal => Object.hasOwn(corrections,code) ? code as NameRefusal :
  ["invalid_fields","invalid_object","invalid_json","json_required","body_required","body_too_large"].includes(code)?"request_conflict":"service_unavailable";

function joinView(c: MemberContext, s: AccountSession, op: MemberOperation|null): CommunityJoinView {
  const base={schema:"pirate.community-join/1" as const,ownerScope:ownerScope(c,s),revision:op?.revision??0};
  return op ? {...base,state:"accepted",receipt:{joinId:op.original.requestId,acceptedAtMs:op.original.createdAtMs}} : {...base,state:"not_joined"};
}
function nameBase(c: MemberContext,s: AccountSession,op: MemberOperation|null) {
  return {schema:"pirate.member-name/1" as const,ownerScope:ownerScope(c,s),revision:op?.revision??0,
    recipient:getAddress(s.wallet),tld:op?.original.context.name?.tld??c.name?.tld??""};
}
function claim(op: MemberOperation): NameClaimRef {
  memberRequire(op.original.kind==="name" && op.original.preparation && op.original.context.name,"service_unavailable",503);
  return {requestId:op.original.requestId,planDigest:op.digest,label:op.original.label!,name:`${op.original.label}.${op.original.context.name.tld}`};
}
function finalFence(c: MemberContext,s: AccountSession,now: number,policy?: AtomicMemberFence): AtomicMemberFence {
  const auth=sessionFence(c,s,now), parts=policy?[auth,c.fence,policy]:[auth,c.fence];
  return {sql:parts.map(p=>`(${p.sql})`).join(" AND "),values:parts.flatMap(p=>p.values)};
}
async function unchanged(ports: CommunityMemberPorts, original: MemberContext) {
  const current=memberContext(await ports.context()); await assertMemberContext(ports.db,current);
  memberRequire(hashJson(current)===hashJson(original),"authority_changed"); return current;
}
/** This validates identity/freshness of evidence from a REQUIRED genuine
 * verifier. It is not a substitute for canonical receipt/signature/RPC proof. */
export function validateMemberObservation(op: MemberOperation,o: NameObservation,now: number) {
  const p=op.original.preparation; memberRequire(p,"service_unavailable",503);
  memberRequire(o.requestId===op.original.requestId && o.planDigest===op.digest && o.sourceSha256===p.sourceSha256 &&
    epoch(o.observedAtMs)<=now && epoch(o.validUntilMs)>now,"authority_changed"); memberDigest(o.evidenceDigest);
  memberRequire(["pending","unknown","expired_unconsumed","consumed"].includes(o.state),"service_unavailable",503);
  if (o.state==="consumed") {
    const r=o.receipt; memberRequire(r && r.tokenId===p.expectedTokenId && r.generation===p.generation,"authority_changed");
    memberDigest(r.transactionHash); memberDigest(r.blockHash); decimal(r.blockNumber); decimal(r.tokenId); decimal(r.generation); epoch(r.expiryMs);
    if(o.current?.state==="usable") memberRequire(getAddress(o.current.recipient)===getAddress(p.recipient) &&
      o.current.tokenId===r.tokenId && o.current.generation===r.generation && epoch(o.current.expiresAtMs)>now,"authority_changed");
    if(o.current) memberRequire(["usable","not_usable","unknown"].includes(o.current.state),"service_unavailable",503);
  } else memberRequire(!o.receipt && !o.current,"service_unavailable",503);
}
async function projectName(c: MemberContext,s: AccountSession,journal: CommunityMemberJournal,
  op: MemberOperation|null,now: number,observation?: NameObservation): Promise<MemberNameView> {
  const base=nameBase(c,s,op); if(!op) return {...base,state:"idle",claim:null};
  const ref=claim(op),p=op.original.preparation!,artifacts=await journal.artifacts(op);
  // A saved flag/artifact never proves canonical consumption. Every consumed
  // response requires a fresh original-source verifier result.
  if(observation) {
    validateMemberObservation(op,observation,now);
    if(observation.state==="consumed") return {...base,state:"consumed",claim:ref,terms:p.terms,receipt:observation.receipt!,
      usability:observation.current?.state??"not_checked"};
    if(observation.state==="expired_unconsumed") return {...base,state:"expired_unconsumed",claim:ref,reason:"request_conflict",correction:corrections.request_conflict};
    if(observation.state==="pending" || artifacts.transaction || artifacts.grant) return {...base,state:observation.state,claim:ref,terms:p.terms,retryAfterMs:3000};
  }
  if(artifacts.transaction || artifacts.grant) return {...base,state:"unknown",claim:ref,terms:p.terms,retryAfterMs:3000};
  if(artifacts.consent) return {...base,state:"blocked",claim:ref,reason:"issuer_unavailable",correction:corrections.issuer_unavailable};
  // Expiry alone cannot prove nonconsumption; require a canonical observation
  // before using expired_unconsumed or releasing any reservation.
  if(p.consent.expiresAtMs<=now) return {...base,state:"unknown",claim:ref,terms:p.terms,retryAfterMs:3000};
  return {...base,state:"awaiting_consent",claim:ref,terms:p.terms,consent:p.consent};
}
async function observe(ports: CommunityMemberPorts,c: MemberContext,journal: CommunityMemberJournal,op: MemberOperation,now: number) {
  memberRequire(ports.names?.observation,"service_unavailable",503);
  const result=await ports.names.observation.observe({context:c,preparation:op.original.preparation!,planDigest:op.digest,artifacts:await journal.artifacts(op),now});
  validateMemberObservation(op,result,now); return result;
}

/** Source-only opt-in mount. Root must close schema/native guards and inject
 * genuine policy/V4 ports. Phase1 has NO signer, nonce allocator or sender. */
export async function communityNamesApi(request: Request,ports: CommunityMemberPorts): Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname;
  if(path!=="/api/community/join" && path!=="/api/member-name" && !path.startsWith("/api/member-name/")) return null;
  const headers=new Headers({"cache-control":"no-store","vary":"Cookie","x-content-type-options":"nosniff"});
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers});
  let c:MemberContext|undefined,s:AccountSession|undefined,op:MemberOperation|null=null;
  const isJoin=path==="/api/community/join",now=()=>epoch((ports.now??Date.now)());
  try {
    c=memberContext(await ports.context());
    memberRequire(url.origin===c.origin && !url.search,"wrong_host",403);
    const site=request.headers.get("sec-fetch-site"),origin=request.headers.get("origin");
    memberRequire(site===null || site==="same-origin" || site==="none","cross_site_member",403);
    memberRequire(origin===null || origin===c.origin,"wrong_origin",403);
    const original=/^\/api\/member-name\/claims\/(0x[0-9a-f]{64})(?:\/(consent|reconcile))?$/.exec(path);
    const prepare=path==="/api/member-name/claims",current=path==="/api/member-name";
    memberRequire(isJoin || prepare || current || original,"member_route_not_found",404);
    memberRequire(request.method==="GET" || request.method==="POST","method_not_allowed",405);
    memberRequire(!(current && request.method!=="GET") && !(prepare && request.method!=="POST") &&
      !(original && ((original[2] && request.method!=="POST") || (!original[2] && request.method!=="GET"))),"method_not_allowed",405);
    // Reuse the actual application session, Origin and CSRF implementation.
    s=request.method==="POST" ? await authenticatedWrite(request,ports.db,c) : await accountSession(request,ports.db,c,now());
    await assertMemberContext(ports.db,c);
    const journal=new CommunityMemberJournal(ports.db);
    if(isJoin) {
      op=await journal.current(c,s,"join");
      if(request.method==="GET") return reply(joinView(c,s,op));
      const input=parseJoin(await jsonBody(request,2048));
      if(op) return reply(joinView(c,s,op));
      memberRequire(ports.joinPolicy,"policy_unavailable",503);
      const decision=await ports.joinPolicy.authorize(c,s,now()); memberRequire(decision,"admission_refused",403);
      validateAdmission(decision,now()); await ports.joinPolicy.revalidate(c,s,decision,now());
      await unchanged(ports,c); validateAdmission(decision,now());
      op=await journal.acceptJoin(c,s,input.idempotencyKey,decision,now());
      return reply(joinView(c,s,op));
    }
    if(current || original) {
      op=original ? await journal.byId(c,s,memberDigest(original[1])) : await journal.current(c,s,"name");
      if(original) memberRequire(op?.original.kind==="name","member_route_not_found",404);
    }
    if(request.method==="GET") {
      // Observational: no original allocation, journal reconciliation or nonce.
      if(!op) { requireNameBinding(c); return reply(await projectName(c,s,journal,null,now())); }
      const observation=await observe(ports,c,journal,op,now());
      return reply(await projectName(c,s,journal,op,now(),observation));
    }
    if(prepare) {
      const input=parsePrepare(await jsonBody(request,4096));
      op=await journal.byKey(c,s,"name",input.idempotencyKey);
      if(op) { memberRequire(op.original.label===input.label,"request_conflict");
        return reply(await projectName(c,s,journal,op,now(),await observe(ports,c,journal,op,now()))); }
      op=await journal.current(c,s,"name"); memberRequire(!op,"request_conflict");
      const join=await journal.current(c,s,"join"); memberRequire(join,"admission_refused",403);
      requireNameBinding(c);
      memberRequire(ports.names?.policy,"service_unavailable",503);
      memberRequire(ports.names.preparation,"issuer_unavailable",503);
      memberRequire(ports.names.recipientVerifier && ports.names.observation,"service_unavailable",503);
      const requestId=publicId(),decision=await ports.names.policy.authorize({context:c,session:s,joinId:join.original.requestId,requestId,label:input.label,now:now()});
      validateAdmission(decision,now());
      const preparation=await ports.names.preparation.prepare({context:c,session:s,admission:decision,requestId,label:input.label});
      validatePreparation(preparation,c,s,requestId,input.label,now());
      await ports.names.policy.revalidate({context:c,session:s,original:decision,now:now()}); await unchanged(ports,c); validateAdmission(decision,now());
      try { op=await journal.prepareName(c,s,input,join,decision,preparation,now()); }
      catch(error) { // A concurrent winner/lost ACK resolves to its exact original.
        op=await journal.byKey(c,s,"name",input.idempotencyKey);
        if(!op) { op=await journal.current(c,s,"name"); throw error; }
        if(op.original.label!==input.label) throw error;
      }
      return reply(await projectName(c,s,journal,op,now()));
    }
    memberRequire(op,"member_route_not_found",404);
    if(original![2]==="consent") {
      const input=parseConsent(await jsonBody(request,40_000)); memberRequire(input.planDigest===op.digest,"request_conflict");
      const artifacts=await journal.artifacts(op);
      if(artifacts.consent) {
        const saved=JSON.parse(artifacts.consent);
        memberRequire(saved.planDigest===input.planDigest && saved.recipientSignature===input.recipientSignature,"request_conflict");
        const view=await projectName(c,s,journal,op,now(),await observe(ports,c,journal,op,now()));
        return reply(view,view.state==="blocked"?503:200);
      }
      memberRequire(ports.names?.recipientVerifier,"service_unavailable",503);
      memberRequire(ports.names.policy,"service_unavailable",503);
      memberRequire(op.original.context.name && hashJson(op.original.context.name)===hashJson(c.name),"authority_changed");
      memberRequire(op.original.preparation!.consent.expiresAtMs>now(),"request_conflict");
      memberRequire(op.original.preparation!.quote.validUntilMs>now(),"authority_changed");
      const evidence=await ports.names.recipientVerifier.verify({preparation:op.original.preparation!,planDigest:op.digest,signature:input.recipientSignature,now:now()});
      memberRequire(evidence,"recipient_unsupported",422);
      memberRequire(evidence.requestId===op.original.requestId && evidence.planDigest===op.digest &&
        evidence.recipient===getAddress(s.wallet) && evidence.consentDigest===op.original.preparation!.consent.digest && epoch(evidence.validUntilMs)>now(),"authority_changed"); memberDigest(evidence.evidenceDigest);
      const admission=op.original.admission;
      await ports.names.policy.revalidate({context:c,session:s,original:admission as import("../packages/community-names/member-authorization.ts").NameAdmission,now:now()});
      await unchanged(ports,c); validateAdmission(admission,now());
      memberRequire(evidence.validUntilMs>now() && op.original.preparation!.consent.expiresAtMs>now() &&
        op.original.preparation!.quote.validUntilMs>now(),"authority_changed");
      try { await journal.recordConsent(op,{planDigest:input.planDigest,recipientSignature:input.recipientSignature,evidence},finalFence(c,s,now(),admission.fence),now()); }
      catch(error) {
        const saved=(await journal.artifacts(op)).consent;
        if(!saved || JSON.parse(saved).planDigest!==input.planDigest || JSON.parse(saved).recipientSignature!==input.recipientSignature) throw error;
      }
      op=(await journal.byId(c,s,op.original.requestId))!;
      // A durable recipient consent is not a queued, signed or consumed claim.
      return reply(await projectName(c,s,journal,op,now()),503);
    }
    const input=parseReconcile(await jsonBody(request,2048)); memberRequire(input.planDigest===op.digest,"request_conflict");
    const observation=await observe(ports,c,journal,op,now()); await unchanged(ports,c);
    validateMemberObservation(op,observation,now());
    await journal.recordObservation(op,observation,finalFence(c,s,now()),now());
    op=(await journal.byId(c,s,op.original.requestId))!;
    return reply(await projectName(c,s,journal,op,now(),observation));
  } catch(error) {
    const known=error instanceof MemberError || error instanceof CommunityError;
    const code=known?error.code:"service_unavailable",status=known?error.status:503;
    if(code==="native_member_schema_not_admitted")return reply({error:code},503);
    // Authenticate before returning owner DTOs; unknown/foreign IDs remain 404.
    if(c && s && !isJoin && status!==401 && status!==403 && status!==404 && status!==405) {
      const reason=refusal(code);
      return reply({...nameBase(c,s,op),state:"blocked",claim:op?claim(op):null,reason,correction:corrections[reason]} satisfies MemberNameView,status);
    }
    if(c && s && isJoin && (code==="admission_refused" || code==="policy_unavailable" || code==="service_unavailable"))
      return reply({schema:"pirate.community-join/1",ownerScope:ownerScope(c,s),revision:0,state:"blocked",reason:code,
        correction:code==="admission_refused"?"The configured community policy did not admit this account.":"The configured Join policy or durable acceptance store is unavailable."} satisfies CommunityJoinView,status);
    return reply({error:code},status);
  }
}
