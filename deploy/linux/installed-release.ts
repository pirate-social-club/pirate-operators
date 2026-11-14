import assert from "node:assert/strict";
import {readFile,lstat,readdir,realpath} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {canonicalDigest,readPrivateJSON,verifyRecord,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {immutableRecord} from "./installed-records.ts";
import {type OperationLease} from "./backend-state.ts";
import {type NativeGraph,renderFullNativeConfig} from "./full-native-config.ts";
export interface FullRelease {
  schema:"pirate.complete-linux-release/1";sourceHead:string;sourceTree:string;root:string;
  files:Record<string,string>;sourceHashes:Record<string,string>;requiredRoles:string[];
  graph:NativeGraph;artifactDigest:string;sourceDigest:string;imageId:string;
}
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export async function verifyInstalledRelease(record:SignedRecord<FullRelease>,trust:TrustAnchor) {
  const release=verifyRecord(record,trust);
  assert(release.schema==="pirate.complete-linux-release/1" && /^[a-f0-9]{40}$/.test(release.sourceHead) && /^[a-f0-9]{40}$/.test(release.sourceTree));
  assert.equal(await realpath(release.root),release.root);
  const expected=Object.keys(release.files).sort(),found:string[]=[];
  async function walk(path:string,prefix:string) {
    for(const row of await readdir(path,{withFileTypes:true})){
      assert(!row.isSymbolicLink());const rel=prefix+row.name;
      if(row.isDirectory())await walk(join(path,row.name),rel+"/");else{assert(row.isFile());found.push(rel);}
    }
  }
  await walk(release.root,"");assert.deepEqual(found.sort(),expected,"complete_release_pathset_changed");
  for(const [path,sha] of Object.entries(release.files)){
    assert(!path.startsWith("/") && path.split("/").every(x=>x && x!=="." && x!==".."));
    const file=join(release.root,path),s=await lstat(file);assert(s.isFile() && !s.isSymbolicLink());
    assert.equal(digest(await readFile(file)),sha,"complete_release_bytes_changed");
  }
  for(const file of ["application.mjs","queue.mjs","maintenance.mjs","database.worker.js","bucket.worker.js",
    "object-entry.worker.js","shared.worker.js","zod.worker.js","assets.worker.mjs","asset-index.json","egress-policy.worker.mjs","deny.worker.mjs",
    "full-gateway.worker.mjs","full-startup.worker.mjs","selected-handler-observer.worker.mjs","maintenance.bootstrap.mjs","cold-reconcile.worker.mjs"])
    assert(Object.hasOwn(release.files,file),"complete_native_module_missing");
  assert(Object.hasOwn(release.sourceHashes,"services/community-application.ts") &&
    Object.hasOwn(release.sourceHashes,"services/linux-community.ts"),"actual_owning_application_source_required");
  assert.equal(release.sourceDigest,"0x"+canonicalDigest(release.sourceHashes));
  assert.equal(release.artifactDigest,"0x"+canonicalDigest(release.files));
  assert.deepEqual(release.graph.requiredRoles,release.requiredRoles);renderFullNativeConfig(release.graph,"serve","1".repeat(64)); // structure only; launcher supplies fresh actual boot ID
  assert.equal(release.graph.releaseRoot,release.root);
  return release;
}
/** Real producer over already-built owning artifacts. It does not compile or
 * replace any handler. Signature requires the actual installed issuer. */
export async function produceInstalledRelease(input:{
  record:SignedRecord<FullRelease>;trust:TrustAnchor;directory:string;lease:OperationLease;
}) {
  const release=await verifyInstalledRelease(input.record,input.trust);
  const evidence=await immutableRecord(input.directory,"complete-release-"+release.artifactDigest.slice(2),input.record,input.lease);
  return {release,evidence};
}

