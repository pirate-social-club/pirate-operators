import {DurableObject} from "cloudflare:workers";
import {actualBusinessPath} from "./readback-path.ts";
import {actualHandlerIdentity} from "./actual-handler-identity.ts";
interface Spec {id:string;path:string;expectedStatus:number;resourcePointer:string;expectedResourceId:string;
 businessPointer:string;expectedBusinessOutcome:unknown;requestId:string;generation:number;installationId:string;profileDigest:string;
 owningSourceSHA256:string;expectedSourceSHA256:string;outcome:string;
 actualIdentityPointers:Record<"installationId"|"requestId"|"generation"|"profileDigest"|"outcome",string>}
interface Env {APPLICATION:Fetcher;AUDIT:DurableObjectNamespace<HandlerReadbackAudit>;PROBE_PLAN_JSON:string}
const pointer=(body:any,path:string)=>{if(!path.startsWith("/"))throw Error("selector_required");for(const part of path.slice(1).split("/")){
 if(body===null || typeof body!=="object" || !Object.hasOwn(body,part))throw Error("business_record_missing");body=body[part];}return body;};
export class HandlerReadbackAudit extends DurableObject<Env> {
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS observations(request_id TEXT PRIMARY KEY,body TEXT NOT NULL)");}
  async retain(requestId:string,record:unknown):Promise<unknown>{
    const body=JSON.stringify(record),old=this.ctx.storage.sql.exec<{body:string}>("SELECT body FROM observations WHERE request_id=?",requestId).toArray()[0];
    if(old && old.body!==body)throw Error("original_business_readback_changed");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO observations VALUES(?,?)",requestId,body);await this.ctx.storage.sync();
    return JSON.parse(this.ctx.storage.sql.exec<{body:string}>("SELECT body FROM observations WHERE request_id=?",requestId).toArray()[0]!.body);
  }
}
export default {
 async fetch(request:Request,env:Env){
  const id=new URL(request.url).pathname.split("/").at(-1),specs=JSON.parse(env.PROBE_PLAN_JSON) as Spec[];
  const s=specs.find(x=>x.id===id);if(request.method!=="GET" || !s)return new Response(null,{status:404});
  const path=actualBusinessPath(s.path,new URL(request.url).origin);
  if(s.owningSourceSHA256!==s.expectedSourceSHA256 || !Number.isSafeInteger(s.generation) || s.generation<1)
    throw Error("actual_selected_business_probe_required");
  // The real application service and cookie issuer are used. No fake dependencies.
  // The native caller must supply a managed MAC for THIS business path.
  // The observer cannot manufacture identity from its plan or request-ID echo.
  if(!request.headers.has("X-Pirate-Native-Request")||!request.headers.has("X-Pirate-Native-Mac"))
    throw Error("actual_native_business_authentication_required");
  const headers=new Headers(request.headers);headers.delete("X-Pirate-Request-ID");
  const url=new URL(path,request.url),actual=await env.APPLICATION.fetch(new Request(url,{headers}));
  if(actual.status!==s.expectedStatus)throw Error("actual_selected_handler_refused");
  const body=await actual.json();const resource=pointer(body,s.resourcePointer),outcome=pointer(body,s.businessPointer);
  if(resource!==s.expectedResourceId || JSON.stringify(outcome)!==JSON.stringify(s.expectedBusinessOutcome))
    throw Error("actual_business_resource_or_outcome_mismatch");
  // Every identity/outcome comes from the actual selected handler body.
  // Configuration fields are comparison targets, never invented observations.
  const expected={installationId:s.installationId,requestId:s.requestId,generation:s.generation,profileDigest:s.profileDigest,outcome:s.outcome};
  const identity=actualHandlerIdentity(body,expected,s.actualIdentityPointers);
  const observed={...identity,resourceId:resource,businessOutcome:outcome,actualHandlerPath:s.path};
  const persisted=await env.AUDIT.get(env.AUDIT.idFromName(s.installationId)).retain(s.requestId,observed);
  return Response.json(persisted);
 }
};

