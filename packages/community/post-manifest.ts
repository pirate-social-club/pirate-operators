import type { Address, Hex } from "viem";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import {
  address,
  decimal,
  ipfsUri,
  schema,
  identity,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
  type PublicationIdentity,
} from "./manifest-core.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import {
  ownerCurated,
  unregisteredOwner, catalogOwner, CATALOG_OWNER_POLICY_VERSION, CATALOG_OWNER_POLICY_HASH,
  OWNER_POLICY_VERSION,
  OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
  UNREGISTERED_OWNER_POLICY_HASH,
} from "./owner-policy.ts";

export interface MediaReference {
  role: "audio" | "lyrics" | "artwork";
  uri: string;
  sha256: Hex;
  byteLength: number;
  mediaType: string;
}
export interface RegistrationReceipt {
  protocol: "story";
  network: "aeneid";
  chainId: 1315;
  assetId: Address;
  nftContract: Address;
  tokenId: string;
  recipient: Address;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: string;
  metadataUri: string;
  metadataSha256: Hex;
  contentSha256: Hex;
  status: "confirmed";
}
export function validateRegistration(value: unknown): RegistrationReceipt {
  const o = object(value);
  exact(o, [
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
  insist(
    o.protocol === "story" &&
      o.network === "aeneid" &&
      o.chainId === 1315 &&
      o.status === "confirmed",
    "unconfirmed_or_wrong_registration",
  );
  return {
    protocol: "story",
    network: "aeneid",
    chainId: 1315,
    assetId: address(o.assetId),
    nftContract: address(o.nftContract),
    tokenId: decimal(o.tokenId),
    recipient: address(o.recipient),
    transactionHash: bytes32(o.transactionHash),
    blockHash: bytes32(o.blockHash),
    blockNumber: decimal(o.blockNumber),
    metadataUri: ipfsUri(o.metadataUri),
    metadataSha256: bytes32(o.metadataSha256),
    contentSha256: bytes32(o.contentSha256),
    status: "confirmed",
  };
}
/** External registration explicitly absent (pirate.community-post/3 only). */
export interface AbsentRegistration {
  status: "absent";
  reason: "deferred_for_launch";
}
export const ABSENT_REGISTRATION: AbsentRegistration = {
  status: "absent",
  reason: "deferred_for_launch",
};
export function validateAbsentRegistration(value: unknown): AbsentRegistration {
  const o = object(value);
  exact(o, ["status", "reason"]);
  insist(
    o.status === "absent" && o.reason === "deferred_for_launch",
    "invalid_absent_registration",
  );
  return { ...ABSENT_REGISTRATION };
}
export type PostSchema =
  | "pirate.community-post/1"
  | "pirate.community-post/2"
  | "pirate.community-post/3"
  | "pirate.community-post/4";
export const isRegistered = (
  registration: RegistrationReceipt | AbsentRegistration,
): registration is RegistrationReceipt => registration.status === "confirmed";
export interface PostManifest extends PublicationIdentity {
  schema: PostSchema;
  authorId: Hex;
  kind: "song";
  revision: number;
  configurationRevision: number;
  publishedAt: number;
  title: string;
  language: string;
  rating: "general" | "adult";
  media: MediaReference[];
  admission: {
    policyVersion: string;
    policySha256: Hex;
    decision: "publish";
    rating: "general" | "adult";
    coverDisplayed: boolean;
    evidenceSha256: Hex;
    automatedContent?: "deferred";
    declarationSource?: "operator_declared";
  };
  registration: RegistrationReceipt | AbsentRegistration;
  terms?: {revision:number;allowsDerivatives:boolean};
  recognition?: {namespace:Hex;profileSha256:Hex;intentSha256:Hex;reservationId:Hex;recordingId:Hex};
}
export function validatePost(value: unknown): PostManifest {
  const raw = object(value),
    catalog = raw.schema === "pirate.community-post/4",
    unregistered = catalog || raw.schema === "pirate.community-post/3",
    // Both owner policies declare rating and language and defer automated content.
    curated = unregistered || raw.schema === "pirate.community-post/2",
    name: PostSchema = catalog ? "pirate.community-post/4" : unregistered
      ? "pirate.community-post/3"
      : curated
        ? "pirate.community-post/2"
        : "pirate.community-post/1",
    policyVersion = catalog ? CATALOG_OWNER_POLICY_VERSION : unregistered
      ? UNREGISTERED_OWNER_POLICY_VERSION
      : curated
        ? OWNER_POLICY_VERSION
        : RELEASE_POLICY,
    policySha256 = catalog ? CATALOG_OWNER_POLICY_HASH : unregistered
      ? UNREGISTERED_OWNER_POLICY_HASH
      : curated
        ? OWNER_POLICY_HASH
        : RELEASE_POLICY_HASH;
  const o = schema(value, name, [
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
    ...(catalog ? ["terms","recognition"] : []),
  ]);
  insist(
    o.kind === "song" && (o.rating === "general" || o.rating === "adult"),
    "unsupported_post",
  );
  let catalogFields: Pick<PostManifest,"terms"|"recognition"> = {};
  if (catalog) {
    const terms=object(o.terms),r=object(o.recognition);
    exact(terms,["revision","allowsDerivatives"]); exact(r,["namespace","profileSha256","intentSha256","reservationId","recordingId"]);
    insist(terms.revision===1 && typeof terms.allowsDerivatives==="boolean","invalid_song_terms");
    catalogFields={terms:{revision:1,allowsDerivatives:terms.allowsDerivatives},recognition:{namespace:bytes32(r.namespace),profileSha256:bytes32(r.profileSha256),intentSha256:bytes32(r.intentSha256),reservationId:bytes32(r.reservationId),recordingId:bytes32(r.recordingId)}};
  }
  const admission = object(o.admission);
  exact(admission, [
    "policyVersion",
    "policySha256",
    "decision",
    "rating",
    "coverDisplayed",
    "evidenceSha256",
    ...(curated ? ["automatedContent", "declarationSource"] : []),
  ]);
  insist(
    admission.policyVersion === policyVersion &&
      admission.policySha256 === policySha256 &&
      (!curated ||
        (admission.automatedContent === "deferred" &&
          admission.declarationSource === "operator_declared")) &&
      admission.decision === "publish" &&
      admission.rating === o.rating &&
      typeof admission.coverDisplayed === "boolean",
    "invalid_admission_summary",
  );
  insist(
    Array.isArray(o.media) && o.media.length >= 1 && o.media.length <= 3,
    "invalid_media",
  );
  const media: MediaReference[] = o.media.map((value) => {
    const m = object(value);
    exact(m, ["role", "uri", "sha256", "byteLength", "mediaType"]);
    insist(
      m.role === "audio" || m.role === "lyrics" || m.role === "artwork",
      "invalid_media_role",
    );
    const expectedType =
      m.role === "audio"
        ? "audio/mpeg"
        : m.role === "lyrics"
          ? "application/json"
          : "image/jpeg";
    insist(m.mediaType === expectedType, "unsupported_media_type");
    return {
      role: m.role,
      uri: ipfsUri(m.uri),
      sha256: bytes32(m.sha256),
      byteLength: integer(
        m.byteLength,
        1,
        m.role === "audio" ? 25 * 1024 * 1024 : 1024 * 1024,
      ),
      mediaType: expectedType,
    };
  });
  insist(
    new Set(media.map((m) => m.role)).size === media.length &&
      media.some((m) => m.role === "audio"),
    "duplicate_or_missing_media",
  );
  insist(
    media.some((m) => m.role === "artwork") === admission.coverDisplayed,
    "cover_policy_mismatch",
  );
  // /1 and /2 keep strict confirmed receipts; /3 can only say registration is absent.
  const registration = unregistered
    ? validateAbsentRegistration(o.registration)
    : validateRegistration(o.registration);
  insist(
    !isRegistered(registration) ||
      registration.contentSha256 ===
        media.find((m) => m.role === "audio")!.sha256,
    "registration_content_mismatch",
  );
  const title = text(o.title, 200),
    language = text(o.language, 35);
  insist(
    title.trim().length > 0 &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(language),
    "invalid_post_text",
  );
  return {
    ...identity(o),
    ...catalogFields,
    schema: name,
    authorId: bytes32(o.authorId),
    kind: "song",
    revision: integer(o.revision, 1, Number.MAX_SAFE_INTEGER),
    configurationRevision: integer(
      o.configurationRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    publishedAt: integer(o.publishedAt, 0, Number.MAX_SAFE_INTEGER),
    title,
    language,
    rating: o.rating,
    media,
    registration,
    admission: {
      policyVersion,
      policySha256,
      decision: "publish",
      rating: o.rating,
      coverDisplayed: admission.coverDisplayed,
      evidenceSha256: bytes32(admission.evidenceSha256),
      ...(curated
        ? {
            automatedContent: "deferred" as const,
            declarationSource: "operator_declared" as const,
          }
        : {}),
    },
  };
}

export interface PublicationEvent extends PublicationIdentity {
  authorId: Hex;
  kind: 0 | 1;
  revision: number;
  configurationRevision: number;
  manifestSha256: Hex;
  manifestURI: string;
}
export function validatePostForEvent(
  value: unknown,
  event: PublicationEvent,
  config: CommunityConfig,
): PostManifest {
  const post = validatePost(value);
  insist(
    post.admission.policyVersion === config.policies.admission.version &&
      post.admission.policySha256 === config.policies.admission.sha256 &&
      (post.schema === "pirate.community-post/2") ===
        ownerCurated(config.policies.admission) &&
      (post.schema === "pirate.community-post/3") ===
        unregisteredOwner(config.policies.admission) &&
      (post.schema === "pirate.community-post/4") === catalogOwner(config.policies.admission) &&
      (post.schema !== "pirate.community-post/4" || (post.recognition?.namespace === config.policies.recognition?.namespace && post.recognition?.profileSha256 === config.policies.recognition?.sha256)),
    "post_admission_policy_mismatch",
  );
  insist(event.kind === 0, "unsupported_post_event_kind");
  insist(
    hashJson(post) === event.manifestSha256,
    "post_manifest_hash_mismatch",
  );
  ipfsUri(event.manifestURI);
  for (const name of [
    "chainId",
    "postsContract",
    "communityId",
    "postId",
    "authorId",
    "revision",
    "configurationRevision",
  ] as const)
    insist(post[name] === event[name], "post_event_identity_mismatch");
  insist(
    config.chainId === post.chainId &&
      config.postsContract === post.postsContract &&
      config.communityId === post.communityId &&
      config.configurationRevision === post.configurationRevision,
    "post_configuration_mismatch",
  );
  return post;
}

export function quarantined(
  event: PublicationEvent,
  block: bigint,
  history: CommunityConfig[],
  current: CommunityConfig,
) {
  const issued = history.find(
    (c) =>
      c.configurationRevision === event.configurationRevision &&
      c.communityId === event.communityId,
  );
  insist(
    issued &&
      issued.chainId === event.chainId &&
      issued.postsContract === event.postsContract,
    "publication_configuration_missing",
  );
  insist(
    current.chainId === event.chainId &&
      current.communityId === event.communityId &&
      current.postsContract === event.postsContract &&
      current.configurationRevision >= event.configurationRevision,
    "revocation_configuration_mismatch",
  );
  return current.publisherRevocations.some(
    (r) =>
      r.postsContract === event.postsContract &&
      r.publisher === issued.publisher &&
      block >= BigInt(r.fromBlock),
  );
}
