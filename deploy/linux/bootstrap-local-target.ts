import assert from "node:assert/strict";
import {createServer,request as httpRequest,type IncomingMessage,type Server,type ServerResponse} from "node:http";
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {createLinuxWizardRuntime} from "../../apps/community-wizard/server/linux-runtime.ts";
import {createLocalTargetImplementation,type LocalTargetInputs,type LocalTargetCreateInputs,type LocalTargetFullInputs} from "./local-target-services.ts";
import {startManagedKeyAgent} from "./managed-key-channel.ts";
import {releaseClearedOperation,type readWholeClearance} from "./independent-clearance.ts";
import {createJSON,hash} from "./backend-state.ts";
import {CommunityError} from "../../packages/community/common.ts";
/** Ordinary browser -> authenticated loopback proxy -> existing W6 journal
 * runtime. No new wizard HTTP API, bypass of its CSRF/journal or public bind. */
export interface LocalTargetBootstrapInputs {
  backend:LocalTargetInputs;wizardDirectory:string;wizardDist:string;frontPort:number;innerPort:number;
  pairingSecret:Uint8Array;pairingNonceDirectory:string;
  bootstrapClearance:Parameters<typeof readWholeClearance>[0];
  keyAgent:Omit<Parameters<typeof startManagedKeyAgent>[0],"installationId"|"authenticationKey"|"lease"|"capturedRoots">;
}
export type LocalTargetCreateBootstrapInputs = Omit<LocalTargetBootstrapInputs,"backend"> & {backend:LocalTargetCreateInputs};
export type LocalTargetFullBootstrapInputs = Omit<LocalTargetBootstrapInputs,"backend"> & {backend:LocalTargetFullInputs};
export type LocalTargetBootstrapResult = Awaited<ReturnType<typeof bootstrapLocalTarget>>;
export interface PairedOperatorRuntime {
  server:Server;listen(port:number):Promise<void>;close():Promise<void>;
}
const PAIR_CODE_LIFETIME_MS = 5 * 60_000;
export const DEFAULT_OPERATOR_SESSION_MS = 30 * 60_000;
const sessionExpiredMessage = "This operator session expired. Open a newly authorized setup session for the saved original.";

export interface PairedOperatorInputs {
  installationId:string;frontPort:number;innerPort:number;pairingSecret:Uint8Array;pairingNonceDirectory:string;
  setup?:"linux"|"linux-web2";
  readOnly?:true;
  /** Absolute Unix milliseconds from the selected host authority. */
  sessionExpiresAt?:number;
  assertHeld():Promise<void>;
  createRuntime(authorization:{authorize(request:IncomingMessage,action:"read"|"write"):Promise<void>}):Promise<PairedOperatorRuntime>;
}
/** Startup can fail after the genuine runtime is listening. Its original
 * cleanup capability must survive a failed close; the caller retains custody. */
export class PairedOperatorStartupFailure extends AggregateError {
  readonly close:()=>Promise<void>;
  constructor(errors:unknown[],close:()=>Promise<void>){
    super(errors,"paired_runtime_cleanup_failed");this.close=close;
  }
}
/** Shared transport only. Both explicit profile owners supply their genuine
 * runtime; the browser cannot replace the target, profile or authentication. */
