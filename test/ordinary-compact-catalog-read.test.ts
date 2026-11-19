import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { postsAbi, publicationData } from "../packages/community/post-chain.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import { validatePost } from "../packages/community/post-manifest.ts";
import { web2DirectoryFixture, h, a } from "./fixtures/web2-directory.ts";
import { signReservation } from "../packages/recognition/reservation-receipt.ts";
import { acceptedIntent,reservationId } from "../packages/recognition/intent.ts";
import { compactCanonicalRead,compactCanonicalWitnessSchema } from "../packages/recognition/compact-catalog-read.ts";
import { verifiedPublication } from "../packages/recognition/model.ts";
import { publicSongResource } from "../services/community-public.ts";
import { catalogSongPublicProof } from "../services/catalog-song-public-proof.ts";

async function sample() {
  const signer=privateKeyToAccount(h("7"));
  const profile={schema:"pirate.recognition-profile/1" as const,namespace:h("8"),
    origin:"https://recognition.example",signer:signer.address.toLowerCase(),providerBindingSha256:h("d")};
  const recognition={...profile,sha256:hashJson(profile)};
  const f=await web2DirectoryFixture(1,"",{
    admission:{version:CATALOG_OWNER_POLICY_VERSION,sha256:CATALOG_OWNER_POLICY_HASH}, moderationSigner:a("6"),recognition,
  },6343);
  const controller=privateKeyToAccount(h("4")), creator=privateKeyToAccount(h("5"));
  const config={...f.records[0]!.c,controller:controller.address.toLowerCase() as Address},
    media=await preparePin(new Uint8Array([4,5,6]),"audio/mpeg");
  const terms={revision:1,allowsDerivatives:true};
  const authorization={schema:"pirate.owner-publishing-authorization/1",communityId:config.communityId,
    ownerWallet:creator.address.toLowerCase(),policy:config.policies.admission,validFrom:Number(f.state.now)-800,expiresAt:Number(f.state.now)-100};
  const ownerAuthorization={authorization,signature:await controller.signMessage({message:{raw:hashJson(authorization)}})};
  const intent=acceptedIntent({schema:"pirate.recognition-accepted-intent/1",namespace:recognition.namespace,profileSha256:recognition.sha256,
    communityId:config.communityId,communityOrigin:config.app.origin,configurationRevision:1,jobId:"publication:local-test",
    submissionId:"local-test",inputHash:h("4"),authoritySha256:h("5"),ownerAuthorizationSha256:hashJson(authorization),
    creatorKey:"eip155:6343:"+creator.address.toLowerCase(),postId:h("2"),publicationRevision:1,audioSha256:media.sha256,
    audioBytes:media.byteLength,audioObjectKey:"staging/local-test",audioRevision:1,audioEtag:"test",metadataSha256:h("6"),
    termsRevision:1,termsSha256:hashJson(terms),allowsDerivatives:true,acceptedAt:(Number(f.state.now)-700)*1000});
  const manifest=validatePost({
    schema:"pirate.community-post/4",chainId:6343,postsContract:config.postsContract,communityId:config.communityId,
    postId:h("2"),authorId:h("3"),kind:"song",revision:1,configurationRevision:1,publishedAt:65536,
    title:"Public song",language:"en",rating:"general",media:[{...media,role:"audio"}],
    terms,recognition:{namespace:recognition.namespace,
      profileSha256:recognition.sha256,intentSha256:hashJson(intent),reservationId:reservationId(intent),recordingId:h("f")},
    admission:{policyVersion:config.policies.admission.version,policySha256:config.policies.admission.sha256,
      decision:"publish",rating:"general",coverDisplayed:false,evidenceSha256:h("9"),
      automatedContent:"deferred",declarationSource:"operator_declared"},
    registration:{status:"absent",reason:"deferred_for_launch"},
  });
  const pin=await preparePin(new TextEncoder().encode(canonical(manifest)),"application/json");
  const input={communityId:config.communityId,postId:manifest.postId,authorId:manifest.authorId,
    configurationRevision:1,manifestURI:pin.uri,manifestSha256:pin.sha256};
  const argumentsForEvent={...input,kind:0,revision:1n,configurationRevision:1n};
  const raw=await privateKeyToAccount(h("5")).signTransaction({data:publicationData(input),to:config.postsContract,type:"legacy",
    chainId:6343,gas:50000n,gasPrice:7n,nonce:0});
  const transactionHash=keccak256(raw);
  const chain={blockHash:f.state.hash,blockNumber:"57",transactionHash,postId:manifest.postId,revision:1 as const};
  const legacy={transactionHash,signedTransaction:raw,nonce:0,operationId:h("5"),requestHash:h("6")};
  const compact={schema:"pirate.protected-posts-catalog-posting/1",transactionHash,
    operationId:hashJson({job:intent.jobId,step:"publication"}),requestHash:legacy.requestHash,originalSha256:h("4")};
  const ready=async(posting:unknown, changes={})=>signReservation(signer,{
    schema:"pirate.recognition-reservation-receipt/1",purpose:"publication_promoted",namespace:recognition.namespace,
    profileSha256:recognition.sha256,communityId:config.communityId,configurationRevision:1,requestSha256:h("f"),
    intentSha256:hashJson(intent),reservationId:reservationId(intent),recordingId:h("f"),state:"committed",recordingState:"ready",
    postingSha256:hashJson(posting),publicationSha256:h("1"),issuedAt:Number(f.state.now)-600,expiresAt:Number(f.state.now)-570,
    ...changes,
  });
  const row=async (posting:unknown, isCompact:boolean, changes={})=>({
    posting_json:canonical(posting),chain_receipt_json:canonical(isCompact?{...chain,actualFeeWei:"350000"}:chain),
    promotion_receipt_json:canonical(await ready(posting,changes)),
  });
  let wrong=false, unsafe=false, safeReads=0;
  let advance: "same" | "anchor" | "inclusion" | undefined;
  const log={address:config.postsContract,logIndex:0,blockHash:chain.blockHash,blockNumber:57n,transactionHash,
    topics:encodeEventTopics({abi:postsAbi,eventName:"PostRevisionPublished",args:argumentsForEvent}),
    data:encodeAbiParameters(postsAbi[3].inputs.slice(3),[0,1n,1n,pin.sha256,pin.uri])};
  const client={
    ...f.client,
    getBlockNumber:async()=>f.state.safe+1n,
    getBlock:async (params:Parameters<PublicClient["getBlock"]>[0])=> {
      const block=await f.client.getBlock(params);
      if(params?.blockTag==="safe"){
        safeReads++;
        if(unsafe) return {...block,number:56n};
        if(advance&&safeReads>1) return {...block,number:f.state.safe+1n,hash:h("a")};
      }
      if(safeReads>1&&((advance==="anchor"&&params?.blockNumber===f.state.safe)||
        (advance==="inclusion"&&params?.blockNumber===57n))) return {...block,hash:h("b")};
      return block;
    },
    getCode:async()=> "0x6000",
    readContract:async(query:Parameters<PublicClient["readContract"]>[0])=>query.functionName==="getPost"?argumentsForEvent:config.directory,
    getTransaction:async()=>({type:"legacy",chainId:6343,hash:transactionHash,from:config.publisher,to:config.postsContract,
      input:wrong?"0x1234":publicationData(input),value:0n,blockHash:chain.blockHash}),
    getTransactionReceipt:async()=>({status:"success",transactionHash,blockHash:chain.blockHash,blockNumber:57n,logs:[log]}),
  } as unknown as PublicClient;
  const context={record:{post:manifest,transactionHash,blockNumber:chain.blockNumber,blockHash:chain.blockHash},
    profile:recognition,now:Number(f.state.now),compact:{config,client,
      posts:{address:config.postsContract,runtimeCodeHash:keccak256("0x6000"),deploymentBlock:1n},
      ipfs:async()=>new Response(canonical(manifest))}};
  return {legacy,compact,row,ready,context,raw,intent,ownerAuthorization,chain,pin,safe:f.state.safe,wrong:()=>{wrong=true;},unsafe:()=>{unsafe=true;},
    advance(mode: typeof advance){advance=mode;}};
}
test("ordinary catalog proof projects compact v2 alongside the unchanged legacy v1 reader",async()=>{
  const f=await sample();
  const legacy=await catalogSongPublicProof(await f.row(f.legacy,false),f.context);
  assert.equal(legacy.schema,"pirate.catalog-song-public-proof/1");
  const compact=await catalogSongPublicProof(await f.row(f.compact,true),f.context);
  assert.equal(compact.schema,"pirate.catalog-song-public-proof/2");
  const serialized=canonical(compact);
  assert(!serialized.includes(f.raw));
  assert.doesNotMatch(serialized,/"(?:nonce|signedTransaction|intent_json|ownerAuthorization)"/);
});
test("compact playback refuses changed signed promotion, mismatched calldata and a transaction above safe",async()=>{
  const f=await sample();
  await assert.rejects(catalogSongPublicProof(await f.row(f.compact,true,{postingSha256:h("b")}),f.context),/recognition_reservation_scope_mismatch/);
  f.unsafe();
  await assert.rejects(catalogSongPublicProof(await f.row(f.compact,true),f.context),/compact_catalog_chain_not_safe/);
  const g=await sample();g.wrong();
  await assert.rejects(catalogSongPublicProof(await g.row(g.compact,true),g.context),/compact_catalog_transaction_changed/);
});

