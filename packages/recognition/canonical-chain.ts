import type { OwnerVerification } from "../community/owner-authorization-verifier.ts";
import {
  decodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type PublicClient,
  type TransactionSerializedLegacy,
} from "viem";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
} from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import {
  observePublication,
  postsAbi,
  publicationData,
  type PostsProfile,
} from "../community/post-chain.ts";
import { fetchPublicIpfs, type IpfsTransport } from "../community/ipfs.ts";
import { validatePostForEvent } from "../community/post-manifest.ts";
import {
  acceptedIntent,
  reservationId,
  type AcceptedIntent,
  type PostingBinding,
} from "./intent.ts";
import { verifiedPublication } from "./model.ts";
import { requireSameCanonicalSource } from "./canonical-community.ts";
import { requireOwnerIdentity } from "../community/owner-authorization.ts";

/** Managed-owned inputs. Neither RPC nor bytecode pins come from the publisher's response. */
export interface CanonicalChainInputs {
  client: PublicClient;
  ownerVerification?: OwnerVerification;
  posts: PostsProfile;
  ipfs?: IpfsTransport;
}
export function requireFirstSongRevision(revision: number) {
  insist(revision === 1, "canonical_publication_revision_unsupported", 409);
}
export function canonicalPostingBinding(input: unknown): PostingBinding {
  const v = object(input);
  exact(v, [
    "operationId",
    "requestHash",
    "signedTransaction",
    "transactionHash",
    "nonce",
  ]);
  insist(
    typeof v.signedTransaction === "string" &&
      /^0x(?:[0-9a-f]{2})+$/.test(v.signedTransaction),
    "canonical_posting_invalid",
    409,
  );
  return {
    operationId: bytes32(v.operationId),
    requestHash: bytes32(v.requestHash),
    signedTransaction: v.signedTransaction as Hex,
    transactionHash: bytes32(v.transactionHash),
    nonce: integer(v.nonce, 0, Number.MAX_SAFE_INTEGER),
  };
}
export async function canonicalPostingInput(
  p: AcceptedIntent,
  input: unknown,
  config: CommunityConfig,
) {
  requireFirstSongRevision(p.publicationRevision);
  const posting = canonicalPostingBinding(input),
    tx = parseTransaction(posting.signedTransaction);
  insist(
    tx.type === "legacy" &&
      tx.chainId === 6343 &&
      tx.to?.toLowerCase() === config.postsContract &&
      (tx.value ?? 0n) === 0n &&
      tx.nonce === posting.nonce &&
      keccak256(posting.signedTransaction) === posting.transactionHash &&
      posting.operationId === hashJson({ job: p.jobId, step: "publication" }) &&
      p.communityId === config.communityId &&
      p.configurationRevision === config.configurationRevision &&
      (
        await recoverTransactionAddress({
          serializedTransaction:
            posting.signedTransaction as TransactionSerializedLegacy,
        })
      ).toLowerCase() === config.publisher,
    "recognition_signed_posting_changed",
    409,
  );
  const decoded = decodeFunctionData({ abi: postsAbi, data: tx.data! });
  insist(
    decoded.functionName === "publishRevision",
    "recognition_signed_posting_changed",
    409,
  );
  const [
    communityId,
    postId,
    previous,
    revision,
    authorId,
    kind,
    manifestSha256,
    manifestURI,
  ] = decoded.args;
  insist(
    communityId === p.communityId &&
      postId === p.postId &&
      previous === 0n &&
      revision === BigInt(p.configurationRevision) &&
      kind === 0,
    "recognition_signed_posting_changed",
    409,
  );
  const publication = {
    communityId,
    postId,
    configurationRevision: p.configurationRevision,
    authorId,
    manifestSha256,
    manifestURI,
  };
  insist(
    tx.data === publicationData(publication),
    "recognition_signed_posting_changed",
    409,
  );
  return { posting, publication };
}
/** A publisher signature authenticates transport only. Observe the actual mined
 * transaction, safe Posts code, event and public content through our own pins. */
export async function independentCanonicalPublication(
  input: unknown,
  config: CommunityConfig,
  chain: CanonicalChainInputs,
) {
  const witness = object(input);
  exact(witness, ["intent", "posting", "publication", "ownerAuthorization"]);
  const p = acceptedIntent(witness.intent),
    value = verifiedPublication(witness.publication);
  const owner = await requireOwnerIdentity(
    witness.ownerAuthorization,
    config,
    p.creatorKey.slice("eip155:6343:".length),
    chain.ownerVerification,
  );
  insist(Math.floor(p.acceptedAt/1000)>=owner.validFrom&&Math.floor(p.acceptedAt/1000)<owner.expiresAt,"recognition_original_owner_window_changed",403);
  insist(
    hashJson(owner) === p.ownerAuthorizationSha256,
    "recognition_owner_authority_changed",
    403,
  );
  requireSameCanonicalSource(p, value);
  const { posting, publication } = await canonicalPostingInput(
      p,
      witness.posting,
      config,
    ),
    observed = await observePublication(
      chain.client,
      chain.posts,
      config,
      posting.transactionHash,
      config.publisher,
      publication,
    );
  insist(
    observed &&
      p.publicationRevision === observed.revision &&
      value.publicationRevision === observed.revision &&
      value.publicationEvidenceSha256 === hashJson(observed),
    "recognition_chain_receipt_changed",
    409,
  );
  const content = await fetchPublicIpfs(
      publication.manifestURI,
      publication.manifestSha256,
      1024 * 1024,
      chain.ipfs,
    ),
    post = validatePostForEvent(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(content.bytes),
      ),
      {
        ...publication,
        chainId: 6343,
        postsContract: config.postsContract,
        kind: 0,
        revision: observed.revision,
      },
      config,
    ),
    audio = post.media.filter((m) => m.role === "audio");
  insist(
    audio.length === 1 &&
      audio[0]!.sha256 === p.audioSha256 &&
      audio[0]!.byteLength === p.audioBytes &&
      post.recognition?.intentSha256 === hashJson(p) &&
      post.recognition.reservationId === reservationId(p) &&
      post.terms?.revision === p.termsRevision &&
      post.terms.allowsDerivatives === p.allowsDerivatives &&
      hashJson(post.terms) === p.termsSha256,
    "recognition_public_manifest_changed",
    409,
  );
  await requireOwnerIdentity(witness.ownerAuthorization, config, owner.ownerWallet, chain.ownerVerification);
  return { intent: p, posting, publication: value };
}
