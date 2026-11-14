import {DurableObject} from "cloudflare:workers";
interface ColdPlan {installationId:string;requestId:string;generation:number;profileDigest:string;resourceId:string;
 communityId:string;origin:string;queries:Array<{id:string;sql:string;sha256:string;owningSourceSHA256:string}>;owningSourceSHA256:string}
interface Env {DB:D1Database;AUDIT:DurableObjectNamespace<RestoreAudit>;COLD_PLAN_JSON:string}
export class RestoreAudit extends DurableObject<Env> {
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS observations(request_id TEXT PRIMARY KEY, body TEXT NOT NULL)");}
  async retain(id:string,body:unknown):Promise<unknown>{
    const bytes=JSON.stringify(body),old=this.ctx.storage.sql.exec<{body:string}>("SELECT body FROM observations WHERE request_id=?",id).toArray()[0];
    if(old && old.body!==bytes)throw new Error("original_restore_audit_conflict");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO observations VALUES(?,?)",id,bytes);await this.ctx.storage.sync();
    return JSON.parse(this.ctx.storage.sql.exec<{body:string}>("SELECT body FROM observations WHERE request_id=?",id).toArray()[0]!.body);
  }
}
export default {
  async fetch(request:Request,env:Env){
    if(request.method!=="POST" || new URL(request.url).pathname!=="/reconcile")return new Response(null,{status:404});
    const p=JSON.parse(env.COLD_PLAN_JSON) as ColdPlan;
    if(!p.installationId || !p.requestId || !Number.isSafeInteger(p.generation) || p.generation<1 || !p.queries.length)
      throw new Error("complete_owning_cold_plan_required");
    // Existing table/column names are pinned to community/accounts.ts.
    // No speculative migrations or ordinal fallback are introduced.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM community_sessions WHERE community_id=? AND community_origin=?").bind(p.communityId,p.origin),
      env.DB.prepare("DELETE FROM login_challenges WHERE community_id=? AND community_origin=?").bind(p.communityId,p.origin)
    ]);
    const session=await env.DB.prepare("SELECT COUNT(*) AS n FROM community_sessions WHERE community_id=? AND community_origin=?").bind(p.communityId,p.origin).first<{n:number}>();
    const challenge=await env.DB.prepare("SELECT COUNT(*) AS n FROM login_challenges WHERE community_id=? AND community_origin=?").bind(p.communityId,p.origin).first<{n:number}>();
    if(session?.n!==0 || challenge?.n!==0)throw new Error("restored_session_or_challenge_still_live");
    const pending=[];
    for(const q of p.queries){
      if(!/^SELECT\s/i.test(q.sql) || q.sql.includes(";") || q.owningSourceSHA256!==p.owningSourceSHA256)throw new Error("unadmitted_domain_query");
      const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(q.sql)))].map(x=>x.toString(16).padStart(2,"0")).join("");
      if(digest!==q.sha256)throw new Error("owning_domain_query_changed");
      const rows=await env.DB.prepare(q.sql).bind(p.communityId,p.origin).all();
      pending.push({id:q.id,rows:rows.results.length});
      if(rows.results.length!==0)throw new Error("original_external_effect_or_nonce_requires_reconciliation");
    }
    const outcome={installationId:p.installationId,resourceId:p.resourceId,requestId:p.requestId,generation:p.generation,
      profileDigest:p.profileDigest,outcome:"offline-reconciled",sessionCount:session.n,challengeCount:challenge.n,pending};
    const stored=await env.AUDIT.get(env.AUDIT.idFromName(p.installationId)).retain(p.requestId,outcome);
    return Response.json(stored);
  }
};

