import assert from "node:assert/strict";
import {readFile,lstat,readdir,realpath} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {canonicalDigest,readPrivateJSON,verifyRecord,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {immutableRecord} from "./installed-records.ts";
import {type OperationLease} from "./backend-state.ts";
import {type NativeGraph,renderFullNativeConfig} from "./full-native-config.ts";
export interface FullRelease {
  schema:"pirate.complete-linux-release/1"|"pirate.complete-linux-web2-release/1";sourceHead:string;sourceTree:string;root:string;
  sourceRoot:string;
  execution:{node:"toolchain/node";nodeSha256:string;nodeVersion:"v24.18.1";
    loader:"toolchain/node_modules/tsx/dist/loader.mjs";tsxVersion:"4.20.6";backend:"source/backend.ts"};
  files:Record<string,string>;sourceHashes:Record<string,string>;requiredRoles:string[];
  graph:NativeGraph;artifactDigest:string;sourceDigest:string;imageId:string;
}
/** Installed bytes before enrollment. It contains no community identity,
 * deployment binding, origin or runtime graph. */
export interface Web2BootstrapRelease extends Omit<FullRelease,"schema"|"graph"|"requiredRoles"> {
  schema:"pirate.linux-web2-bootstrap-release/1";
}
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const digestFile=async(path:string)=>{
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(path))hash.update(chunk as Uint8Array);
  return hash.digest("hex");
};
export function installedExecutionPaths(release:FullRelease|Web2BootstrapRelease) {
  assert(release.root.startsWith("/") && release.sourceRoot===join(release.root,"source"),"single_installed_source_root_required");
  if("graph" in release)assert(release.graph.releaseRoot===release.root,"single_installed_release_root_required");
  const e=release.execution;
  assert(e?.node==="toolchain/node" && e.nodeVersion==="v24.18.1" && e.tsxVersion==="4.20.6" &&
    e.loader==="toolchain/node_modules/tsx/dist/loader.mjs" && e.backend==="source/backend.ts","pinned_installed_execution_required");
  assert(/^[a-f0-9]{64}$/.test(e.nodeSha256) && release.files[e.node]===e.nodeSha256,"installed_node_digest_changed");
  const web2=release.schema!=="pirate.complete-linux-release/1";
  for(const path of [e.loader,e.backend,"source/package.json","source/deploy/linux/local-install-main.ts",
    "source/deploy/linux/local-installation.ts",
    ...(web2?["source/deploy/linux/web2-local-installation.ts","source/deploy/linux/web2-launch.ts",
      "source/deploy/linux/web2-service.ts",
      "source/deploy/linux/web2-runtime-binding.ts",
      "source/packages/community/web2-native-business-binding.ts"]:
      ["source/deploy/linux/local-target-services.ts","source/deploy/linux/shared-v2-result-producer.ts"]),
    "toolchain/node_modules/tsx/package.json","wizard/index.html"])
    assert(Object.hasOwn(release.files,path),"complete_installed_runtime_closure_required: "+path);
  return {node:join(release.root,e.node),loader:join(release.root,e.loader),backend:join(release.root,e.backend),
    main:join(release.sourceRoot,web2?"deploy/linux/web2-service.ts":"deploy/linux/local-install-main.ts"),wizardDist:join(release.root,"wizard")};
}
async function verifyInstalledArtifacts(release:FullRelease|Web2BootstrapRelease) {
  const started=performance.now(),fileCount=Object.keys(release.files).length;
  let filesVerified=0,completed=false;
  const facts={event:"installed-artifact-verification",sourceHead:release.sourceHead,artifactDigest:release.artifactDigest,fileCount};
  console.error(JSON.stringify({...facts,phase:"start",at:Date.now()}));
  try{
  assert((release.schema==="pirate.complete-linux-release/1" || release.schema==="pirate.complete-linux-web2-release/1" ||
    release.schema==="pirate.linux-web2-bootstrap-release/1") &&
    /^[a-f0-9]{40}$/.test(release.sourceHead) && /^[a-f0-9]{40}$/.test(release.sourceTree));
  assert.equal(await realpath(release.root),release.root);
  installedExecutionPaths(release);
  // The signed record is external to this immutable tree. No ancestor can
  // provide a checkout, package fallback, or ambient NODE_PATH dependency.
  for(let parent=release.root;;parent=dirname(parent)) {
    for(const name of [".git","node_modules"]){
      try{await lstat(join(parent,name));throw new Error("ambient_installed_dependency_or_checkout_refused");}
      catch(error){if(!(error instanceof Error && "code" in error && error.code==="ENOENT"))throw error;}
    }
    if(dirname(parent)===parent)break;
  }
  const expected=Object.keys(release.files).sort(),found:string[]=[];
  async function walk(path:string,prefix:string) {
    const directory=await lstat(path);assert(directory.isDirectory() && !(directory.mode&0o222),"immutable_installed_directory_required");
    for(const row of await readdir(path,{withFileTypes:true})){
      assert(!row.isSymbolicLink());const rel=prefix+row.name;
      if(row.isDirectory())await walk(join(path,row.name),rel+"/");else{assert(row.isFile());found.push(rel);}
    }
  }
  await walk(release.root,"");assert.deepEqual(found.sort(),expected,"complete_release_pathset_changed");
  // The immutable inventory can contain tens of thousands of small dependency
  // files. Bound concurrent reads instead of serializing every filesystem
  // round-trip; check every original byte/path/mode and settle all reads before
  // returning or refusing. There is no cached or skipped verification.
  const entries=Object.entries(release.files);let next=0;
  const verified=await Promise.allSettled(Array.from({length:Math.min(8,entries.length)},async()=>{
   for(;;){const index=next++;if(index>=entries.length)return;const [path,sha]=entries[index]!;
    assert(!path.startsWith("/") && path.split("/").every(x=>x && x!=="." && x!==".."));
    const file=join(release.root,path),s=await lstat(file);assert(s.isFile() && !s.isSymbolicLink());
    assert.equal(await realpath(file),file,"installed_symlink_ancestor_refused");
    assert(!(s.mode&0o222),"immutable_installed_file_required");
    assert.equal(await digestFile(file),sha,"complete_release_bytes_changed");
    filesVerified++;
   }
  }));
  const failures=verified.filter((result):result is PromiseRejectedResult=>result.status==="rejected");
  if(failures.length)throw failures[0]!.reason;
  for(const [path,sha] of Object.entries(release.sourceHashes)) {
    assert(!path.startsWith("/") && path.split("/").every(x=>x && x!=="." && x!==".."));
    assert.equal(release.files["source/"+path],sha,"installed_authored_source_missing");
  }
  for(const [path,sha] of Object.entries(release.files))if(path.startsWith("source/") && !path.split("/").includes("node_modules"))
    assert.equal(release.sourceHashes[path.slice(7)],sha,"authored_installed_source_digest_missing");
  const tsx=JSON.parse(await readFile(join(release.root,"toolchain/node_modules/tsx/package.json"),"utf8"));
  assert(tsx.name==="tsx" && tsx.version===release.execution.tsxVersion,"installed_loader_version_changed");
  const sourcePackage=JSON.parse(await readFile(join(release.sourceRoot,"package.json"),"utf8"));
  assert(sourcePackage.type==="module","installed_source_esm_required");
  assert(/^sha256:[a-f0-9]{64}$/.test(release.imageId),"actual_post_build_image_identity_required");
  for(const file of ["application.mjs","queue.mjs","maintenance.mjs","database.worker.js","bucket.worker.js",
    "object-entry.worker.js","shared.worker.js","zod.worker.js","assets.worker.mjs","asset-index.json","egress-policy.worker.mjs","deny.worker.mjs",
    "full-gateway.worker.mjs","full-startup.worker.mjs","selected-handler-observer.worker.mjs","maintenance.bootstrap.mjs","cold-reconcile.worker.mjs",
    "workerd","workerd.capnp","full-launch.mjs","migration-plan.json"])
    assert(Object.hasOwn(release.files,file),"complete_native_module_missing");
  assert(Object.hasOwn(release.sourceHashes,"services/community-application.ts") &&
    Object.hasOwn(release.sourceHashes,"services/linux-community.ts"),"actual_owning_application_source_required");
  assert.equal(release.sourceDigest,"0x"+canonicalDigest(release.sourceHashes));
  assert.equal(release.artifactDigest,"0x"+canonicalDigest(release.files));
  completed=true;
  }finally{
   console.error(JSON.stringify({...facts,phase:"end",at:Date.now(),elapsedMs:performance.now()-started,
     filesVerified,outcome:completed?"verified":"refused"}));
  }
}
export async function verifyWeb2BootstrapRelease(record:SignedRecord<Web2BootstrapRelease>,trust:TrustAnchor) {
  const release=verifyRecord(record,trust);
  assert(release.schema==="pirate.linux-web2-bootstrap-release/1","explicit_web2_bootstrap_required");
  assert.deepEqual(Object.keys(release).sort(),["artifactDigest","execution","files","imageId","root","schema",
    "sourceDigest","sourceHashes","sourceHead","sourceRoot","sourceTree"].sort(),"bootstrap_must_not_prebind_community");
  await verifyInstalledArtifacts(release);return release;
}
export async function verifyInstalledRelease(record:SignedRecord<FullRelease>,trust:TrustAnchor) {
  const release=verifyRecord(record,trust);
  assert(release.schema==="pirate.complete-linux-release/1" || release.schema==="pirate.complete-linux-web2-release/1");
  await verifyInstalledArtifacts(release);
  assert.deepEqual(release.graph.requiredRoles,release.requiredRoles);renderFullNativeConfig(release.graph,"serve","1".repeat(64)); // structure only; launcher supplies fresh actual boot ID
  assert.equal(release.graph.releaseRoot,release.root);
  assert.equal(release.graph.migrationPlanFile,join(release.root,"migration-plan.json"),"exact_installed_migration_plan_required");
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

