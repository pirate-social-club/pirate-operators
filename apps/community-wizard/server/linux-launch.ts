// Installed local composition is trusted operator code, never a downloaded
// plugin or a JSON capability flag. It must supply all genuine native inputs.
import assert from "node:assert/strict";
import {constants} from "node:fs";
import {open,lstat,realpath,access} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash,randomBytes} from "node:crypto";
import type {LocalTargetBootstrapInputs,LocalTargetCreateBootstrapInputs} from "../../../deploy/linux/bootstrap-local-target.ts";
export type InstalledLinuxInputs=Omit<LocalTargetBootstrapInputs,"pairingSecret"|"wizardDist">;
export type InstalledLinuxCreateInputs=Omit<LocalTargetCreateBootstrapInputs,"pairingSecret"|"wizardDist">;
export interface InstalledLinuxComposition {createLinuxBootstrapInputs():Promise<InstalledLinuxInputs>}
export function linuxLaunchOptions(args:readonly string[]){
 const values=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){
  const key=args[i],value=args[i+1];
  assert((key==="--composition"||key==="--sha256")&&value&&!value.startsWith("--")&&!values.has(key),"linux_launch_arguments");
  values.set(key,value);
 }
 const composition=values.get("--composition"),sha256=values.get("--sha256");
 assert(composition&&sha256&&/^[a-f0-9]{64}$/.test(sha256),"linux_launch_composition_and_digest_required");
 return {composition:resolve(composition),sha256};
}
async function privateComposition(path:string){
 assert(path===await realpath(path)&&/\.(mjs|js|ts)$/.test(path),"canonical_private_composition_required");
 for(let parent=dirname(path);;parent=dirname(parent)){
  const info=await lstat(parent);assert(info.isDirectory()&&!(info.mode&0o022),"private_composition_parent_required");
  const inGit=await access(join(parent,".git")).then(()=>true,()=>false);
  assert(!inGit,"installed_composition_outside_git_required");
  if(dirname(parent)===parent)break;
 }
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
 const info=await handle.stat();
 assert(info.isFile()&&info.nlink===1&&info.uid===process.getuid!()&&!(info.mode&0o077)&&info.size<=65536,"private_composition_file_required");
 return {handle,info};
 }catch(error){await handle.close();throw error;}
}
export async function launchInstalledLinuxWizard(options:ReturnType<typeof linuxLaunchOptions>,wizardDist:string){
 const {handle,info}=await privateComposition(options.composition);
 const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
 async function unchanged(){
  const now=await handle.stat(),path=await lstat(options.composition);
  assert(now.dev===info.dev&&now.ino===info.ino&&now.size===info.size&&now.mtimeMs===info.mtimeMs&&now.ctimeMs===info.ctimeMs&&
   path.dev===info.dev&&path.ino===info.ino&&path.nlink===1,"installed_composition_changed");
  const bytes=Buffer.alloc(info.size);const read=await handle.read(bytes,0,bytes.length,0);
  assert(read.bytesRead===bytes.length&&digest(bytes)===options.sha256,"installed_composition_digest_changed");
 }
 try{
  await unchanged();
  const url=pathToFileURL(options.composition);url.searchParams.set("source",options.sha256);
  const loaded:InstalledLinuxComposition=await import(url.href);
  assert(typeof loaded.createLinuxBootstrapInputs==="function","actual_linux_composition_required");
  const inputs=await loaded.createLinuxBootstrapInputs();
  assert(inputs&&typeof inputs==="object"&&!Object.hasOwn(inputs,"pairingSecret")&&!Object.hasOwn(inputs,"wizardDist"),"closed_linux_bootstrap_inputs_required");
  assert(Number.isInteger(inputs.frontPort)&&inputs.frontPort>0&&inputs.frontPort<=65535&&
   Number.isInteger(inputs.innerPort)&&inputs.innerPort>0&&inputs.innerPort<=65535&&inputs.frontPort!==inputs.innerPort,"explicit_loopback_ports_required");
  await unchanged();
  // No fallback factory: this exact constructor validates the actual source,
  // signed profiles/Directory, key services, leases, native resources and ports.
  const {bootstrapLocalTarget}=await import("../../../deploy/linux/bootstrap-local-target.ts");
  await unchanged();
  const pairingSecret=randomBytes(32);
  try{
   const runtime=await bootstrapLocalTarget({...inputs,wizardDist:resolve(wizardDist),pairingSecret});
   return {runtime,origin:runtime.origin+"/?setup=linux",pairingCode:pairingSecret.toString("base64url"),
    erasePairing(){pairingSecret.fill(0);}};
  }catch(error){pairingSecret.fill(0);throw error;}
 }finally{await handle.close();}
}
