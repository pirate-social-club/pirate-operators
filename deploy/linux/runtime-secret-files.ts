import assert from "node:assert/strict";
import {open,lstat,unlink} from "node:fs/promises";
import {constants} from "node:fs";
import {join} from "node:path";
import {privateDirectory,syncDirectory,type OperationLease} from "./backend-state.ts";
import {readWholeClearance} from "./independent-clearance.ts";
export async function materializeRuntimeSecrets(input:{
  directory:string;capturedRoots:string[];lease:OperationLease;
  values:ReadonlyArray<{name:string;bytes:Uint8Array}>;signal:AbortSignal;assertCurrent:()=>Promise<void>;
}) {
  assert(typeof input.assertCurrent==="function","actual_current_effect_authority_required");
  await privateDirectory(input.directory);
  assert(input.capturedRoots.every(r=>input.directory!==r && !input.directory.startsWith(r+"/") && !r.startsWith(input.directory+"/")),"runtime_secrets_inside_cohort");
  const identities:Array<{path:string;dev:number;ino:number}>=[];
  for(const value of input.values){
    await input.lease.assertHeld();assert(/^[A-Z][A-Z0-9_]*$/.test(value.name));
    await input.assertCurrent();assert(!input.signal.aborted,"native_effect_cancelled");
    const path=join(input.directory,value.name),fd=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{await input.assertCurrent();assert(!input.signal.aborted,"native_effect_cancelled");await fd.writeFile(value.bytes);await fd.sync();const s=await fd.stat();identities.push({path,dev:s.dev,ino:s.ino});}
    finally{await fd.close();}
  }
  await syncDirectory(input.directory);
  return {identities,async dispose(clearance:Parameters<typeof readWholeClearance>[0]){
    await readWholeClearance(clearance);
    for(const old of identities){
      const current=await lstat(old.path);assert(current.isFile() && current.nlink===1 && current.dev===old.dev && current.ino===old.ino,"runtime_secret_custody_changed");
      await unlink(old.path);
    }
    await syncDirectory(input.directory);
  }};
}

