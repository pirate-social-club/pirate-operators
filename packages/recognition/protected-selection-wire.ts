import { bytes32, canonical, exact, hashJson, insist, integer, object } from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { address, ipfsUri } from "../community/manifest-core.ts";
import type { AcceptedIntent } from "./intent.ts";
import { readNativePostsPublicationReference, readNativePostsQuote } from "../../services/native-posts-publication.ts";

export function readProtectedSelectionResult(
  value: unknown,
  configuration: CommunityConfig,
  intent: AcceptedIntent,
  admittedProofSigner: string,
) {
  const row = object(value);
  exact(row, ["schema", "reference", "applicationOriginalSha256", "grantSha256", "retainedCustodySha256",
    "quote", "publisher", "postsContract", "proofSigner", "intentSha256", "recordingId", "publication"]);
  const reference = readNativePostsPublicationReference(canonical(row.reference));
  const quote = readNativePostsQuote(canonical({ reference: hashJson(reference), result: row.quote }), reference);
  const post = object(row.publication);
  exact(post, ["communityId", "postId", "authorId", "configurationRevision", "manifestSha256", "manifestURI"]);
  const publication = Object.freeze({
    communityId: bytes32(post.communityId), postId: bytes32(post.postId), authorId: bytes32(post.authorId),
    configurationRevision: integer(post.configurationRevision, 1, 1),
    manifestSha256: bytes32(post.manifestSha256), manifestURI: ipfsUri(post.manifestURI),
  });
  const proofSigner = address(row.proofSigner), intentSha256 = hashJson(intent);
  insist(row.schema === "pirate.protected-catalog-selection/1" &&
    configuration.schema === "pirate.community-config/4" && configuration.chainId === 6343 &&
    row.publisher === configuration.publisher && row.postsContract === configuration.postsContract &&
    proofSigner === address(admittedProofSigner) && proofSigner !== configuration.publisher &&
    proofSigner !== configuration.policies.recognition?.signer && row.intentSha256 === intentSha256 &&
    reference.installationId === configuration.installationId && reference.jobId === intent.jobId &&
    publication.communityId === configuration.communityId && publication.communityId === intent.communityId &&
    publication.postId === intent.postId && publication.configurationRevision === intent.configurationRevision &&
    publication.configurationRevision === configuration.configurationRevision && intent.publicationRevision === 1,
  "protected_catalog_selection_changed", 409);
  return {
    kind: "protected" as const,
    original: Object.freeze({
      configuration: structuredClone(configuration), reference, quote, publication, proofSigner, intentSha256,
      applicationOriginalSha256: bytes32(row.applicationOriginalSha256), grantSha256: bytes32(row.grantSha256),
      retainedCustodySha256: bytes32(row.retainedCustodySha256), recordingId: bytes32(row.recordingId),
    }),
  };
}
