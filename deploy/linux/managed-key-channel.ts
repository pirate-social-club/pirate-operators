import assert from "node:assert/strict";
import {createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {connect, createServer, type Socket} from "node:net";
import {lstat, chmod} from "node:fs/promises";
import {privateFile, privateDirectory, createJSON, hash, type OperationLease} from "./backend-state.ts";
import {canonicalDigest, signRecord, type TrustAnchor} from "./installed-records.ts";

const mac=(key:Uint8Array,body:unknown)=>createHmac("sha256",key).update(JSON.stringify(body)).digest("hex");
function authentic(a:string,b:string) { return /^[0-9a-f]{64}$/.test(a) && timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex")); }
async function exchange(socket:Socket, request?:unknown):Promise<any> {
  return await new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0,done=false;
    const stop=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);if(error){socket.destroy();reject(error);} };
    const timer=setTimeout(()=>stop(new Error("key_channel_timeout")),5000);
    socket.on("error",e=>stop(e));socket.on("data",(b:Buffer)=>{
      size+=b.length;if(size>65536){stop(new Error("key_channel_limit"));return;} chunks.push(b);
      if(b.includes(10)) {
        try { const all=Buffer.concat(chunks);assert(all[all.length-1]===10 && all.indexOf(10)===all.length-1);
          const value=JSON.parse(all.toString("utf8"));stop();resolve(value);
        } catch {stop(new Error("key_channel_protocol"));}
        finally { for(const chunk of chunks)chunk.fill(0); }
      }
    });
    socket.on("end",()=>{if(!done)stop(new Error("key_channel_incomplete"));});
    if(request!==undefined)socket.once("connect",()=>socket.write(JSON.stringify(request)+"\n"));
  });
}
export async function createManagedKeyClient(input:{socket:string; installationId:string; authenticationKey:Uint8Array; lease:OperationLease}) {
  assert(input.authenticationKey.byteLength===32);
  const key=Buffer.from(input.authenticationKey);const expected=await lstat(input.socket);
  assert(expected.isSocket() && expected.uid===process.getuid!() && !(expected.mode&0o077));
  let disposed=false;
  async function call(action:"key"|"sign-profile",ref:string,generation:number,body?:unknown) {
    assert(!disposed);await input.lease.assertHeld();
    const current=await lstat(input.socket);assert(current.dev===expected.dev && current.ino===expected.ino,"key_agent_changed");
    const request={installationId:input.installationId,action,ref,generation,body:body??null,
      nonce:randomBytes(24).toString("hex"),expiresAt:Date.now()+5000};
    const socket=connect(input.socket);
    try {
      const response=await exchange(socket,{request,mac:mac(key,request)});
      assert(response.requestNonce===request.nonce && response.installationId===input.installationId &&
        response.expiresAt>=Date.now() && response.expiresAt<=request.expiresAt &&
        authentic(response.mac,mac(key,{requestNonce:response.requestNonce,installationId:response.installationId,
          expiresAt:response.expiresAt,value:response.value})),"key_agent_authentication_failed");
      return response.value;
    } finally {socket.destroy();}
  }
  async function withSecret<T>(ref:string,generation:number,action:(key:Uint8Array)=>Promise<T>) {
      const encoded=await call("key",ref,generation);assert(typeof encoded==="string");
      const bytes=Buffer.from(encoded,"base64url");
      try {assert(bytes.length>0 && bytes.length<=8192 && bytes.toString("base64url")===encoded);return await action(bytes);}
      finally {bytes.fill(0);}
  }
  return {
    withSecret,
    async withKey<T>(ref:string,generation:number,action:(key:Uint8Array)=>Promise<T>) {
      return withSecret(ref,generation,async key=>{assert(key.length===32);return action(key);});
    },
    signProfile:(body:unknown,generation:number)=>call("sign-profile","profile",generation,body),
    dispose(){if(!disposed){disposed=true;key.fill(0);}}
  };
}
/** An actual private local agent. Inputs are installed by the authenticated
 * bootstrap owner outside every backup root. No environment/key lookup. */
export async function startManagedKeyAgent(input:{
  socket:string;directory:string;installationId:string;authenticationKey:Uint8Array;lease:OperationLease;
  keys:ReadonlyArray<{ref:string;generation:number;path:string;bytes:number}>;signingKeyFile:string;trust:TrustAnchor;
  permittedProfileDigests:ReadonlySet<string>;
  capturedRoots:string[];
}) {
  await privateDirectory(input.directory);assert(input.socket.startsWith(input.directory+"/") && input.authenticationKey.byteLength===32);
  for(const path of [input.directory,input.signingKeyFile,...input.keys.map(x=>x.path)])assert(input.capturedRoots.every(r=>path!==r && !path.startsWith(r+"/") && !r.startsWith(path+"/")),"managed_key_material_inside_cohort");
  const key=Buffer.from(input.authenticationKey),nonces=new Set<string>();
  const server=createServer(socket=>{void(async()=>{
    const packet=await exchange(socket);await input.lease.assertHeld();const r=packet.request;
    assert(authentic(packet.mac,mac(key,r)) && r.installationId===input.installationId &&
      r.expiresAt>=Date.now() && r.expiresAt<=Date.now()+5000 && /^[a-f0-9]{48}$/.test(r.nonce) &&
      !nonces.has(r.nonce),"key_agent_request_denied");
    assert(nonces.size<10000,"key_agent_session_limit");nonces.add(r.nonce);
    await createJSON(input.directory,"used-"+hash(r.nonce),{installationId:r.installationId,nonce:r.nonce,expiresAt:r.expiresAt});
    let value:unknown;
    if(r.action==="key") {
      const selected=input.keys.find(x=>x.ref===r.ref && x.generation===r.generation);assert(selected,"key_ref_denied");
      assert(Number.isSafeInteger(selected.bytes) && selected.bytes>0 && selected.bytes<=8192);
      const file=await privateFile(selected.path,8192);
      const bytes=await file.readFile();await file.close();
      try {assert(bytes.length===selected.bytes);value=bytes.toString("base64url");} finally {bytes.fill(0);}
    } else {
      assert(r.action==="sign-profile" && r.ref==="profile" && r.body.installationId===input.installationId &&
        r.body.generation===r.generation && input.permittedProfileDigests.has(canonicalDigest(r.body.profile)),"profile_signing_denied");
      const file=await privateFile(input.signingKeyFile,8192);const bytes=await file.readFile();await file.close();
      try {value=signRecord(r.body,input.trust,bytes);} finally {bytes.fill(0);}
    }
    const response={requestNonce:r.nonce,installationId:input.installationId,expiresAt:r.expiresAt,value};
    socket.end(JSON.stringify({...response,mac:mac(key,response)})+"\n");
  })().catch(()=>socket.destroy());});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(input.socket,resolve);});
  await chmod(input.socket,0o600);const identity=await lstat(input.socket);
  return {async close(){
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));key.fill(0);
    try {const actual=await lstat(input.socket);assert(actual.dev===identity.dev && actual.ino===identity.ino,"key_socket_custody_changed");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    // Socket retention and operation custody remain for the independent owner.
  }};
}

