import assert from "node:assert/strict";
import {readFile,realpath,lstat,open,mkdir} from "node:fs/promises";
import {join,dirname} from "node:path";
import {constants} from "node:fs";
import {createPublicClient,http,keccak256,type PublicClient} from "viem";
import {readConfiguration} from "../../packages/community/directory-reader.ts";
import {parseSharedProfileDocument,sharedProfileDocument} from "../../packages/community/shared-directory.ts";
import {originalLinuxProfileFrom,type OriginalLinuxProfile} from "../../packages/community-setup/linux-create-profile.ts";
import {sameSharedInstallation} from "../../packages/community-setup/shared-linux-infrastructure.ts";
import {readCommunityDeploymentProfile,communityIpfsTransport} from "../../services/community-deployment-profile.ts";
import {hash,privateDirectory,privateFile,type OperationLease} from "./backend-state.ts";
import {canonicalDigest,verifyRecord,readPrivateJSON,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
export const DIRECTORY_SOURCE_PINS:Readonly<Record<string,string>>=Object.freeze({
  "packages/community/directory-reader.ts": "4fb3996ca460188347eacd64f68b5e9866e2331bfbf9835d92f8d11d8383fd3c",
  "packages/community/shared-directory.ts": "3c58c665227e69be9b5ea7575df22510801b0d0a5409172e98edd2448f8fc511",
  "packages/community/shared-config-manifest.ts": "aeb3a0abda2956a4515cab22db85f53bb7374ef537d881e876df783cd508305e"
});
export interface OriginalDirectoryBinding {
 originalLinuxInstallationId:string;directoryInstallationId:string;directoryCommunityId:string;hostingOrigin:string;
 runtimeDocumentSha256:string;acceptedReaderSourceSha256:string;readerSourceRelativePath:string;mappingRecordId:string;
}
export async function createSharedRuntimeReader(input:{
 installationId:string;runtimeDocument:string;bindingFile:string;directoryTrust:TrustAnchor;
 sourceRoot:string;sourceHashes:Record<string,string>;lease:OperationLease;
}) {
 const c={...input,sourceHashes:structuredClone(input.sourceHashes),directoryTrust:structuredClone(input.directoryTrust)};
 const deployment=readCommunityDeploymentProfile(c.runtimeDocument);
 assert("schema" in deployment.directoryProfile && deployment.directoryProfile.schema==="pirate.shared-directory/2",
  "native_shared_directory_runtime_required");
 const runtime=sharedProfileDocument(parseSharedProfileDocument(deployment.directoryProfile));
 const content=communityIpfsTransport(deployment);
 async function guard(){
  await c.lease.assertHeld();assert.equal(await realpath(c.sourceRoot),c.sourceRoot);
  for(const [path,digest] of Object.entries(DIRECTORY_SOURCE_PINS)){
   assert.equal(c.sourceHashes[path],digest,"selected_directory_source_not_in_release");
   assert.equal(hash(await readFile(join(c.sourceRoot,path))),digest,"selected_directory_reader_bytes_changed");
  }
 }
 async function binding(profile:OriginalLinuxProfile){
  await guard();assert.deepEqual(originalLinuxProfileFrom(profile),profile);
  const file=await readPrivateJSON<SignedRecord<OriginalDirectoryBinding>>(c.bindingFile);
  const original=verifyRecord(file,c.directoryTrust),mapping=profile.infrastructure.mapping;
  assert(original.originalLinuxInstallationId===c.installationId && mapping.linuxInstallationId===c.installationId &&
   original.directoryInstallationId===mapping.directoryInstallationId && original.directoryCommunityId===profile.identity.communityId &&
   original.hostingOrigin===profile.settings.origin && original.mappingRecordId===mapping.mappingId,
   "original_explicit_installation_mapping_changed");
  assert.equal(original.runtimeDocumentSha256,hash(c.runtimeDocument));
  assert(original.readerSourceRelativePath==="packages/community/directory-reader.ts" &&
   original.acceptedReaderSourceSha256===DIRECTORY_SOURCE_PINS[original.readerSourceRelativePath],
   "original_accepted_reader_source_changed");
  // Hash the actual signed ledger bytes. Do not synthesize an installation ID,
  // mapping receipt or Directory authorization from a saved hosting string.
  assert(c.bindingFile.endsWith("/"+mapping.evidence.relativePath),"original_mapping_evidence_path_changed");
  assert.equal(hash(await readFile(c.bindingFile)),mapping.evidence.sha256,"original_mapping_evidence_changed");
  assert.deepEqual(runtime,profile.infrastructure.directory,"installed_directory_runtime_profile_changed");
  assert(deployment.origin===profile.settings.origin && deployment.posts.address===profile.infrastructure.configuration.postsContract,
    "installed_application_origin_or_posts_binding_changed");
  assert(profile.infrastructure.binding.installationId===mapping.directoryInstallationId);
  await guard();return original;
 }
 async function read(profileValue:OriginalLinuxProfile,lease:OperationLease,signal:AbortSignal){
  const profile=structuredClone(profileValue);await binding(profile);await lease.assertHeld();
  const end=performance.now()+45000;let timedOut=false;
  const deadline=()=>{if(timedOut||signal.aborted||performance.now()>=end){timedOut=true;throw Error("shared_directory_readback_timeout");}};
  deadline();
  const readSignal=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
  const client=createPublicClient({transport:http(deployment.rpcUrl,{timeout:15000,retryCount:0,fetchOptions:{signal:readSignal}})}) as PublicClient;
  // The admitted core reader authenticates every history event/receipt/CID,
  // source code hash, shared binding, publisher/revocation transition and final
  // reorg fence. No lastRevision-1 or empty synthetic history is supplied.
  const head=await client.getBlockNumber({cacheTime:0});deadline();assert(head>0n);
  const block=await client.getBlock({blockNumber:head-1n});deadline();assert(block.hash);
  const postsCode=await client.getCode({address:deployment.posts.address,blockNumber:head-1n});deadline();
  assert(postsCode && keccak256(postsCode)===deployment.posts.runtimeCodeHash,"installed_posts_runtime_code_changed");
  const configuration=await readConfiguration(client,parseSharedProfileDocument(runtime),
   async request=>{deadline();const response=await content(new Request(request,{signal:AbortSignal.any([request.signal,signal,AbortSignal.timeout(Math.max(1,Math.floor(end-performance.now())))])}));deadline();return response;});
  deadline();
  const afterHead=await client.getBlockNumber({cacheTime:0});deadline();
  const after=await client.getBlock({blockNumber:head-1n});deadline();
  assert(afterHead===head && after.hash===block.hash,"shared_directory_checkpoint_changed_during_readback");
  assert.deepEqual(configuration,profile.infrastructure.configuration,"current_shared_configuration_changed");
  await binding(profile);deadline();await lease.assertHeld();
  assert.deepEqual(profileValue,profile,"shared_profile_changed_during_readback");
  const facts={installationId:c.installationId,profileDigest:canonicalDigest(profile),
   mapping:profile.infrastructure.mapping,binding:profile.infrastructure.binding,directory:runtime,configuration,
   blockNumber:String(head-1n),blockHash:block.hash,checkedAt:Date.now(),sourceHashes:DIRECTORY_SOURCE_PINS};
  deadline();const evidence=await lease.record("actual-shared-directory-readback",facts);deadline();
  return {directory:runtime,configuration,evidenceRef:evidence.relativePath,blockNumber:facts.blockNumber,blockHash:block.hash,
   checkedAt:facts.checkedAt,evidence};
 }

 async function retainOriginal(directory:string,profile:OriginalLinuxProfile,lease:OperationLease){
  await binding(profile);await lease.assertHeld();await privateDirectory(directory);
  const relativePath=profile.infrastructure.mapping.evidence.relativePath;
  assert(!["linux-profile.json","profile-authority.json","restore-fence.json"].includes(relativePath),"mapping_evidence_path_reserved");
  const parts=relativePath.split("/");let parent=directory;
  for(const part of parts.slice(0,-1)){
   const next=join(parent,part);
   try{await mkdir(next,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
   await privateDirectory(next);parent=next;
  }
  const parentInfo=await lstat(parent),parentHandle=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const source=await privateFile(c.bindingFile,1048576);let destination:Awaited<ReturnType<typeof open>>|undefined;
  try{
   const before=await source.stat({bigint:true}),bytes=await source.readFile(),after=await source.stat({bigint:true});
   assert(before.dev===after.dev && before.ino===after.ino && before.size===after.size &&
    before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs);
   assert.equal(hash(bytes),profile.infrastructure.mapping.evidence.sha256,"original_mapping_bytes_changed");
   const pinnedParent=await parentHandle.stat();assert(parentInfo.dev===pinnedParent.dev&&parentInfo.ino===pinnedParent.ino);
   const path=join(directory,relativePath);
   destination=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   const pinnedFile=await destination.stat();await destination.writeFile(bytes);await destination.sync();
   await parentHandle.sync();await lease.assertHeld();
   async function verifyDestination(){
    await privateDirectory(parent);
    const nowParent=await lstat(parent),nowFile=await lstat(path),held=await destination!.stat();
    assert(nowParent.dev===pinnedParent.dev && nowParent.ino===pinnedParent.ino && !nowParent.isSymbolicLink() &&
     nowParent.uid===pinnedParent.uid && (nowParent.mode&0o777)===(pinnedParent.mode&0o777) &&
     nowFile.dev===pinnedFile.dev && nowFile.ino===pinnedFile.ino && nowFile.nlink===1 && !nowFile.isSymbolicLink() &&
     nowFile.isFile() && nowFile.uid===pinnedFile.uid && (nowFile.mode&0o777)===0o600 &&
     held.dev===pinnedFile.dev && held.ino===pinnedFile.ino && held.nlink===1 &&
     held.uid===pinnedFile.uid && (held.mode&0o777)===0o600 &&
     held.size===bytes.length && nowFile.size===bytes.length && await realpath(parent)===parent,"original_mapping_destination_changed");
   }
   async function verifyDestinationBytes(){
    await verifyDestination();
    const before=await destination!.stat({bigint:true}),copy=Buffer.alloc(bytes.length);let offset=0;
    // Positional reads use the ORIGINAL O_RDWR|O_NOFOLLOW handle. readFile()
    // at the post-write cursor would incorrectly read EOF.
    while(offset<copy.length){
     const {bytesRead}=await destination!.read(copy,offset,copy.length-offset,offset);
     assert(bytesRead>0,"original_mapping_destination_bytes_changed");offset+=bytesRead;
    }
    const after=await destination!.stat({bigint:true});
    assert(before.dev===after.dev && before.ino===after.ino && before.size===after.size &&
     before.mtimeNs===after.mtimeNs && before.ctimeNs===after.ctimeNs &&
     hash(copy)===profile.infrastructure.mapping.evidence.sha256 && copy.equals(bytes),
     "original_mapping_destination_bytes_changed");
    await verifyDestination();
    const final=await destination!.stat({bigint:true});
    assert(after.dev===final.dev && after.ino===final.ino && after.size===final.size &&
     after.mtimeNs===final.mtimeNs && after.ctimeNs===final.ctimeNs,"original_mapping_destination_bytes_changed");
   }
   await verifyDestinationBytes();
   // Keep the ORIGINAL directory handle across the awaited audit write.
   // A rename plus same-name replacement cannot become completed evidence.
   const receipt=await lease.record("original-directory-ledger-retained",{relativePath,sha256:hash(bytes),bytes:bytes.length});
   await parentHandle.sync();await lease.assertHeld();await verifyDestinationBytes();
   // Raw signed ledger/nonce bytes remain exact; no key material is captured.
   return receipt;
  }finally{await destination?.close();await source.close();await parentHandle.close();}
 }
 return Object.freeze({binding,read,retainOriginal,async assertSameOriginal(a:OriginalLinuxProfile,b:OriginalLinuxProfile){
  assert(sameSharedInstallation(a.infrastructure,b.infrastructure),"original_shared_installation_changed");await binding(a);await binding(b);
 }});
}
