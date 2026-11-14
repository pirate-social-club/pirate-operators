// Protocol-only loopback transport over the exact accepted Directory fixture.
// It exercises the REAL reader/signature/filesystem path, not a native backend
// or HNS/chain/host acceptance. No ready row or no-op shared reader is supplied.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {writeFile} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {sharedDirectoryFixture} from "./fixtures/shared-directory.ts";
import {fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
import {createSharedRuntimeReader,DIRECTORY_SOURCE_PINS} from "../deploy/linux/shared-runtime-readback.ts";
import {signRecord,canonicalDigest,type TrustAnchor} from "../deploy/linux/installed-records.ts";
import {hash,type OperationLease} from "../deploy/linux/backend-state.ts";
import {namespaceDigest} from "../packages/community-names/namespace-registry-adapter.ts";
import {sharedProfileDocument} from "../packages/community/shared-directory.ts";
import {validateSharedConfig} from "../packages/community/shared-config-manifest.ts";
import {linuxProfileFrom} from "../packages/community-setup/shared-linux-profile.ts";
export async function sharedAuthorityProtocolReader(input:{root:string;installationId:string;trust:TrustAnchor;privateKey:Uint8Array;lease:OperationLease}){
 const f=await sharedDirectoryFixture();
 const requests:Array<{method:string;path:string;sha256:string;bytes:number}>=[];
 let corrupt=false;
 const server=createServer((req,res)=>{void(async()=>{
  if(req.url?.startsWith("/ipfs/")){
   const response=await f.transport(new Request("https://ipfs.filebase.io"+req.url));
   const exact=Buffer.from(await response.arrayBuffer());
   requests.push({method:req.method!,path:req.url!,sha256:hash(exact),bytes:exact.length});
   const sent=Buffer.from(exact);
   if(corrupt && sent.length)sent[0]=sent[0]!^1;
   res.writeHead(response.status,{"Content-Type":"application/json"});res.end(sent);return;
  }
  assert(req.method==="POST" && req.url==="/rpc");let body="";for await(const part of req){body+=part;assert(body.length<=1048576);}
  const rpc=JSON.parse(body);
  try{const result=await f.client.request({method:rpc.method,params:rpc.params} as never);
   res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
  }catch{res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,error:{code:-32603,message:"controlled_protocol_rpc_refusal"}}));}
 })().catch(()=>res.destroy());});
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
 const address=server.address();assert(address && typeof address!=="string");const origin="http://127.0.0.1:"+address.port;
 const p=fixtureProfile();p.settings.origin=f.profile.hostingOrigin;p.identity.communityId=f.profile.communityId;
 const source={...p.infrastructure.registrySource,chainId:31337 as const,registry:f.profile.registry,runtimeCodeHash:f.profile.registryCodeHash};
 const sourceSha256=hash(JSON.stringify(source));
 const binding={...p.infrastructure.binding,installationId:f.profile.installationId,communityId:f.profile.communityId,
  hostingOrigin:f.profile.hostingOrigin,namespaceId:f.profile.namespaceId,sourceSha256,deploymentIdentityDigest:namespaceDigest(p.identity)};
 assert(f.config.schema==="pirate.community-config/2","protocol_fixture_schema_changed");
 const configuration=validateSharedConfig(f.config,f.profile);
 assert.deepEqual(configuration,f.config,"protocol_fixture_configuration_changed");
 p.infrastructure={...p.infrastructure,directory:sharedProfileDocument(f.profile),configuration,registrySource:source,sourceSha256,binding,
  mapping:{...p.infrastructure.mapping,linuxInstallationId:input.installationId,directoryInstallationId:f.profile.installationId,
   communityKey:f.profile.communityKey,communityId:f.profile.communityId,deploymentIdentityDigest:binding.deploymentIdentityDigest}};
 p.namespace={...p.namespace,binding};
 const runtimeDocument=JSON.stringify({schema:"pirate.community-deployment/1",origin:p.settings.origin,name:"Protocol fixture",planId:"1".repeat(64),
  postingPeriod:"fixture-period",rpcUrl:origin+"/rpc",ipfsGateways:[origin],managedOrigin:"https://managed.example",creatorOrigin:"https://creator.example",
  directoryProfile:p.infrastructure.directory,posts:{address:f.config.postsContract,runtimeCodeHash:f.profile.registryCodeHash,deploymentBlock:"1"}});
 const ledger=signRecord({originalLinuxInstallationId:input.installationId,directoryInstallationId:f.profile.installationId,
  directoryCommunityId:p.identity.communityId,hostingOrigin:p.settings.origin,runtimeDocumentSha256:hash(runtimeDocument),
  acceptedReaderSourceSha256:DIRECTORY_SOURCE_PINS["packages/community/directory-reader.ts"]!,
  readerSourceRelativePath:"packages/community/directory-reader.ts",mappingRecordId:p.infrastructure.mapping.mappingId,
  originalNonce:"0001-raw-original-Case"},input.trust,input.privateKey);
 const bytes=Buffer.from(JSON.stringify(ledger)+"\n"),bindingFile=join(input.root,"configuration","mapping.json");
 await writeFile(bindingFile,bytes,{mode:0o600,flag:"wx"});
 p.infrastructure.mapping.evidence={relativePath:"mapping.json",sha256:hash(bytes)};
 const profile=linuxProfileFrom(p);const sourceRoot=dirname(dirname(fileURLToPath(import.meta.url)));
 const shared=await createSharedRuntimeReader({installationId:input.installationId,runtimeDocument,bindingFile,directoryTrust:input.trust,
  sourceRoot,sourceHashes:{...DIRECTORY_SOURCE_PINS},lease:input.lease});
 return {profile,shared,sourceRoot,requests,expectedRecords:f.records.map(r=>({path:"/ipfs/"+r.pin.uri.slice(7),sha256:hash(r.bytes),bytes:r.bytes.length})),
  corruptContent(){corrupt=true;},async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
