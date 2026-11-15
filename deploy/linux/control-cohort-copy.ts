import assert from "node:assert/strict";
import {mkdir,lstat,readdir,open} from "node:fs/promises";
import {constants} from "node:fs";
import {join} from "node:path";
import {privateDirectory,privateFile,hash,syncDirectory,type OperationLease} from "./backend-state.ts";
/** Freeze the original controller journals at an explicit cut. The active
 * backup controller remains OUTSIDE this staged role; its later receipt is
 * separately retained. Existing original files are never edited or omitted. */
export async function copyControlCohort(input:{source:string;target:string;lease:OperationLease}) {
 await input.lease.assertHeld();await privateDirectory(input.source);await mkdir(input.target,{mode:0o700});
 const files:Array<{path:string;sha256:string;bytes:number}>=[];
 async function visit(source:string,target:string,prefix:string){
  await privateDirectory(source);const sourceIdentity=await lstat(source);
  const entries=await readdir(source,{withFileTypes:true});
  for(const entry of entries.sort((a,b)=>a.name<b.name?-1:1)){
   assert(!entry.isSymbolicLink());const a=join(source,entry.name),b=join(target,entry.name),rel=prefix+entry.name;
   if(entry.isDirectory()){await mkdir(b,{mode:0o700});await visit(a,b,rel+"/");await syncDirectory(b);}
   else{
    const fd=await privateFile(a,32*1024**2);const before=await fd.stat({bigint:true}),bytes=await fd.readFile(),after=await fd.stat({bigint:true});await fd.close();
    assert(before.dev===after.dev && before.ino===after.ino && before.size===after.size && before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs,"control_source_changed");
    const out=await open(b,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{await out.writeFile(bytes);await out.sync();}finally{await out.close();}
    files.push({path:rel,sha256:hash(bytes),bytes:bytes.length});
    assert(files.length<=100000,"control_cohort_file_limit");
   }
  }
  const after=await lstat(source);assert(after.dev===sourceIdentity.dev && after.ino===sourceIdentity.ino,"control_directory_changed");
 }
 await visit(input.source,input.target,"");await syncDirectory(input.target);
 // Recheck exact source names and bytes after the copy, without following links.
 const after:string[]=[];
 async function check(path:string,prefix:string){
  await privateDirectory(path);
  for(const item of await readdir(path,{withFileTypes:true})){assert(!item.isSymbolicLink());
   if(item.isDirectory())await check(join(path,item.name),prefix+item.name+"/");
   else{const rel=prefix+item.name,row=files.find(x=>x.path===rel);assert(row);const fd=await privateFile(join(path,item.name),32*1024**2);
    try{const bytes=await fd.readFile();assert(hash(bytes)===row.sha256 && bytes.length===row.bytes);}finally{await fd.close();}after.push(rel);}
  }
 }
 await check(input.source,"");assert.deepEqual(after.sort(),files.map(x=>x.path).sort());
 const evidence=await input.lease.record("original-control-cohort-frozen",{source:input.source,target:input.target,files});
 return {files,evidence,target:input.target};
}