test("canonical compact witness rederives the signed publication digest and rejects alternate fee evidence",async()=>{
  const f=await sample(),p=f.intent,chain={...f.chain,actualFeeWei:"350000"};
  const publication=verifiedPublication({namespace:p.namespace,communityId:p.communityId,postId:p.postId,
    publicationRevision:p.publicationRevision,configurationRevision:p.configurationRevision,creatorKey:p.creatorKey,
    audioSha256:p.audioSha256,audioBytes:p.audioBytes,audioObjectKey:p.audioObjectKey,audioRevision:p.audioRevision,
    termsRevision:p.termsRevision,termsSha256:p.termsSha256,allowsDerivatives:p.allowsDerivatives,
    publicationEvidenceSha256:hashJson({schema:"pirate.protected-posts-catalog-canonical/1",postingSha256:hashJson(f.compact),
      state:"confirmed",...chain})});
  const witness={schema:compactCanonicalWitnessSchema,intent:p,posting:f.compact,chain,
    ownerAuthorization:f.ownerAuthorization,receipt:await f.ready(f.compact,{publicationSha256:hashJson(publication)})};
  const read=(v:unknown)=>compactCanonicalRead(v,f.context.compact.config,f.context.compact,f.context.now);
  assert.deepEqual((await read(witness)).publication,publication);
  await assert.rejects(read({...witness,chain:{...chain,actualFeeWei:"350001"}}),/compact_catalog_promotion_changed/);
});
test("ordinary compact catalog route and ranged audio work without shared-feed configuration",async()=>{
  const f=await sample(),post=f.context.record.post,config=f.context.compact.config;
  let saved=await f.row(f.compact,true),audioReads=0;
  const db={
    withSession(){return this;},
    prepare(sql:string){return {bind(){return {
      first:async()=>sql.includes("chain_scan_state")?{next_block:String(f.safe+1n),checkpoint_hash:f.chain.blockHash}:saved,
      all:async()=>({results:[{community_id:post.communityId,post_id:post.postId,revision:1,author_id:post.authorId,
        configuration_revision:1,manifest_uri:f.pin.uri,manifest_sha256:f.pin.sha256,manifest_json:canonical(post),
        block_number:f.chain.blockNumber,block_hash:f.chain.blockHash,transaction_hash:f.chain.transactionHash,log_index:0,quarantined:0}]}),
    };}};},
  } as unknown as D1Database;
  const ports={client:f.context.compact.client,profile:f.context.compact.posts,transport:async ()=>{
    audioReads++;
    return new Response(new Uint8Array([4,5,6]));
  }};
  const path=config.app.origin+"/api/public/posts/"+post.postId;
  const proof=await publicSongResource(new Request(path+"/catalog-proof"),db,config,ports);
  assert.equal(proof?.status,200);
  assert.equal((await proof!.json() as {schema:string}).schema,"pirate.catalog-song-public-proof/2");
  const audio=await publicSongResource(new Request(path+"/audio",{headers:{range:"bytes=1-2"}}),db,config,ports);
  assert.equal(audio?.status,206);
  assert.deepEqual([...new Uint8Array(await audio!.arrayBuffer())],[5,6]);
  saved=await f.row(f.compact,true,{postingSha256:h("b")});
  await assert.rejects(publicSongResource(new Request(path+"/audio"),db,config,ports),/recognition_reservation_scope_mismatch/);
  assert.equal(audioReads,1);
});
test("a higher final safe head must retain the original safe and transaction blocks",async()=>{
  const same=await sample();
  same.advance("same");
  const proof=await catalogSongPublicProof(await same.row(same.compact,true),same.context);
  assert.equal(proof.schema,"pirate.catalog-song-public-proof/2");
  for(const displaced of ["anchor","inclusion"] as const){
    const changed=await sample();
    changed.advance(displaced);
    await assert.rejects(catalogSongPublicProof(await changed.row(changed.compact,true),changed.context),
      /compact_catalog_chain_changed/);
  }
});
