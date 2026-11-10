// Independent complete supported post/admission/registration/media schema.
// Receipt fields here authenticate published metadata, not a separate Story RPC.
import { requireFact } from "./checks.ts";
import {
  exactDocument,
  documentText,
  documentInteger,
  documentHash,
  documentAddress,
  documentDecimal,
  documentIpfs,
  admissionPolicy,
} from "./document-rules.ts";
export function postDocument(
  post: Record<string, any>,
  config: Record<string, any>,
) {
  exactDocument(post, [
    "schema",
    "chainId",
    "postsContract",
    "communityId",
    "postId",
    "authorId",
    "kind",
    "revision",
    "configurationRevision",
    "publishedAt",
    "title",
    "language",
    "rating",
    "media",
    "admission",
    "registration",
  ]);
  const curated = post.schema === "pirate.community-post/2";
  requireFact(
    (curated || post.schema === "pirate.community-post/1") &&
      [6343, 31337].includes(post.chainId) &&
      post.kind === "song" &&
      ["general", "adult"].includes(post.rating),
    "unsupported_post_schema",
  );
  documentAddress(post.postsContract);
  for (const field of ["communityId", "postId", "authorId"])
    documentHash(post[field]);
  documentInteger(post.revision, 1);
  documentInteger(post.configurationRevision, 1);
  documentInteger(post.publishedAt);
  requireFact(
    documentText(post.title, 200).trim().length > 0 &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(
        documentText(post.language, 35),
      ),
    "invalid_post_text",
  );
  const a = post.admission;
  exactDocument(a, [
    "policyVersion",
    "policySha256",
    "decision",
    "rating",
    "coverDisplayed",
    "evidenceSha256",
    ...(curated ? ["automatedContent", "declarationSource"] : []),
  ]);
  admissionPolicy(
    { version: a.policyVersion, sha256: a.policySha256 },
    curated,
  );
  requireFact(
    a.policyVersion === config.policies.admission.version &&
      a.policySha256 === config.policies.admission.sha256 &&
      a.decision === "publish" &&
      a.rating === post.rating &&
      typeof a.coverDisplayed === "boolean" &&
      (!curated ||
        (a.automatedContent === "deferred" &&
          a.declarationSource === "operator_declared")),
    "invalid_post_admission",
  );
  documentHash(a.evidenceSha256);
  requireFact(
    Array.isArray(post.media) &&
      post.media.length >= 1 &&
      post.media.length <= 3,
    "invalid_post_media",
  );
  for (const media of post.media) {
    exactDocument(media, ["role", "uri", "sha256", "byteLength", "mediaType"]);
    const types: Record<string, string> = {
      audio: "audio/mpeg",
      lyrics: "application/json",
      artwork: "image/jpeg",
    };
    requireFact(
      Object.hasOwn(types, media.role) && media.mediaType === types[media.role],
      "invalid_post_media_type",
    );
    documentIpfs(media.uri);
    documentHash(media.sha256);
    documentInteger(
      media.byteLength,
      1,
      media.role === "audio" ? 25 * 1024 * 1024 : 1024 * 1024,
    );
  }
  requireFact(
    new Set(post.media.map((m: any) => m.role)).size === post.media.length &&
      post.media.some((m: any) => m.role === "audio") &&
      post.media.some((m: any) => m.role === "artwork") === a.coverDisplayed,
    "invalid_post_media_roles",
  );
  const r = post.registration;
  exactDocument(r, [
    "protocol",
    "network",
    "chainId",
    "assetId",
    "nftContract",
    "tokenId",
    "recipient",
    "transactionHash",
    "blockHash",
    "blockNumber",
    "metadataUri",
    "metadataSha256",
    "contentSha256",
    "status",
  ]);
  requireFact(
    r.protocol === "story" &&
      r.network === "aeneid" &&
      r.chainId === 1315 &&
      r.status === "confirmed",
    "invalid_post_registration",
  );
  for (const field of ["assetId", "nftContract", "recipient"])
    documentAddress(r[field]);
  for (const field of [
    "transactionHash",
    "blockHash",
    "metadataSha256",
    "contentSha256",
  ])
    documentHash(r[field]);
  documentDecimal(r.tokenId);
  documentDecimal(r.blockNumber);
  documentIpfs(r.metadataUri);
  requireFact(
    r.contentSha256 === post.media.find((m: any) => m.role === "audio").sha256,
    "post_registration_content_changed",
  );
}
