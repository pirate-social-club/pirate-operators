import { decodeFunctionData, keccak256, type Hex, type PublicClient } from "viem";
import { bytes32, canonical, exact, hashJson, insist, object } from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { fetchPublicIpfs, type IpfsTransport } from "../community/ipfs.ts";
import { observePublication, postsAbi, publicationData, type FirstPublication, type PostsProfile } from "../community/post-chain.ts";
import { validatePostForEvent, type PostManifest } from "../community/post-manifest.ts";
import { requireOwnerIdentity } from "../community/owner-authorization.ts";
import type { OwnerVerification } from "../community/owner-authorization-verifier.ts";
import { acceptedIntent, reservationId, type AcceptedIntent, type RecognitionProfile } from "./intent.ts";
import { verifiedPublication } from "./model.ts";
import { protectedCatalogPostingSchema, readProtectedCatalogPosting } from "./protected-catalog.ts";
import { reservationReceipt, verifyReservation } from "./reservation-receipt.ts";

export const compactCanonicalWitnessSchema="pirate.canonical-compact-publication/1";

export function isCompactPosting(value: unknown) {
  return !!value && typeof value==="object" && "schema" in value && value.schema===protectedCatalogPostingSchema;
}
export interface CompactReadPorts {
  client: PublicClient;
  posts: PostsProfile;
  ipfs?: IpfsTransport;
  ownerVerification?: OwnerVerification;
}
export function readCompactChain(value: unknown) {
  const r=object(value);
  exact(r,["transactionHash","blockHash","blockNumber","postId","revision","actualFeeWei"]);
  insist(typeof r.blockNumber==="string"&&/^[1-9][0-9]{0,77}(?![\s\S])/.test(r.blockNumber)&&
    typeof r.actualFeeWei==="string"&&/^[1-9][0-9]{0,77}(?![\s\S])/.test(r.actualFeeWei)&&r.revision===1,
  "compact_catalog_chain_changed",503);
  return {transactionHash:bytes32(r.transactionHash),blockHash:bytes32(r.blockHash),blockNumber:r.blockNumber,
    postId:bytes32(r.postId),revision:1 as const,actualFeeWei:r.actualFeeWei};
}
export async function compactCatalogRead(input: {posting:unknown;chain:unknown;receipt:unknown},
  config:CommunityConfig,profile:RecognitionProfile,ports:CompactReadPorts,now:number,expectedPost?:PostManifest) {
  const retained=structuredClone(input), posting=readProtectedCatalogPosting(retained.posting), chain=readCompactChain(retained.chain),
    wire=object(retained.receipt), receipt=reservationReceipt(wire.payload);
  insist(posting.transactionHash===chain.transactionHash&&config.chainId===6343&&ports.posts.address===config.postsContract&&
    canonical(config.policies.recognition)===canonical(profile),"compact_catalog_chain_changed",503);
  const safe=await ports.client.getBlock({blockTag:"safe"}), height=BigInt(chain.blockNumber);
  insist(safe.hash&&safe.number!==null&&height<=safe.number&&height>=ports.posts.deploymentBlock,
    "compact_catalog_chain_not_safe",503);
  const tx=await ports.client.getTransaction({hash:posting.transactionHash});
  insist(tx.type==="legacy"&&tx.input.length>10,"compact_catalog_transaction_changed",503);
  const decoded=decodeFunctionData({abi:postsAbi,data:tx.input});
  insist(decoded.functionName==="publishRevision","compact_catalog_transaction_changed",503);
  const [communityId,postId,_previous,_revision,authorId,_kind,manifestSha256,manifestURI]=decoded.args;
  const call: FirstPublication={communityId,postId,authorId,configurationRevision:config.configurationRevision,manifestSha256,manifestURI};
  insist(communityId===config.communityId&&postId===chain.postId&&tx.input===publicationData(call),
    "compact_catalog_transaction_changed",503);
  const code=await ports.client.getCode({address:ports.posts.address,blockNumber:safe.number});
  insist(code&&keccak256(code)===ports.posts.runtimeCodeHash,"compact_catalog_posts_code_changed",503);
  const observed=await observePublication(ports.client,ports.posts,config,posting.transactionHash,config.publisher,call);
  insist(observed&&observed.transactionHash===chain.transactionHash&&observed.blockHash===chain.blockHash&&
    observed.blockNumber===chain.blockNumber&&observed.postId===chain.postId&&observed.revision===chain.revision,
    "compact_catalog_chain_changed",503);
  const rawPost=expectedPost??JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(
    (await fetchPublicIpfs(call.manifestURI,call.manifestSha256,1024*1024,ports.ipfs)).bytes));
  const post=validatePostForEvent(rawPost,{...call,chainId:6343,postsContract:config.postsContract,kind:0,revision:1},config);
  insist(post.schema==="pirate.community-post/4"&&post.recognition&&post.terms&&hashJson(post)===call.manifestSha256&&
    (!expectedPost||canonical(post)===canonical(expectedPost))&&
    post.recognition.namespace===profile.namespace&&post.recognition.profileSha256===profile.sha256&&
    receipt.issuedAt<=now&&(receipt.purpose==="publication_promoted"||receipt.purpose==="accepted_intent")&&
    receipt.state==="committed"&&receipt.recordingState==="ready"&&receipt.publicationSha256,
    "compact_catalog_promotion_unproven",503);
  const payload=await verifyReservation(wire,profile,{communityId:post.communityId,configurationRevision:post.configurationRevision,
    intentSha256:post.recognition.intentSha256,reservationId:post.recognition.reservationId,recordingId:post.recognition.recordingId,
    postingSha256:hashJson(posting)},receipt.issuedAt);
  const currentSafe=await ports.client.getBlock({blockTag:"safe"});
  insist(currentSafe.hash&&currentSafe.number!==null&&currentSafe.number>=safe.number&&
    (currentSafe.number!==safe.number||currentSafe.hash===safe.hash),"compact_catalog_chain_changed",503);
  // Check both historical pins after sampling the current safe branch.
  const anchor=await ports.client.getBlock({blockNumber:safe.number});
  const block=await ports.client.getBlock({blockNumber:height});
  insist(anchor.hash===safe.hash&&block.hash===chain.blockHash,"compact_catalog_chain_changed",503);
  return {chain,post,posting,receipt:{payload,signature:wire.signature as Hex}};
}

