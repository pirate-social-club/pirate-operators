/** Prepared read-only consumer of GENUINE native captures. Root supplies the
 * separately admitted private cohort, real signed release, exact input pin and
 * fresh probe lease directory. This never fabricates an accepted closed row,
 * runs a dispatcher or invokes ordinary operator.reconcile. */
import assert from "node:assert/strict";
import {readFile,readdir,lstat} from "node:fs/promises";
import {join} from "node:path";
import {hash,acquireOperation,processIdentity} from "../deploy/linux/backend-state.ts";
import {SharedResultProducer} from "../deploy/linux/shared-v2-result-producer.ts";
interface Case {name:string;inputs:Parameters<typeof SharedResultProducer.create>[0];
 operation:unknown;retainedIntent:Parameters<SharedResultProducer["terminal"]>[0]["retainedIntent"];
 expected:"pending"|"result"|"reject";expectedResultSha256:string|null;expectedError:string|null;}
const path=process.argv[2],expectedInputSha=process.argv[3];assert(path && /^[a-f0-9]{64}$/.test(expectedInputSha??""));
const bytes=await readFile(path);assert.equal(hash(bytes),expectedInputSha);
const input=JSON.parse(bytes.toString("utf8")) as {probeDirectory:string;probeOperationId:string;cases:Case[]};
assert(input.cases.length>0 && input.cases.length<=12);
async function inventory(root:string){
 const rows:unknown[]=[];async function walk(dir:string,prefix:string){for(const name of (await readdir(dir)).sort()){
  const full=join(dir,name),s=await lstat(full);assert(!s.isSymbolicLink());
  if(s.isDirectory()){rows.push({path:prefix+name,kind:"directory",mode:s.mode&0o777});await walk(full,prefix+name+"/");}
  else{assert(s.isFile());rows.push({path:prefix+name,kind:"file",mode:s.mode&0o777,sha256:hash(await readFile(full))});}
 }}await walk(root,"");return hash(JSON.stringify(rows));
}
const frame=await processIdentity(process.pid);assert(frame);
const installationId=input.cases[0]!.inputs.installationId;
const lease=await acquireOperation(input.probeDirectory,input.probeOperationId,installationId,
 {schema:"pirate.shared-terminal-probe/1",inputSha256:expectedInputSha},frame.pidNamespace);
const metadata=[];
for(const c of input.cases){
 assert(c.inputs.installationId===installationId);
 const before=[await inventory(c.inputs.directory),await inventory(c.inputs.operationsDirectory)];
 const producer=await SharedResultProducer.create({...c.inputs,bootstrapLease:lease});
 let outcome="reject",resultSha256:string|null=null;
 if(c.expected==="reject"){
  assert(typeof c.expectedError==="string" && c.expectedError.length>0);
  for(let n=0;n<2;n++)await assert.rejects(
   ()=>producer.terminal({operation:c.operation,retainedIntent:c.retainedIntent}),{message:c.expectedError});
 }else{
  assert.equal(c.expectedError,null);
  const one=await producer.terminal({operation:c.operation,retainedIntent:c.retainedIntent});
  const two=await producer.terminal({operation:c.operation,retainedIntent:c.retainedIntent});
  assert.deepEqual(two,one,"terminal_regenerated_or_replaced_original");
  outcome=one.state;
  if(one.state==="result")resultSha256=hash(JSON.stringify(one.result)+"\n");
 }
 assert.equal(outcome,c.expected);assert.equal(resultSha256,c.expectedResultSha256);
 const after=[await inventory(c.inputs.directory),await inventory(c.inputs.operationsDirectory)];
 assert.deepEqual(after,before,"terminal_wrote_or_repaired_original_evidence");
 metadata.push({name:c.name,outcome,resultSha256,unchangedInputs:before});
}
// Fresh process launch over the SAME real cohort proves restart equality only
// when Root's separate controller compares these actual metadata receipts.
// No release/clearance of this probe's own native lease is attempted here.
await lease.record("terminal-probe-readback",{inputSha256:expectedInputSha,metadata});
console.log(JSON.stringify({schema:"pirate.shared-terminal-probe-result/1",metadata,leaseRetained:true}));
