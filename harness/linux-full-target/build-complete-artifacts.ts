import assert from "node:assert/strict";
import {mkdir,writeFile,readFile,realpath,chmod,lstat,readdir} from "node:fs/promises";
import {join,dirname,extname} from "node:path";
import {createHash} from "node:crypto";
import {buildCommunityArtifacts} from "../community-artifacts.ts";
import {runOwnedCommand} from "../../deploy/linux/backend-command.ts";
import type {OperationLease} from "../../deploy/linux/backend-state.ts";
/** Build real owning bytes; no Docker/provider execution or simulated consumer.
 * Root materializes the exact accepted source/prerequisites before this gate. */
export async function buildCompleteLinuxArtifacts(input:{
 sourceRoot:string;assetDirectory:string;output:string;rawOutputDirectory:string;lease:OperationLease;
 migrations:Parameters<typeof buildCommunityArtifacts>[0]["migrations"];
 node:string;nodeSha256:string;esbuildCLI:string;esbuildCLISha256:string;esbuildNative:string;esbuildNativeSha256:string;
 signal:AbortSignal;environment:NodeJS.ProcessEnv;
 backendModules:Array<{source:string;output:string;sha256:string}>;
 // Complete selected dependency/tsx closure: every file is explicitly pinned,
 // copied as bytes (never checkout symlinks), and covered by release.files.
 toolchainModules:Array<{source:string;output:string;sha256:string;executable?:boolean}>;
 wizardFiles:Array<{source:string;path:string;sha256:string}>;
 actorModules:Array<{source:string;output:string}>;
 migrationPlan:Array<{name:string;sha256:string;sql:string;statements:string[]}>;
 native:{path:string;sha256:string};schema:{path:string;sha256:string};licenses:Array<{path:string;output:string;sha256:string}>;
}) {
 assert(await realpath(input.sourceRoot)===input.sourceRoot && !input.output.startsWith(input.sourceRoot+"/"));
 const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
 assert(sha(await readFile(input.esbuildCLI))===input.esbuildCLISha256 && sha(await readFile(input.esbuildNative))===input.esbuildNativeSha256);
 // The existing producer keeps actual selected migrations/assets/source hashes.
 const owning=await buildCommunityArtifacts({sourceRoot:input.sourceRoot,assetDirectory:input.assetDirectory,target:"linux",migrations:input.migrations});
 assert(owning.entrypoint==="services/linux-community.ts");
 assert(!input.rawOutputDirectory.startsWith(input.output+"/") && input.rawOutputDirectory!==input.output);
 await mkdir(input.output,{mode:0o700});
 const files:Record<string,string>={},sourceHashes=Object.fromEntries(Object.entries(owning.sourceHashes).map(([k,v])=>{assert(typeof v==="string","owning_source_hash_type_required");return [k,v.replace(/^0x/,"")];})),write=async(name:string,bytes:Uint8Array)=>{
   assert(!name.startsWith("/") && name.split("/").every(x=>x && x!=="." && x!==".."));
   assert(!Object.hasOwn(files,name),"duplicate_installed_output");
   await mkdir(dirname(join(input.output,name)),{recursive:true,mode:0o700});
   await writeFile(join(input.output,name),bytes,{flag:"wx",mode:0o444});files[name]=sha(bytes);
 };
 await write("application.mjs",owning.bytes);
 const modules=[
  ["queue.mjs","deploy/linux/durable-queue-worker.ts"],["maintenance.mjs","deploy/linux/durable-maintenance-worker.ts"],
  ["cold-reconcile.worker.mjs","deploy/linux/cold-reconcile.worker.ts"],
  ["full-startup.worker.mjs","deploy/linux/full-startup.worker.ts"],
  ["selected-handler-observer.worker.mjs","deploy/linux/selected-handler-observer.worker.ts"],
  ["maintenance.bootstrap.mjs","deploy/linux/maintenance.bootstrap.mjs"],
  ["full-launch.mjs","deploy/linux/full-launch.ts"],...input.actorModules.map(x=>[x.output,x.source])
 ];
 for(const [output,source] of modules){
  assert(source && output);sourceHashes[source]=sha(await readFile(join(input.sourceRoot,source)));
  await runOwnedCommand({lease:input.lease,executable:input.esbuildNative,executableSha256:input.esbuildNativeSha256,
   argv:[join(input.sourceRoot,source!),"--bundle",output==="full-launch.mjs"?"--platform=node":"--platform=neutral","--format=esm","--target=es2024","--external:cloudflare:workers","--external:node:*",
    "--outfile="+join(input.output,output!)],
   environment:input.environment,cwd:input.sourceRoot,outputDirectory:input.rawOutputDirectory,
   name:"bundle-"+output!.replace(/[^A-Za-z0-9_-]/g,"-"),seconds:90,signal:input.signal});
  files[output!]=sha(await readFile(join(input.output,output!)));
  await chmod(join(input.output,output!),0o444);
 }
 for(const name of ["full-gateway.worker.mjs","egress-policy.worker.mjs","deny.worker.mjs","assets.worker.mjs"]){
  const body=await readFile(join(input.sourceRoot,"deploy/linux",name));await write(name,body);sourceHashes["deploy/linux/"+name]=sha(body);
 }
 const sourceInputs=new Map<string,string>();
 for(const row of input.backendModules){
  assert(row.output.startsWith("source/"),"backend_must_retain_installed_relative_source_layout");
  const body=await readFile(row.source);assert.equal(sha(body),row.sha256);await write(row.output,body);
  if(row.output==="source/backend.ts")await chmod(join(input.output,row.output),0o400);
  const relative=row.output.slice(7);
  if(!relative.split("/").includes("node_modules")){
   if(Object.hasOwn(sourceHashes,relative))assert.equal(sourceHashes[relative],row.sha256,"selected_source_collision");
   sourceHashes[relative]=row.sha256;sourceInputs.set(relative,row.source);
  }
 }
 for(const row of input.licenses){const body=await readFile(row.path);assert.equal(sha(body),row.sha256);await write(row.output,body);}
 const node=await readFile(input.node);assert.equal(sha(node),input.nodeSha256);
 await write("toolchain/node",node);await chmod(join(input.output,"toolchain/node"),0o555);
 for(const row of input.toolchainModules){
  assert(row.output.startsWith("toolchain/node_modules/"),"pinned_loader_closure_layout_required");
  const body=await readFile(row.source);assert.equal(sha(body),row.sha256);await write(row.output,body);
  if(row.executable)await chmod(join(input.output,row.output),0o555);
 }
 for(const row of input.wizardFiles){
  const body=await readFile(row.source);assert.equal(sha(body),row.sha256);await write("wizard/"+row.path,body);
 }
 const assets:Record<string,unknown>={},mime:Record<string,string>={".html":"text/html; charset=utf-8",".css":"text/css",".js":"text/javascript",".json":"application/json",".svg":"image/svg+xml",".mp3":"audio/mpeg",".png":"image/png",".webp":"image/webp",".woff2":"font/woff2"};
 for(const [name,expected] of Object.entries(owning.assets)){
  const body=await readFile(join(input.sourceRoot,input.assetDirectory,name));assert.equal("0x"+sha(body),expected);
  await write("assets/"+name,body);assets[name]={sha256:sha(body),contentType:mime[extname(name)]??"application/octet-stream"};
 }
 await write("asset-index.json",Buffer.from(JSON.stringify(assets)));
 assert.deepEqual(input.migrationPlan.map(x=>x.name),owning.migrations);
 for(const row of input.migrationPlan){const source=await readFile(join(input.sourceRoot,"apps/community-wizard/infra/migrations",row.name));
  assert(sha(source)===row.sha256 && source.toString("utf8")===row.sql && row.statements.join("")===row.sql);await write("sql/"+row.name,source);}
 const nativeIdentity=sha(Buffer.from(JSON.stringify({sourceHashes,files,migrations:input.migrationPlan.map(({name,sha256})=>({name,sha256}))})));
 // The unchanged component bootstrap's qualification flag stays component-only;
 // no full-profile readiness is inferred from migration/object initialization.
 await write("migration-plan.json",Buffer.from(JSON.stringify({schema:"pirate.linux-migration-plan/1",qualificationOnly:true,releaseSha256:nativeIdentity,migrations:input.migrationPlan})));
 const native=await readFile(input.native.path),schema=await readFile(input.schema.path);
 assert(sha(native)===input.native.sha256 && sha(schema)===input.schema.sha256);
 await write("workerd",native);await chmod(join(input.output,"workerd"),0o555);await write("workerd.capnp",schema);
 for(const [relative,digest] of Object.entries(sourceHashes)){
  const body=await readFile(sourceInputs.get(relative)??join(input.sourceRoot,relative));
  assert.equal(sha(body),digest.replace(/^0x/,""));
  const output="source/"+relative;
  if(Object.hasOwn(files,output))assert.equal(files[output],sha(body));else await write(output,body);
 }
 for(const name of ["source/backend.ts","source/package.json","source/deploy/linux/local-install-main.ts",
  "source/deploy/linux/local-target-services.ts","source/deploy/linux/shared-v2-result-producer.ts",
  "toolchain/node_modules/tsx/dist/loader.mjs","toolchain/node_modules/tsx/package.json","wizard/index.html"])
  assert(Object.hasOwn(files,name),"installed_backend_loader_or_asset_closure_missing: "+name);
 async function seal(path:string){for(const row of await readdir(path,{withFileTypes:true})){
  const child=join(path,row.name);assert(!row.isSymbolicLink());
  if(row.isDirectory())await seal(child);else assert(row.isFile() && !((await lstat(child)).mode&0o222));
 }await chmod(path,0o555);}
 await seal(input.output);
 return {owning,files,sourceHashes,nativeIdentity,output:input.output,dockerExecuted:false,
  execution:{node:"toolchain/node" as const,nodeSha256:input.nodeSha256,nodeVersion:"v24.18.1" as const,
   loader:"toolchain/node_modules/tsx/dist/loader.mjs" as const,tsxVersion:"4.20.6" as const,backend:"source/backend.ts" as const},
  remainingExecutionInputs:["actual post-build signed release/image identity and exact installed path/resource mapping","genuine current signed create template/profile and managed key channels","actual one-host create/publication/restart qualification"]};
}

