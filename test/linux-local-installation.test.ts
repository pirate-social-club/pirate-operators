// UNRUN. Real filesystem/signatures; inert release bytes are inventory fixtures,
// never executed or counted as an actual built-image/application acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,createHash} from "node:crypto";
import {mkdtemp,mkdir,writeFile,readFile,chmod,readdir,rm,symlink,unlink} from "node:fs/promises";
import {join,dirname} from "node:path";
import {canonicalDigest,signRecord} from "../deploy/linux/installed-records.ts";
import {verifyInstalledRelease,installedExecutionPaths,type FullRelease} from "../deploy/linux/installed-release.ts";
import {assertCreateRuntimeSelection,createBootDirectory} from "../deploy/linux/local-installation.ts";
import {linuxCreateRuntimeProfileFrom} from "../deploy/linux/create-runtime-profile.ts";

const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const selection=(root:string)=>({schema:"pirate.linux-create-runtime/1",installationId:"fixture-installation",
  backendConfigurationFile:join(root,"source/backend.ts"),wizardDirectory:"/var/lib/fixture/wizard",
  pairingNonceDirectory:"/var/lib/fixture/pairing",frontPort:9811,innerPort:9812});
async function modes(root:string,mode:number){
  await chmod(root,mode);
  for(const row of await readdir(root,{withFileTypes:true}))if(row.isDirectory())await modes(join(root,row.name),mode);
}
async function releaseFixture(){
  const temporary=process.env.TMPDIR;assert(temporary,"Root supplies private non-checkout TMPDIR");
  const root=await mkdtemp(join(temporary,"installed-inventory-")),files:Record<string,string>={},sourceHashes:Record<string,string>={};
  const put=async(path:string,body:string,mode=0o444)=>{
    await mkdir(dirname(join(root,path)),{recursive:true,mode:0o700});
    await writeFile(join(root,path),body,{flag:"wx",mode});files[path]=sha(body);
  };
  for(const path of ["application.mjs","queue.mjs","maintenance.mjs","database.worker.js","bucket.worker.js",
    "object-entry.worker.js","shared.worker.js","zod.worker.js","assets.worker.mjs","asset-index.json","egress-policy.worker.mjs",
    "deny.worker.mjs","full-gateway.worker.mjs","full-startup.worker.mjs","selected-handler-observer.worker.mjs",
    "maintenance.bootstrap.mjs","cold-reconcile.worker.mjs","full-launch.mjs","workerd.capnp","workerd","migration-plan.json","wizard/index.html"])
    await put(path,"INERT INVENTORY FIXTURE: "+path+"\n");
  for(const path of ["backend.ts","deploy/linux/local-install-main.ts","deploy/linux/local-installation.ts",
    "deploy/linux/local-target-services.ts","deploy/linux/shared-v2-result-producer.ts",
    "services/community-application.ts","services/linux-community.ts"]){
    const body="// INERT AUTHORED INVENTORY FIXTURE: "+path+"\n";
    await put("source/"+path,body,path==="backend.ts"?0o400:0o444);sourceHashes[path]=sha(body);
  }
  const sourcePackage='{"type":"module"}\n';await put("source/package.json",sourcePackage);sourceHashes["package.json"]=sha(sourcePackage);
  await put("toolchain/node","INERT NODE INVENTORY FIXTURE\n",0o555);
  await put("toolchain/node_modules/tsx/package.json",'{"name":"tsx","version":"4.20.6"}\n');
  await put("toolchain/node_modules/tsx/dist/loader.mjs","// INERT LOADER INVENTORY FIXTURE\n");
  const scope="a".repeat(64),release:FullRelease={schema:"pirate.complete-linux-release/1",sourceHead:"1".repeat(40),sourceTree:"2".repeat(40),
    root,sourceRoot:join(root,"source"),files,sourceHashes,requiredRoles:["application","database","objects","jobs","scheduler","assets"],
    execution:{node:"toolchain/node",nodeSha256:files["toolchain/node"]!,nodeVersion:"v24.18.1",
      loader:"toolchain/node_modules/tsx/dist/loader.mjs",tsxVersion:"4.20.6",backend:"source/backend.ts"},
    artifactDigest:"0x"+canonicalDigest(files),sourceDigest:"0x"+canonicalDigest(sourceHashes),imageId:"sha256:"+"3".repeat(64),
    graph:{installationId:"fixture-installation",durableScope:scope,releaseRoot:root,schemaPath:join(root,"workerd.capnp"),
      stateRoots:Object.fromEntries(["database","objects","jobs","scheduler","configuration","readiness"].map(k=>[k,"/var/lib/fixture/"+k])),
      socket:"/run/fixture/control.sock",applicationBindings:[],actors:[],requiredRoles:["application","database","objects","jobs","scheduler","assets"],
      queueConfiguration:{scope},maintenanceConfiguration:{scope},directoryRuntimeBinding:'{"fixture":"not authority"}',allowedOrigins:[],
      secretBindings:[],listenAddress:"127.0.0.1:9999",tls:{keyFile:"/run/fixture/tls.key",certificateFile:"/run/fixture/tls.crt"},
      migrationPlanFile:join(root,"migration-plan.json"),probePlanFile:"/run/fixture/probe.json",readbackKeyFile:"/run/fixture/readback.key"}};
  const keys=generateKeyPairSync("ed25519"),trust={keyId:"public-test-issuer",spki:keys.publicKey.export({format:"der",type:"spki"}).toString("base64")},
    key=keys.privateKey.export({format:"der",type:"pkcs8"});
  const record=signRecord(release,trust,key);key.fill(0);await modes(root,0o555);
  return {root,release,record,trust,async close(){await modes(root,0o700);await rm(root,{recursive:true});}};
}
test("unsigned create selection is closed and cannot carry a signed profile or deferred restore fields",()=>{
  const input=selection("/opt/fixture");assert.deepEqual(linuxCreateRuntimeProfileFrom(input),input);
  for(const extra of [{profile:{schema:"pirate.community-linux-profile/3"}},{backup:{}},{trust:{}},{mode:"restore"}])
    assert.throws(()=>linuxCreateRuntimeProfileFrom({...input,...extra}));
});
test("create selection refuses ambiguous ports and relative or traversing configuration paths",()=>{
  for(const change of [{frontPort:0},{frontPort:9812},{innerPort:65536},{backendConfigurationFile:"backend.ts"},
    {backendConfigurationFile:"/opt/fixture/../backend.ts"}])assert.throws(()=>linuxCreateRuntimeProfileFrom({...selection("/opt/fixture"),...change}));
});
test("the signed installed inventory verifies without conferring profile or provider readiness",async()=>{
  const f=await releaseFixture();try{assert.deepEqual(await verifyInstalledRelease(f.record,f.trust),f.release);}
  finally{await f.close();}
});
test("unsigned selection cannot replace installation, backend, source root or immutable release state",async()=>{
  const f=await releaseFixture();try{
    const runtime=linuxCreateRuntimeProfileFrom(selection(f.root));assertCreateRuntimeSelection(f.release,runtime);
    for(const change of [{installationId:"different"},{backendConfigurationFile:"/opt/other/backend.ts"},{wizardDirectory:join(f.root,"wizard-state")}])
      assert.throws(()=>assertCreateRuntimeSelection(f.release,{...runtime,...change}));
    assert.throws(()=>installedExecutionPaths({...f.release,sourceRoot:"/checkout"}));
    assert.throws(()=>installedExecutionPaths({...f.release,execution:{...f.release.execution,nodeSha256:"f".repeat(64)}}));
  }finally{await f.close();}
});
test("loader byte mutation fails the signed manifest instead of resolving ambient tsx",async()=>{
  const f=await releaseFixture();try{
    const path=join(f.root,f.release.execution.loader);await chmod(path,0o600);await writeFile(path,"// changed\n");await chmod(path,0o444);
    await assert.rejects(verifyInstalledRelease(f.record,f.trust),/complete_release_bytes_changed/);
  }finally{await f.close();}
});
test("an unlisted runtime dependency refuses the entire installed pathset",async()=>{
  const f=await releaseFixture();try{
    await chmod(f.root,0o700);await writeFile(join(f.root,"unlisted.js"),"inert\n",{mode:0o444});await chmod(f.root,0o555);
    await assert.rejects(verifyInstalledRelease(f.record,f.trust),/complete_release_pathset_changed/);
  }finally{await f.close();}
});
test("installed backend symlinks cannot reconnect execution to a checkout",async()=>{
  const f=await releaseFixture();try{
    const directory=join(f.root,"source"),path=join(directory,"backend.ts");await chmod(directory,0o700);
    await unlink(path);await symlink("/outside/checkout/backend.ts",path);await chmod(directory,0o555);
    await assert.rejects(verifyInstalledRelease(f.record,f.trust));
  }finally{await f.close();}
});
test("ordinary boot allocates new scratch and preserves installation bytes, pending journal and earlier boot evidence",async()=>{
  const parent=process.env.PIRATE_TEST_RUN_PARENT;assert(parent?.startsWith("/run/"),"Root supplies owned private /run parent");
  const root=await mkdtemp(join(parent,"installer-test-"));
  try{
    const identity='{"installationId":"opaque-original","pendingOperation":"unchanged-nonce"}\n';
    await writeFile(join(root,"retained.json"),identity,{mode:0o600});
    const first=await createBootDirectory(root);await writeFile(join(first,"native-process.json"),"retained boot evidence\n",{mode:0o600});
    const second=await createBootDirectory(root);assert.notEqual(first,second);assert.deepEqual(await readdir(second),[]);
    assert.equal(await readFile(join(root,"retained.json"),"utf8"),identity);
    assert.equal(await readFile(join(first,"native-process.json"),"utf8"),"retained boot evidence\n");
  }finally{await rm(root,{recursive:true});}
});
test("scratch refuses a persistent path rather than deleting or repairing it",async()=>{
  await assert.rejects(createBootDirectory("/var/lib/fixture"),/private_run_parent_required/);
});
