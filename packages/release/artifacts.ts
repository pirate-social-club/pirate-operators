import { canonical, insist, hashJson } from "../community/common.ts";
import { preparePin, type PinIntent } from "../community/ipfs.ts";
import {
  ABSENT_REGISTRATION,
  validatePost,
  validateRegistration,
  type AbsentRegistration,
  type RegistrationReceipt,
} from "../community/post-manifest.ts";
import {
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
} from "../community/manifest-core.ts";
import { ownerCurated } from "../community/owner-policy.ts";
import type { AdmittedRelease } from "./authority.ts";
import type { RetainedPin } from "./pin-operations.ts";

export const releaseRoles = [
  "audio",
  "lyrics",
  "ip_metadata",
  "nft_metadata",
  "post_manifest",
] as const;
export type ReleaseRole = (typeof releaseRoles)[number];
export const pinOperationId = (grantHash: string, role: ReleaseRole) =>
  hashJson({ grantHash, role });
export async function retainedArtifact(
  db: D1Database,
  grantHash: string,
  role: ReleaseRole,
): Promise<RetainedPin> {
  const row = await db
    .prepare(
      "SELECT result_json FROM funded_pins WHERE operation_id=? AND state='confirmed'",
    )
    .bind(pinOperationId(grantHash, role))
    .first<{ result_json: string }>();
  insist(row, "release_dependency_not_ready", 409);
  return JSON.parse(row.result_json) as RetainedPin;
}
const encode = (value: unknown) => new TextEncoder().encode(canonical(value));
export async function releaseArtifact(
  db: D1Database,
  media: {
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  },
  release: AdmittedRelease,
  role: ReleaseRole,
): Promise<{ bytes: Uint8Array; intent: PinIntent }> {
  const { context, grant, config, prepared } = release;
  let bytes: Uint8Array;
  if (role === "audio") {
    const object = await media.get(
      `admissions/${release.sourceAdmissionId ?? context.admissionId}/audio`,
    );
    insist(object, "retained_release_audio_missing", 503);
    bytes = new Uint8Array(await object.arrayBuffer());
  } else if (role === "lyrics") bytes = encode(context.lyrics);
  else if (release.unregistered && role !== "post_manifest")
    insist(false, "registration_artifact_not_applicable", 409);
  else {
    const audio = await retainedArtifact(db, grant.sha256, "audio");
    const identity = {
      chainId: 6343,
      postsContract: config.postsContract,
      communityId: config.communityId,
      postId: context.postId,
      authorId: context.authorId,
    };
    const common = {
      schema_version: "pirate-community-data-metadata/1",
      title: prepared.title,
      createdAt: String(release.createdAt),
      creators: [
        {
          name: context.authorId,
          address: context.recipient,
          contributionPercent: 100,
        },
      ],
      external_url: config.app.origin + "/",
      ...identity,
    };
    if (role === "ip_metadata")
      bytes = encode({
        ...common,
        description: "Public song released by this community.",
        mediaUrl: audio.uri,
        mediaHash: audio.sha256,
        mediaType: "audio/mpeg",
        lyrics: prepared.lyrics,
        lineage: { kind: "root" },
      });
    else if (role === "nft_metadata")
      bytes = encode({
        ...common,
        name: prepared.title,
        description: "Community song asset.",
        animation_url: audio.uri,
        attributes: [{ trait_type: "Lineage", value: "root" }],
      });
    else {
      const lyrics = await retainedArtifact(db, grant.sha256, "lyrics");
      let registration: RegistrationReceipt | AbsentRegistration;
      if (release.unregistered) registration = { ...ABSENT_REGISTRATION };
      else {
        const row = await db
          .prepare(
            "SELECT result_json FROM funded_registrations WHERE grant_hash=? AND state='confirmed'",
          )
          .bind(grant.sha256)
          .first<{ result_json: string }>();
        insist(row, "release_registration_not_ready", 409);
        const receipt = validateRegistration(JSON.parse(row.result_json));
        insist(
          receipt.recipient === context.recipient &&
            receipt.contentSha256 === grant.contentSha256,
          "release_registration_mismatch",
          503,
        );
        registration = receipt;
      }
      bytes = encode(
        validatePost({
          schema: release.unregistered
            ? "pirate.community-post/3"
            : ownerCurated(config.policies.admission)
              ? "pirate.community-post/2"
              : "pirate.community-post/1",
          ...identity,
          kind: "song",
          revision: 1,
          configurationRevision: config.configurationRevision,
          publishedAt: release.createdAt,
          title: prepared.title,
          language: context.lyrics.language,
          rating: release.decision.rating === "adult_18" ? "adult" : "general",
          media: [
            { role: "audio", ...audio },
            { role: "lyrics", ...lyrics },
          ].map(({ role, uri, sha256, byteLength, mediaType }) => ({
            role,
            uri,
            sha256,
            byteLength,
            mediaType,
          })),
          admission: {
            policyVersion: config.policies.admission.version,
            policySha256: config.policies.admission.sha256,
            decision: "publish",
            rating:
              release.decision.rating === "adult_18" ? "adult" : "general",
            coverDisplayed: false,
            evidenceSha256: release.evidenceSha256,
            ...(release.unregistered || ownerCurated(config.policies.admission)
              ? {
                  automatedContent: "deferred",
                  declarationSource: "operator_declared",
                }
              : {}),
          },
          registration,
        }),
      );
    }
  }
  const intent = await preparePin(
    bytes,
    role === "audio" ? "audio/mpeg" : "application/json",
  );
  if (role === "audio")
    insist(
      intent.sha256 === grant.contentSha256,
      "retained_release_audio_changed",
      503,
    );
  return { bytes, intent };
}