export async function compactCanonicalRead(input: unknown,config:CommunityConfig,ports:CompactReadPorts,now:number) {
  const v=object(structuredClone(input));
  exact(v,["schema","intent","posting","chain","receipt","ownerAuthorization"]);
  insist(v.schema===compactCanonicalWitnessSchema&&config.policies.recognition,"compact_catalog_witness_invalid",503);
  const p=acceptedIntent(v.intent);
  const owner=await requireOwnerIdentity(v.ownerAuthorization,config,p.creatorKey.slice("eip155:6343:".length),ports.ownerVerification);
  const accepted=Math.floor(p.acceptedAt/1000);
  insist(accepted>=owner.validFrom&&accepted<owner.expiresAt&&hashJson(owner)===p.ownerAuthorizationSha256,
    "recognition_original_owner_window_changed",409);
  const observed=await compactCatalogRead({posting:v.posting,chain:v.chain,receipt:v.receipt},config,config.policies.recognition,ports,now);
  const post=observed.post, audio=post.media.find(m=>m.role==="audio");
  insist(p.namespace===post.recognition?.namespace&&p.profileSha256===post.recognition.profileSha256&&
    p.communityOrigin===config.app.origin&&p.communityId===post.communityId&&p.postId===post.postId&&p.publicationRevision===1&&
    p.configurationRevision===post.configurationRevision&&hashJson(p)===post.recognition.intentSha256&&
    reservationId(p)===post.recognition.reservationId&&audio?.byteLength===p.audioBytes&&audio.sha256===p.audioSha256&&
    post.terms?.revision===p.termsRevision&&post.terms.allowsDerivatives===p.allowsDerivatives&&hashJson(post.terms)===p.termsSha256&&
    observed.posting.operationId===hashJson({job:p.jobId,step:"publication"}),"compact_catalog_intent_changed",409);
  const publication=verifiedPublication({namespace:p.namespace,communityId:p.communityId,postId:p.postId,
    publicationRevision:p.publicationRevision,configurationRevision:p.configurationRevision,creatorKey:p.creatorKey,
    audioSha256:p.audioSha256,audioBytes:p.audioBytes,audioObjectKey:p.audioObjectKey,audioRevision:p.audioRevision,
    termsRevision:p.termsRevision,termsSha256:p.termsSha256,allowsDerivatives:p.allowsDerivatives,
    publicationEvidenceSha256:hashJson({schema:"pirate.protected-posts-catalog-canonical/1",
      postingSha256:hashJson(observed.posting),state:"confirmed",...observed.chain})});
  insist(observed.receipt.payload.publicationSha256===hashJson(publication),"compact_catalog_promotion_changed",409);
  await requireOwnerIdentity(v.ownerAuthorization,config,owner.ownerWallet,ports.ownerVerification);
  return {intent:p,posting:observed.posting,publication};
}
