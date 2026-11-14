import assert from "node:assert/strict";
import {createServer,request as httpRequest,type IncomingMessage} from "node:http";
import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {createLinuxWizardRuntime} from "../../apps/community-wizard/server/linux-runtime.ts";
import {createLocalTargetImplementation,type LocalTargetInputs} from "./local-target-services.ts";
import {startManagedKeyAgent} from "./managed-key-channel.ts";
import {releaseClearedOperation,type readWholeClearance} from "./independent-clearance.ts";
import {createJSON,hash} from "./backend-state.ts";
/** Ordinary browser -> authenticated loopback proxy -> existing W6 journal
 * runtime. No new wizard HTTP API, bypass of its CSRF/journal or public bind. */
export async function bootstrapLocalTarget(input:{
  backend:LocalTargetInputs;wizardDirectory:string;wizardDist:string;frontPort:number;innerPort:number;
  pairingSecret:Uint8Array;pairingNonceDirectory:string;
  bootstrapClearance:Parameters<typeof readWholeClearance>[0];
  keyAgent:Omit<Parameters<typeof startManagedKeyAgent>[0],"installationId"|"authenticationKey"|"lease"|"capturedRoots">;
}) {
  assert(input.frontPort!==input.innerPort && input.pairingSecret.length===32);
  const agent=await startManagedKeyAgent({...input.keyAgent,installationId:input.backend.installationId,
    authenticationKey:input.backend.keyChannel.authenticationKey,lease:input.backend.bootstrapLease,capturedRoots:[...Object.values(input.backend.snapshotRoots),input.backend.operationsDirectory,input.backend.resultsDirectory,
      input.backend.observationDirectory,input.backend.plansDirectory,input.backend.profileRecordsDirectory,
      input.backend.inspectionDirectory,input.backend.bootstrapLease.directory,input.wizardDirectory]});
  let activeImplementation:Awaited<ReturnType<typeof createLocalTargetImplementation>>|undefined;
  let activeRuntime:Awaited<ReturnType<typeof createLinuxWizardRuntime>>|undefined;
  let activeProxy:ReturnType<typeof createServer>|undefined;
  let activeTimer:ReturnType<typeof setTimeout>|undefined;
  const transient:Buffer[]=[];
  try {
  const implementation=await createLocalTargetImplementation(input.backend);
  activeImplementation=implementation;
  const internal=randomBytes(32),pairing=Buffer.from(input.pairingSecret),session=randomBytes(32),origin="http://127.0.0.1:"+input.frontPort;
  const sessionHash=createHash("sha256").update(session).digest();let paired=false,attempts=0,closed=false;
  transient.push(internal,pairing,session,sessionHash);
  const expires=Date.now()+5*60000;
  const runtime=await createLinuxWizardRuntime({directory:input.wizardDirectory,dist:input.wizardDist,backend:implementation.complete,
    naming:input.backend.namespace,custody:{assertHeld:()=>input.backend.bootstrapLease.assertHeld(),
      release:async()=>{await releaseClearedOperation(input.bootstrapClearance);}},
    authorization:{async authorize(req:IncomingMessage){
      const value=req.headers["x-pirate-private-forwarder"];assert(typeof value==="string" && /^[a-f0-9]{64}$/.test(value) &&
        timingSafeEqual(Buffer.from(value,"hex"),internal),"actual_paired_forwarder_required");
      assert(req.socket.remoteAddress==="127.0.0.1" || req.socket.remoteAddress==="::ffff:127.0.0.1");
    }}});
  activeRuntime=runtime;await runtime.listen(input.innerPort);
  const proxy=createServer((req,res)=>{void(async()=>{
    assert(!closed && (req.socket.remoteAddress==="127.0.0.1" || req.socket.remoteAddress==="::ffff:127.0.0.1"));
    assert(req.headers.host==="127.0.0.1:"+input.frontPort && (!req.headers.origin || req.headers.origin===origin));
    assert(req.headers["sec-fetch-site"]!=="cross-site");
    res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");
    if(!paired && req.method==="GET" && new URL(req.url??"/",origin).pathname==="/"){
      res.setHeader("Content-Type","text/html; charset=utf-8");
      res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Connect this operator</title><form method="post" action="/pair"><label>Private operator pairing code <input name="code" type="password" autocomplete="off" required></label><button>Connect</button></form>');return;
    }
    if(req.method==="POST" && req.url==="/pair"){
      assert(!paired && ++attempts<=10 && Date.now()<expires && req.headers.origin===origin);
      let text="";for await(const b of req){text+=b;if(text.length>512)throw new Error("pairing_body_limit");}
      const encoded=new URLSearchParams(text).get("code")??"",candidate=Buffer.from(encoded,"base64url");
      try{assert(candidate.length===32 && candidate.toString("base64url")===encoded && timingSafeEqual(candidate,pairing),"pairing_denied");}
      finally{candidate.fill(0);text="";}
      await createJSON(input.pairingNonceDirectory,"paired-"+hash(pairing),{installationId:input.backend.installationId,pairedAt:Date.now()});
      paired=true;pairing.fill(0);
      res.setHeader("Set-Cookie","pirate_operator_session="+session.toString("hex")+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800");
      res.writeHead(303,{Location:"/?setup=linux"}).end();return;
    }
    assert(paired,"operator_pairing_required");
    const supplied=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("pirate_operator_session="))?.slice("pirate_operator_session=".length);
    assert(supplied && /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(createHash("sha256").update(Buffer.from(supplied,"hex")).digest(),sessionHash),"operator_session_denied");
    if(req.method!=="GET" && req.method!=="HEAD")assert(req.headers.origin===origin);
    // The browser cannot select the private origin or internal credential.
    const forward=httpRequest({hostname:"127.0.0.1",port:input.innerPort,path:req.url,method:req.method,
      headers:{...req.headers,host:"127.0.0.1:"+input.innerPort,origin:"http://127.0.0.1:"+input.innerPort,
        "x-pirate-private-forwarder":internal.toString("hex")}},reply=>{
      res.writeHead(reply.statusCode!,reply.headers);reply.pipe(res);
    });
    forward.setTimeout(30000,()=>forward.destroy(new Error("operator_forward_timeout")));
    forward.on("error",()=>res.destroy());req.on("error",()=>forward.destroy());req.pipe(forward);
  })().catch(()=>{if(!res.headersSent)res.writeHead(403,{"Content-Type":"application/json"}).end('{"error":"operator_authorization_required"}');else res.destroy();});});
  activeProxy=proxy;await new Promise<void>((resolve,reject)=>{proxy.once("error",reject);proxy.listen(input.frontPort,"127.0.0.1",resolve);});
  const timer=setTimeout(()=>{closed=true;session.fill(0);},30*60000);activeTimer=timer;
  return {
    origin,implementation,
    async close(){
      closed=true;clearTimeout(timer);proxy.closeAllConnections();
      await new Promise<void>((resolve,reject)=>proxy.close(e=>e?reject(e):resolve()));
      const errors:unknown[]=[];
      try{await implementation.close();}catch(e){errors.push(e);}
      try{runtime.server.closeAllConnections();await runtime.close();}catch(e){errors.push(e);}
      try{await agent.close();}catch(e){errors.push(e);}
      for(const bytes of transient)bytes.fill(0);
      if(errors.length){await input.backend.bootstrapLease.record("bootstrap-close-custody-retained",{errors:errors.map(e=>e instanceof Error?e.name:"unknown")});throw errors[0];}
    }
  };
  } catch(error){
    const cleanupErrors:string[]=[];
    if(activeTimer)clearTimeout(activeTimer);
    if(activeProxy?.listening){activeProxy.closeAllConnections();await new Promise<void>(resolve=>activeProxy!.close(()=>resolve()));}
    try{await activeImplementation?.close();}catch(e){cleanupErrors.push(e instanceof Error?e.name:"unknown");}
    try{if(activeRuntime){activeRuntime.server.closeAllConnections();await activeRuntime.close();}}catch(e){cleanupErrors.push(e instanceof Error?e.name:"unknown");}
    try{await agent.close();}catch(e){cleanupErrors.push(e instanceof Error?e.name:"unknown");}
    for(const bytes of transient)bytes.fill(0);
    await input.backend.bootstrapLease.record("bootstrap-first-failure-custody-retained",{cleanupErrors,leaseRetained:true});
    throw error;
  }
}