export async function startPairedOperator(value:PairedOperatorInputs){
  const input={...value,pairingSecret:Buffer.from(value.pairingSecret)};
  assert(input.sessionExpiresAt === undefined ||
    (Number.isSafeInteger(input.sessionExpiresAt) && Date.now() < input.sessionExpiresAt),
    "operator_session_deadline_invalid");
  assert(input.frontPort!==input.innerPort && input.pairingSecret.length===32);
  assert(input.setup===undefined || input.setup==="linux" || input.setup==="linux-web2");
  let activeRuntime:PairedOperatorRuntime|undefined;
  let activeProxy:ReturnType<typeof createServer>|undefined;
  let activeTimer:ReturnType<typeof setTimeout>|undefined;
  const transient:Buffer[]=[input.pairingSecret];
  try {
  await input.assertHeld();
  const internal=randomBytes(32),pairing=Buffer.from(input.pairingSecret),session=randomBytes(32),origin="http://127.0.0.1:"+input.frontPort;
  const sessionHash=createHash("sha256").update(session).digest();let paired=false,attempts=0,closed=false;
  transient.push(internal,pairing,session,sessionHash);
  const pairExpiresAt = Date.now() + PAIR_CODE_LIFETIME_MS;
  let sessionExpiresAt = input.sessionExpiresAt ?? (Date.now() + DEFAULT_OPERATOR_SESSION_MS);
  let sessionEnded = false, pairEnded = false;
  function ended() {
    if (!sessionEnded && Date.now() >= sessionExpiresAt) {
      sessionEnded = true;
      session.fill(0);
      sessionHash.fill(0);
      pairing.fill(0);
      internal.fill(0);
    }
    return sessionEnded;
  }
  function expired(res: ServerResponse, code: string, error: string) {
    res.writeHead(410, {"Content-Type": "application/json", "Cache-Control": "no-store"});
    res.end(JSON.stringify({code, error}));
  }
  function scheduleExpiry() {
    if (ended()) return;
    const remaining = sessionExpiresAt - Date.now();
    activeTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
    activeTimer.unref();
  }
  const runtime=await input.createRuntime({async authorize(req:IncomingMessage,action:"read"|"write"){
      await input.assertHeld();
      assert(!closed && !ended(), "operator_session_expired");
      const value=req.headers["x-pirate-private-forwarder"];assert(typeof value==="string" && /^[a-f0-9]{64}$/.test(value) &&
        timingSafeEqual(Buffer.from(value,"hex"),internal),"actual_paired_forwarder_required");
      assert(req.socket.remoteAddress==="127.0.0.1" || req.socket.remoteAddress==="::ffff:127.0.0.1");
      if(input.readOnly && action==="write")throw new CommunityError("web2_pairing_only",403);
    }});
  activeRuntime=runtime;await runtime.listen(input.innerPort);
  if (input.sessionExpiresAt === undefined) sessionExpiresAt = Date.now() + DEFAULT_OPERATOR_SESSION_MS;
  assert(Date.now() < sessionExpiresAt, "operator_session_expired");
  const proxy=createServer((req,res)=>{void(async()=>{
    assert(!closed && (req.socket.remoteAddress==="127.0.0.1" || req.socket.remoteAddress==="::ffff:127.0.0.1"));
    assert(req.headers.host==="127.0.0.1:"+input.frontPort && (!req.headers.origin || req.headers.origin===origin));
    assert(req.headers["sec-fetch-site"]!=="cross-site");
    function sessionExpired() {
      if (!ended()) return false;
      expired(res, "operator_session_expired", sessionExpiredMessage);
      return true;
    }
    if (sessionExpired()) return;
    await input.assertHeld();
    if (sessionExpired()) return;
    // Ordinary same-origin form navigation needs a non-opaque Origin. With
    // no-referrer Chrome sends Origin:null and the exact-origin guard refuses.
    // same-origin still withholds referrers from every cross-origin destination.
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","same-origin");
    const pairForm = !paired && req.method === "GET" && new URL(req.url ?? "/", origin).pathname === "/";
    const pairSubmit = req.method === "POST" && req.url === "/pair";
    function pairExpired() {
      if (!pairEnded && Date.now() < pairExpiresAt) return false;
      pairEnded = true;
      pairing.fill(0);
      expired(res, "operator_pairing_expired", "This pairing code expired. Open a newly authorized setup session for the saved original.");
      return true;
    }
    if ((pairForm || (pairSubmit && !paired)) && pairExpired()) return;
    if(pairForm){
      res.setHeader("Content-Type","text/html; charset=utf-8");
      res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Connect this operator</title><form method="post" action="/pair"><label>Private operator pairing code <input name="code" type="password" autocomplete="off" required></label><button>Connect</button></form>');return;
    }
    if(pairSubmit){
      assert(!paired && ++attempts<=10 && req.headers.origin===origin);
      let text="";for await(const b of req){text+=b;if(text.length>512)throw new Error("pairing_body_limit");}
      if (sessionExpired() || pairExpired()) return;
      const encoded=new URLSearchParams(text).get("code")??"",candidate=Buffer.from(encoded,"base64url");
      try{assert(candidate.length===32 && candidate.toString("base64url")===encoded && timingSafeEqual(candidate,pairing),"pairing_denied");}
      finally{candidate.fill(0);text="";}
      await createJSON(input.pairingNonceDirectory,"paired-"+hash(pairing),{installationId:input.installationId,pairedAt:Date.now()});
      paired=true;pairing.fill(0);
      if (sessionExpired() || pairExpired()) return;
      const maxAge = Math.floor((sessionExpiresAt - Date.now()) / 1000);
      if (maxAge <= 0) {
        expired(res, "operator_session_expired", sessionExpiredMessage);
        return;
      }
      res.setHeader("Set-Cookie", "pirate_operator_session=" + session.toString("hex") +
        "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + maxAge);
      res.writeHead(303,{Location:"/?setup="+(input.setup??"linux")}).end();return;
    }
    assert(paired,"operator_pairing_required");
    const supplied=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("pirate_operator_session="))?.slice("pirate_operator_session=".length);
    assert(supplied && /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(createHash("sha256").update(Buffer.from(supplied,"hex")).digest(),sessionHash),"operator_session_denied");
    if(req.method!=="GET" && req.method!=="HEAD"){
      assert(req.headers.origin===origin);
      if(input.readOnly){
        res.writeHead(403,{"Content-Type":"application/json"}).end('{"code":"web2_pairing_only","error":"This pairing session is read-only."}');
        return;
      }
    }
    // The browser cannot select the private origin or internal credential.
    const forward=httpRequest({hostname:"127.0.0.1",port:input.innerPort,path:req.url,method:req.method,
      headers:{...req.headers,host:"127.0.0.1:"+input.innerPort,origin:"http://127.0.0.1:"+input.innerPort,
        "x-pirate-private-forwarder":internal.toString("hex")}},reply=>{
      res.writeHead(reply.statusCode!, {
        ...reply.headers, "x-pirate-operator-session-expires-at": String(sessionExpiresAt),
      });
      reply.pipe(res);
    });
    const nativeInstallation=req.method==="POST" && ["/api/web2/installation-prepare","/api/web2/install","/api/web2/installation-status"].includes(req.url??"");
    forward.setTimeout(nativeInstallation?180000:30000,()=>forward.destroy(new Error("operator_forward_timeout")));
    forward.on("error",()=>res.destroy());req.on("error",()=>forward.destroy());req.pipe(forward);
  })().catch(()=>{if(!res.headersSent)res.writeHead(403,{"Content-Type":"application/json"}).end('{"error":"operator_authorization_required"}');else res.destroy();});});
  activeProxy=proxy;await new Promise<void>((resolve,reject)=>{proxy.once("error",reject);proxy.listen(input.frontPort,"127.0.0.1",resolve);});
  scheduleExpiry();
  let closeWork:Promise<void>|undefined,closeRequested=false,proxyClosed=false,runtimeClosed=false,beforeClosed=false;
  let beforeClose:(()=>Promise<void>)|undefined;
  return {origin,
    close(beforeRuntimeClose?:()=>Promise<void>){
      if(!closeRequested){closeRequested=true;beforeClose=beforeRuntimeClose;}
      if(closeWork)return closeWork;
      closeWork=(async()=>{
      closed=true;clearTimeout(activeTimer);proxy.closeAllConnections();
      const errors:unknown[]=[];
      if(!proxyClosed)try{await new Promise<void>((resolve,reject)=>proxy.close(e=>e?reject(e):resolve()));proxyClosed=true;}catch(e){errors.push(e);}
      if(!beforeClosed)try{await beforeClose?.();beforeClosed=true;}catch(e){errors.push(e);}
      if(!runtimeClosed)try{runtime.server.closeAllConnections();await runtime.close();runtimeClosed=true;}catch(e){errors.push(e);}
      for(const bytes of transient)bytes.fill(0);
      if(errors.length)throw new AggregateError(errors,"paired_runtime_custody_retained");
      })().catch(error=>{closeWork=undefined;throw error;});
      return closeWork;
    },
  };
  }catch(error){
    if(activeTimer)clearTimeout(activeTimer);
    for(const bytes of transient)bytes.fill(0);
    let proxyClosed=!activeProxy,runtimeClosed=!activeRuntime,work:Promise<void>|undefined;
    const close=()=>work??=(async()=>{
      const errors:unknown[]=[];
      if(!proxyClosed)try{
        activeProxy!.closeAllConnections();
        if(activeProxy!.listening)await new Promise<void>((resolve,reject)=>activeProxy!.close(e=>e?reject(e):resolve()));
        proxyClosed=true;
      }catch(e){errors.push(e);}
      if(!runtimeClosed)try{activeRuntime!.server.closeAllConnections();await activeRuntime!.close();runtimeClosed=true;}
      catch(e){errors.push(e);}
      if(errors.length)throw errors.length===1?errors[0]:new AggregateError(errors,"paired_runtime_custody_retained");
    })().catch(error=>{work=undefined;throw error;});
    try{await close();}catch(cleanup){throw new PairedOperatorStartupFailure([error,cleanup],close);}
    throw error;
  }
}

