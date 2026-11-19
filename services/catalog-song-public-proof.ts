import { decodeFunctionData, keccak256, parseTransaction, type Hex } from "viem";
import { bytes32, exact, hashJson, insist, object } from "../packages/community/common.ts";
import { postsAbi, publicationData } from "../packages/community/post-chain.ts";
import type { PostManifest } from "../packages/community/post-manifest.ts";
import { canonicalPostingBinding } from "../packages/recognition/canonical-chain.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { compactCatalogRead, isCompactPosting, type CompactReadPorts } from "../packages/recognition/compact-catalog-read.ts";
import type { RecognitionProfile } from "../packages/recognition/intent.ts";
import { reservationReceipt, verifyReservation } from "../packages/recognition/reservation-receipt.ts";

export interface CatalogSongRecord {
  post: PostManifest;
  transactionHash: Hex;
  blockNumber: string;
  blockHash?: Hex;
}

interface CatalogSongProofContext {
  record: CatalogSongRecord;
  profile: RecognitionProfile;
  now: number;
  compact?: CompactReadPorts & {config:CommunityConfig};
}

export interface RetainedCatalogSongProof {
  posting_json: string;
  promotion_receipt_json: string;
  chain_receipt_json: string;
}

// The posting preimage contains the already mined transaction and two
// commitments. It contains no intent, media key, owner grant or bearer token.
export async function verifyCatalogSongPublicProof(input: unknown, context: CatalogSongProofContext) {
  const { record, profile, now } = context;
  const { post } = record;
  const proof = object(input);
  exact(proof, ["schema", "posting", "receipt"]);
  insist(
    proof.schema === "pirate.catalog-song-public-proof/1" &&
      post.schema === "pirate.community-post/4" && post.revision === 1 && post.recognition,
    "catalog_public_proof_invalid", 503,
  );
  const posting = canonicalPostingBinding(proof.posting);
  insist(
    posting.transactionHash === record.transactionHash &&
      keccak256(posting.signedTransaction) === record.transactionHash,
    "catalog_public_posting_changed", 503,
  );
  const tx = parseTransaction(posting.signedTransaction);
  insist(
    tx.type === "legacy" && tx.chainId === 6343 && tx.nonce === posting.nonce &&
      (tx.value ?? 0n) === 0n && tx.to?.toLowerCase() === post.postsContract && tx.data,
    "catalog_public_posting_changed", 503,
  );
  const call = decodeFunctionData({ abi: postsAbi, data: tx.data });
  insist(call.functionName === "publishRevision" && tx.data === publicationData({
    communityId: post.communityId, postId: post.postId, authorId: post.authorId,
    configurationRevision: post.configurationRevision,
    manifestURI: call.args[7], manifestSha256: hashJson(post),
  }), "catalog_public_posting_changed", 503);

  const wire = object(proof.receipt);
  const retained = reservationReceipt(wire.payload);
  insist(
    retained.issuedAt <= now &&
      (retained.purpose === "publication_promoted" || retained.purpose === "accepted_intent") &&
      retained.state === "committed" && retained.recordingState === "ready" && retained.publicationSha256 &&
      post.recognition.namespace === profile.namespace && post.recognition.profileSha256 === profile.sha256,
    "catalog_public_promotion_unproven", 503,
  );
  // At its signed historical time the existing verifier checks the exact short
  // validity window and signer. This is immutable read evidence. Live receipt
  // handling still uses the caller's current time for authenticated operations.
  const payload = await verifyReservation(wire, profile, {
    communityId: post.communityId, configurationRevision: post.configurationRevision,
    intentSha256: post.recognition.intentSha256, reservationId: post.recognition.reservationId,
    recordingId: post.recognition.recordingId, postingSha256: hashJson(posting),
  }, retained.issuedAt);
  return { schema: "pirate.catalog-song-public-proof/1" as const, posting, receipt: {
    payload, signature: wire.signature as Hex,
  } };
}

export async function catalogSongPublicProof(row: RetainedCatalogSongProof, context: CatalogSongProofContext) {
  const chain = object(JSON.parse(row.chain_receipt_json));
  insist(
    chain.transactionHash === context.record.transactionHash &&
      chain.blockNumber === context.record.blockNumber &&
      chain.postId === context.record.post.postId &&
      chain.revision === context.record.post.revision && bytes32(chain.blockHash) &&
      (context.record.blockHash === undefined || chain.blockHash === context.record.blockHash),
    "catalog_public_receipt_changed", 503,
  );
  const posting:unknown=JSON.parse(row.posting_json), receipt:unknown=JSON.parse(row.promotion_receipt_json);
  if(isCompactPosting(posting)) {
    const selected=context.compact;
    insist(selected,"compact_catalog_read_unavailable",503);
    const observed=await compactCatalogRead({posting,chain,receipt},selected.config,context.profile,selected,context.now,context.record.post);
    return {schema:"pirate.catalog-song-public-proof/2" as const,posting:observed.posting,receipt:observed.receipt};
  }
  insist(!Object.hasOwn(object(posting),"schema"),"catalog_public_proof_invalid",503);
  return verifyCatalogSongPublicProof({
    schema: "pirate.catalog-song-public-proof/1",
    posting, receipt,
  }, context);
}
