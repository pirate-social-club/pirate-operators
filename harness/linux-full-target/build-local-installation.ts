#!/usr/bin/env node
/** Concrete candidate -> complete artifacts. No Docker, signer, provider or
 * installation mutation. Root supplies a real bounded observer interval. */
import assert from "node:assert/strict";
import {readFile,readdir,realpath,lstat,mkdir,readlink,writeFile} from "node:fs/promises";
import {join,dirname,relative,resolve,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {isBuiltin} from "node:module";
import {parseArgs} from "node:util";
import {performance} from "node:perf_hooks";
import {build,stop} from "esbuild";
import {acquireOperation,privateDirectory,hash,type OperationLease} from "../../deploy/linux/backend-state.ts";
import {runOwnedCommand} from "../../deploy/linux/backend-command.ts";
import {communityMigrations} from "../package-migrations.ts";
import {object} from "../../packages/community/common.ts";
import {buildCompleteLinuxArtifacts} from "./build-complete-artifacts.ts";

export interface CandidateBuildOptions {
 sourceRoot:string;head:string;tree:string;outputDirectory:string;installationId:string;operationId:string;
 hostPidNamespace:string;backend:string;assets:string;wizardDist:string;
 workerd:string;workerdSha256:string;schema:string;schemaSha256:string;
 migrationsFile:string;actorsFile:string;seconds:number;
}
type Copied={source:string;output:string;sha256:string};
const inside=(root:string,path:string)=>{
 const rel=relative(root,path);
 assert(rel && !isAbsolute(rel) && rel!==".." && !rel.startsWith("../"),"input_outside_pinned_candidate: "+path);return rel;
};
async function bytes(path:string){
 const canonical=await realpath(path),a=await lstat(canonical);
 assert(a.isFile() && !a.isSymbolicLink(),"regular_build_input_required: "+path);
 const body=await readFile(canonical),b=await lstat(canonical);
 assert(a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs &&
   body.length===a.size,"build_input_changed: "+path);
 return {source:canonical,sha256:hash(body),body};
}
async function manifestTree(root:string,prefix:string,signal:AbortSignal):Promise<Copied[]>{
 const out:Copied[]=[];
 async function walk(path:string,output:string,ancestors:Set<string>){
  signal.throwIfAborted();const canonical=await realpath(path),info=await lstat(canonical);
  if(info.isDirectory()){
   assert(!ancestors.has(canonical),"dependency_symlink_cycle: "+path);
   const next=new Set(ancestors);next.add(canonical);
   for(const row of (await readdir(canonical,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    // Package dependencies are collected by their actual package.json edges.
    if(row.name==="node_modules" || row.name===".bin" || row.name===".cache" || row.name===".mf")continue;
    await walk(join(canonical,row.name),output+"/"+row.name,next);
   }
  }else{assert(info.isFile(),"non_regular_package_input: "+path);const row=await bytes(canonical);out.push({source:row.source,output,sha256:row.sha256});}
 }
 await walk(root,prefix,new Set());return out;
}
/** Preserve the real installed dependency layout, including version-specific
 * nested packages. Copy bytes rather than symlinks; never install or resolve
 * against a different checkout/global package tree. */
async function packageClosure(seeds:Array<{name:string;from:string}>,root:string,prefix:string,signal:AbortSignal){
 const done=new Set<string>(),rows:Copied[]=[];
 async function find(name:string,from:string){
  assert(/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name),"invalid_package_dependency");
  for(let base=from;;base=dirname(base)){
   const p=join(base,"node_modules",name,"package.json");
   try{await lstat(p);inside(root,p);return dirname(p);}
   catch(error){if(!(error instanceof Error && "code" in error && error.code==="ENOENT"))throw error;}
   if(base===root || dirname(base)===base)break;
  }
  throw new Error("missing_installed_dependency_no_install: "+name+" from "+from);
 }
 async function visit(name:string,from:string,optional=false){
  signal.throwIfAborted();let pkg:string;
  try{pkg=await find(name,from);}catch(error){
   if(optional && error instanceof Error && error.message.startsWith("missing_installed_dependency_no_install:"))return;
   throw error;
  }
  if(done.has(pkg))return;done.add(pkg);
  const data=object(JSON.parse((await bytes(join(pkg,"package.json"))).body.toString("utf8")));
  assert(data.name===name,"installed_package_name_changed");
  // A missing platform-optional package is not manufactured; all present
  // selected files are copied, and actual installed-loader smoke remains a gate.
  rows.push(...await manifestTree(pkg,prefix+"/"+inside(root,pkg),signal));
  const optionalDeps=object(data.optionalDependencies??{}),deps=object(data.dependencies??{});
  for(const dep of Object.keys(deps).sort())await visit(dep,await realpath(pkg),Object.hasOwn(optionalDeps,dep));
  for(const dep of Object.keys(optionalDeps).sort())if(!Object.hasOwn(deps,dep))await visit(dep,await realpath(pkg),true);
 }
 for(const seed of seeds)await visit(seed.name,seed.from);
 return rows;
}
export async function buildLocalInstallationCandidate(o:CandidateBuildOptions){
 assert(process.version==="v24.18.1" && process.platform==="linux" && process.arch==="x64","pinned_linux_node_v24_18_1_required");
 assert(!process.env.ESBUILD_BINARY_PATH && !process.env.NODE_PATH,"ambient_build_dependency_override_refused");
 assert(/^[a-f0-9]{40}$/.test(o.head) && /^[a-f0-9]{40}$/.test(o.tree));
 assert(Number.isSafeInteger(o.seconds) && o.seconds>0 && o.seconds<=1200);
 const root=await realpath(o.sourceRoot);assert.equal(root,o.sourceRoot,"canonical_candidate_required");
 // Fail missing genuine inputs before creating a durable operation barrier.
 for(const [label,path] of [
  ["genuine reviewed backend.ts composition",o.backend],["actual built application index",resolve(root,o.assets,"index.html")],
  ["actual built Wizard index (run the owning Wizard build first)",join(o.wizardDist,"index.html")],
  ["explicit migration selection",o.migrationsFile],["selected actor manifest",o.actorsFile],
  ["selected workerd binary",o.workerd],["selected workerd schema",o.schema]
 ]){assert(label && path);try{await lstat(await realpath(path));}catch{throw new Error("missing_builder_prerequisite: "+label+" at "+path);}}
 assert(/^[a-f0-9]{64}$/.test(o.workerdSha256) && /^[a-f0-9]{64}$/.test(o.schemaSha256),"explicit_native_and_schema_pins_required");
 assert(isAbsolute(o.outputDirectory) && !o.outputDirectory.startsWith(root+"/") && o.outputDirectory!==root,"build_output_outside_candidate_required");
 await privateDirectory(dirname(o.outputDirectory));await mkdir(o.outputDirectory,{mode:0o700});
 const leaseDirectory=join(o.outputDirectory,"lease"),raw=join(o.outputDirectory,"raw"),compilerRaw=join(o.outputDirectory,"compiler-raw");
 for(const dir of [leaseDirectory,raw,compilerRaw,join(o.outputDirectory,"tmp"),join(o.outputDirectory,"node-cache")])await mkdir(dir,{mode:0o700});
 const lease:OperationLease=await acquireOperation(leaseDirectory,o.operationId,o.installationId,
   {kind:"complete-artifact-build",head:o.head,tree:o.tree,sourceRoot:root,outputDirectory:o.outputDirectory},
   o.hostPidNamespace);
 const abort=new AbortController(),cancel=()=>abort.abort(new Error("candidate_build_cancelled"));
 const deadline=performance.now()+o.seconds*1000;
 const timer=setTimeout(()=>abort.abort(new Error("candidate_build_deadline")),o.seconds*1000);
 process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
 const env={HOME:process.env.HOME,PATH:"/usr/bin:/bin",TZ:"UTC",LANG:"C.UTF-8",
   TMPDIR:join(o.outputDirectory,"tmp"),NODE_COMPILE_CACHE:join(o.outputDirectory,"node-cache")};
 let sequence=0;
 try{
  const git=await bytes("/usr/bin/git"),python=await bytes("/usr/bin/python3"),node=await bytes(process.execPath);
  const command=async(executable:string,digest:string,argv:string[],name:string)=>{
   abort.signal.throwIfAborted();
   return runOwnedCommand({lease,executable,executableSha256:digest,argv,environment:env,cwd:root,
     outputDirectory:raw,name:String(++sequence).padStart(3,"0")+"-"+name,seconds:60,signal:abort.signal});
  };
  const gitArgs=["--no-optional-locks","-c","core.fsmonitor=false","-c","safe.directory="+root,"-C",root];
  const pin=await command(git.source,git.sha256,[...gitArgs,"rev-parse","HEAD","HEAD^{tree}"],"candidate-pin");
  assert.equal(await readFile(pin.stdoutPath,"utf8"),o.head+"\n"+o.tree+"\n","candidate_commit_or_tree_changed");
  await command(git.source,git.sha256,[...gitArgs,"diff","--quiet","HEAD","--"],"candidate-clean");
  const listed=await command(git.source,git.sha256,[...gitArgs,"ls-files","--cached","-z"],"candidate-files");
  const tracked=(await readFile(listed.stdoutPath,"utf8")).split("\0").filter(Boolean);
  const authorPaths=tracked.filter(p=>p.startsWith("packages/") || p.startsWith("services/") || p.startsWith("harness/linux-full-target/") ||
   p.startsWith("deploy/linux/") || p.startsWith("apps/community-wizard/server/") ||
   /^(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(p));
  const backend=await bytes(o.backend);
  const backendModules:Copied[]=[];
  for(const p of authorPaths){const row=await bytes(join(root,p));backendModules.push({source:row.source,output:"source/"+p,sha256:row.sha256});}
  backendModules.push({source:backend.source,output:"source/backend.ts",sha256:backend.sha256});
  // The backend is observed as source only. esbuild discovers import edges;
  // emitted diagnostic bytes are NOT installed or used as compiled provenance.
  const graph=await build({stdin:{contents:backend.body.toString("utf8"),resolveDir:root,sourcefile:"backend.ts",loader:"ts"},
   bundle:true,write:false,platform:"node",format:"esm",target:"es2024",metafile:true,packages:"external",
   external:["node:*","cloudflare:*","miniflare:*"],logLevel:"silent"});
  assert(graph.metafile);
  const seeds:Array<{name:string;from:string}>=[];
  for(const [path,entry] of Object.entries(graph.metafile.inputs)){
   const virtual=path==="<stdin>" || path==="backend.ts",from=virtual?root:dirname(resolve(root,path));
   for(const dependency of entry.imports)if(dependency.external && !isBuiltin(dependency.path) &&
    !dependency.path.startsWith(".") && !dependency.path.startsWith("/") && !dependency.path.includes(":")){
     const parts=dependency.path.split("/"),name=parts[0]!.startsWith("@")?parts.slice(0,2).join("/"):parts[0]!;
     seeds.push({name,from});
   }
   if(!virtual){
    const p=inside(root,resolve(root,path));
    if(!authorPaths.includes(p)){const row=await bytes(join(root,p));backendModules.push({source:row.source,output:"source/"+p,sha256:row.sha256});}
   }
  }
  backendModules.push(...await packageClosure(seeds,root,"source",abort.signal));
  const wizardRoot=join(root,"apps/community-wizard"),tsx=object(JSON.parse((await bytes(join(wizardRoot,"node_modules/tsx/package.json"))).body.toString()));
  assert(tsx.version==="4.20.6","pinned_tsx4_20_6_required_no_install");
  const toolchainModules=(await packageClosure([{name:"tsx",from:wizardRoot}],wizardRoot,"toolchain",abort.signal))
   .map(row=>({...row,executable:row.output.endsWith("/bin/esbuild")}));
  const wizardFiles=(await manifestTree(await realpath(o.wizardDist),"wizard",abort.signal)).map(row=>({source:row.source,path:row.output.slice(7),sha256:row.sha256}));
  assert(wizardFiles.some(row=>row.path==="index.html"),"build_actual_wizard_dist_before_artifact_assembly");
  const assets=await realpath(resolve(root,o.assets));inside(root,assets);await lstat(join(assets,"index.html"));
  const rawSelection=object(JSON.parse((await bytes(o.migrationsFile)).body.toString("utf8")));
  const keys=["rewards","ownerPublishing","v4","rewardClosure","media","dance"];
  assert.deepEqual(Object.keys(rawSelection).sort(),[...keys].sort(),"explicit_migration_selection_required");
  const flag=(name:string)=>{const value=rawSelection[name];assert(typeof value==="boolean","migration_selection_boolean_required: "+name);return value;};
  const migrations={rewards:flag("rewards"),ownerPublishing:flag("ownerPublishing"),v4:flag("v4"),
   rewardClosure:flag("rewardClosure"),media:flag("media"),dance:flag("dance")};
  const migrationRoot=join(root,"apps/community-wizard/infra/migrations"),names=communityMigrations(await readdir(migrationRoot),migrations);
  const sql=await command(python.source,python.sha256,["-B",join(root,"deploy/linux/split-migrations.py"),migrationRoot,JSON.stringify(names)],"split-migrations");
  const migrationPlan:Parameters<typeof buildCompleteLinuxArtifacts>[0]["migrationPlan"]=JSON.parse(await readFile(sql.stdoutPath,"utf8"));
  assert.deepEqual(migrationPlan.map(row=>row.name),names);
  const actorValue:unknown=JSON.parse((await bytes(o.actorsFile)).body.toString("utf8"));assert(Array.isArray(actorValue),"actual_selected_actor_manifest_required");
  const actorOutputs=new Set<string>(),reserved=new Set(["application.mjs","queue.mjs","maintenance.mjs","full-launch.mjs",
   "full-startup.worker.mjs","cold-reconcile.worker.mjs","selected-handler-observer.worker.mjs","maintenance.bootstrap.mjs",
   "full-gateway.worker.mjs","egress-policy.worker.mjs","deny.worker.mjs","assets.worker.mjs",
   "database.worker.js","bucket.worker.js","object-entry.worker.js","shared.worker.js","zod.worker.js"]);
  const actorModules=actorValue.map(value=>{const row=object(value);assert.deepEqual(Object.keys(row).sort(),["output","source"]);
   assert(typeof row.source==="string" && tracked.includes(row.source) && /\.(ts|js|mjs)$/.test(row.source) && typeof row.output==="string" && /^[A-Za-z0-9_.-]+$/.test(row.output),"selected_actor_source_required");
   assert(!reserved.has(row.output) && !actorOutputs.has(row.output),"actor_cannot_replace_owning_handler_or_native_module");actorOutputs.add(row.output);
   return {source:row.source,output:row.output};});
  const pins=object(JSON.parse((await bytes(join(root,"deploy/linux/backend-pins.json"))).body.toString("utf8")));
  const miniflare=join(root,"node_modules/miniflare"),mf=object(JSON.parse((await bytes(join(miniflare,"package.json"))).body.toString()));
  assert(mf.version===pins.miniflareVersion,"selected_miniflare_version_changed");
  const nativeModules:Copied[]=[];
  for(const [output,value] of Object.entries(object(pins.modules))){const pin=object(value);assert(typeof pin.path==="string" && typeof pin.sha256==="string");
   const row=await bytes(join(miniflare,"dist/src/workers",pin.path));assert.equal(row.sha256,pin.sha256,"pinned_native_module_changed: "+output);
   nativeModules.push({source:row.source,output,sha256:row.sha256});}
  const native=await bytes(o.workerd),schema=await bytes(o.schema);
  assert.equal(native.sha256,o.workerdSha256,"selected_workerd_bytes_changed");assert.equal(schema.sha256,o.schemaSha256,"selected_workerd_schema_changed");
  const esbuildPackage=object(JSON.parse((await bytes(join(root,"node_modules/esbuild/package.json"))).body.toString()));
  assert(esbuildPackage.version==="0.28.2","selected_root_bundler_version_changed");
  const esbuildCLI=await bytes(join(root,"node_modules/esbuild/bin/esbuild")),esbuildNative=await bytes(join(root,"node_modules/@esbuild/linux-x64/bin/esbuild"));
  const licenses=[];
  for(const [name,key] of [["UPSTREAM-LICENSE-MIT","backendLicenseSha256"],["WORKERD-LICENSE","workerdLicenseSha256"]]){
   assert(name && key);const row=await bytes(join(root,"deploy/linux",name));assert.equal(row.sha256,pins[key]);
   licenses.push({path:row.source,output:"licenses/"+name,sha256:row.sha256});
  }
  const unique=(rows:Copied[])=>{const map=new Map<string,Copied>();for(const row of rows){const old=map.get(row.output);assert(!old || old.sha256===row.sha256,"selected_output_collision");map.set(row.output,row);}return [...map.values()].sort((a,b)=>a.output.localeCompare(b.output));};
  const selectedBackend=unique(backendModules),selectedToolchain=unique(toolchainModules);
  const inventory={sourceHead:o.head,sourceTree:o.tree,backendModules:selectedBackend,toolchainModules:selectedToolchain,
   wizardFiles,nativeModules,node:{path:node.source,sha256:node.sha256},native:{path:native.source,sha256:native.sha256},schema:{path:schema.source,sha256:schema.sha256},
   migrations:migrationPlan.map(({name,sha256})=>({name,sha256})),actorModules,licenses};
  const inventoryBytes=Buffer.from(JSON.stringify(inventory)+"\n"),inventorySha256=hash(inventoryBytes);
  await writeFile(join(o.outputDirectory,"build-inputs.json"),inventoryBytes,{flag:"wx",mode:0o600});
  await lease.record("inputs-pinned",{inventorySha256,inventoryPath:join(o.outputDirectory,"build-inputs.json")});
  await lease.assertHeld();abort.signal.throwIfAborted();
  const built=await buildCompleteLinuxArtifacts({sourceRoot:root,assetDirectory:inside(root,assets),output:join(o.outputDirectory,"release"),rawOutputDirectory:compilerRaw,lease,
   migrations,node:node.source,nodeSha256:node.sha256,esbuildCLI:esbuildCLI.source,esbuildCLISha256:esbuildCLI.sha256,
   esbuildNative:esbuildNative.source,esbuildNativeSha256:esbuildNative.sha256,signal:abort.signal,environment:env,
   backendModules:selectedBackend,toolchainModules:selectedToolchain.map(row=>({...row,executable:row.output.endsWith("/bin/esbuild")})),wizardFiles,
   actorModules,migrationPlan,native:{path:native.source,sha256:native.sha256},schema:{path:schema.source,sha256:schema.sha256},
   nativeModules:nativeModules.map(row=>({path:row.source,output:row.output,sha256:row.sha256})),licenses});
  await lease.assertHeld();abort.signal.throwIfAborted();
  await lease.record("artifacts-built",{inventorySha256,output:built.output,dockerExecuted:false,qualification:"UNRUN"});
  abort.signal.throwIfAborted();assert(performance.now()<deadline,"candidate_build_deadline");
  await writeFile(join(o.outputDirectory,"built-artifacts.json"),JSON.stringify({files:built.files,sourceHashes:built.sourceHashes,execution:built.execution,output:built.output,inventorySha256,dockerExecuted:false,qualification:"UNRUN"})+"\n",{flag:"wx",mode:0o600});
  abort.signal.throwIfAborted();assert(performance.now()<deadline,"candidate_build_deadline");
  return {output:built.output,inventorySha256,leaseDirectory,leaseRetained:true,qualification:"UNRUN" as const};
 }catch(error){await lease.record("build-failed-custody-retained",{error:error instanceof Error?error.message:"unknown"});throw error;}
 finally{clearTimeout(timer);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);stop();}
}
if(process.argv[1] && await realpath(process.argv[1])===fileURLToPath(import.meta.url)){
 const names=["source-root","head","tree","output-directory","installation-id","operation-id","host-pid-namespace",
  "backend","assets","wizard-dist","workerd","workerd-sha256","schema","schema-sha256","migrations-file","actors-file","seconds"];
 const options=Object.fromEntries(names.map(name=>[name,{type:"string" as const}]));
 const {values}=parseArgs({options,strict:true,allowPositionals:false});
 const get=(name:string)=>{const value=values[name];assert(typeof value==="string" && value.length,"required_build_argument: --"+name);return value;};
 try{const result=await buildLocalInstallationCandidate({sourceRoot:get("source-root"),head:get("head"),tree:get("tree"),outputDirectory:get("output-directory"),
  installationId:get("installation-id"),operationId:get("operation-id"),hostPidNamespace:get("host-pid-namespace"),backend:get("backend"),assets:get("assets"),
  wizardDist:get("wizard-dist"),workerd:get("workerd"),workerdSha256:get("workerd-sha256"),schema:get("schema"),schemaSha256:get("schema-sha256"),
  migrationsFile:get("migrations-file"),actorsFile:get("actors-file"),seconds:Number(get("seconds"))});
  process.stdout.write(JSON.stringify(result)+"\n");
 }catch(error){process.exitCode=1;process.stderr.write((error instanceof Error?error.message:"candidate_build_failed")+"; original operation retained\n");}
}