export async function bootstrapLocalTarget(input:LocalTargetBootstrapInputs) {
  assert(input.frontPort!==input.innerPort && input.pairingSecret.length===32);
  const agent=await startManagedKeyAgent({...input.keyAgent,installationId:input.backend.installationId,
    authenticationKey:input.backend.keyChannel.authenticationKey,lease:input.backend.bootstrapLease,capturedRoots:[...Object.values(input.backend.snapshotRoots),input.backend.operationsDirectory,input.backend.resultsDirectory,
      input.backend.observationDirectory,input.backend.plansDirectory,input.backend.profileRecordsDirectory,
      ...(input.backend.runtimeProfile === "full-v2" ? [input.backend.inspectionDirectory] : []),input.backend.bootstrapLease.directory,input.wizardDirectory]});
  let implementation:Awaited<ReturnType<typeof createLocalTargetImplementation>>|undefined;
  try{
    implementation=await createLocalTargetImplementation(input.backend);
    const actual=implementation;
    const paired=await startPairedOperator({installationId:input.backend.installationId,frontPort:input.frontPort,innerPort:input.innerPort,
      pairingSecret:input.pairingSecret,pairingNonceDirectory:input.pairingNonceDirectory,
      assertHeld:()=>input.backend.bootstrapLease.assertHeld(),
      createRuntime:authorization=>createLinuxWizardRuntime({directory:input.wizardDirectory,dist:input.wizardDist,
        backend:actual.complete,naming:input.backend.namespace,authorization,
        custody:{assertHeld:()=>input.backend.bootstrapLease.assertHeld(),release:async()=>{await releaseClearedOperation(input.bootstrapClearance);}}}),
    });
    return {origin:paired.origin,implementation:actual,async close(){
      const errors:unknown[]=[];
      try{await paired.close(async()=>{await actual.close();});}catch(e){errors.push(e);}
      try{await agent.close();}catch(e){errors.push(e);}
      if(errors.length){await input.backend.bootstrapLease.record("bootstrap-close-custody-retained",{errors:errors.map(e=>e instanceof Error?e.name:"unknown")});throw errors[0];}
    }};
  }catch(error){
    const cleanupErrors:string[]=[];
    try{await implementation?.close();}catch(e){cleanupErrors.push(e instanceof Error?e.name:"unknown");}
    try{await agent.close();}catch(e){cleanupErrors.push(e instanceof Error?e.name:"unknown");}
    if(cleanupErrors.length)await input.backend.bootstrapLease.record("bootstrap-cleanup-failed",{cleanupErrors});
    throw error;
  }
}
