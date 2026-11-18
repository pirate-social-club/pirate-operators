import type { D1Database } from "@cloudflare/workers-types";
import { exact, hashJson, insist, object } from "./common.ts";
import { web2DanceRewardIntent } from "./web2-dance-reward-attachment.ts";
import {
  nativeCanonical,
  nativeDigest,
  verifyNativeRecord,
} from "./native-business-binding.ts";
import { linuxWeb2DraftFrom } from "../community-setup/linux-web2-profile.ts";
import type { Web2InstallPlan } from "../../deploy/linux/web2-profile-authority.ts";
import type { FullRelease } from "../../deploy/linux/installed-release.ts";
import type {
  SignedRecord,
  TrustAnchor,
} from "../../deploy/linux/installed-records.ts";

export interface Web2NativeOriginal {
  schema: "pirate.web2-native-application-original/1";
  record: SignedRecord<Web2InstallPlan>;
  // The application validates signed identity, not the host filesystem. The
  // installed launcher separately requires and verifies the complete release.
  release: SignedRecord<
    Pick<FullRelease, "schema" | "artifactDigest" | "sourceDigest"> & {
      publishingAttachmentDigest?: `0x${string}`;
      danceRewardIntentSha256?: `0x${string}`;
      graph: Pick<
        FullRelease["graph"],
        "installationId" | "durableScope" | "directoryRuntimeBinding"
      >;
    }
  >;
  trust: TrustAnchor;
  durableScope: string;
}

/** A separately signed app identity. The host still verifies the FULL artifact
 * inventory; never redact a signed body or send that inventory into app D1. */
export function web2ApplicationReleaseBody(
  release: Pick<
    FullRelease,
    "schema" | "artifactDigest" | "sourceDigest" | "graph"
  >,
): Web2NativeOriginal["release"]["body"] {
  const attachment = release.graph.applicationBindings.filter(x => x.name === "WEB2_PUBLISHING_ATTACHMENT_SHA256");
  insist(attachment.length <= 1 && (!attachment.length || (typeof attachment[0]!.text === "string" && /^0x[0-9a-f]{64}$/.test(attachment[0]!.text))),"web2_publishing_attachment_changed",503);
  const reward = release.graph.danceRewardIntent;
  return {
    ...(reward ? { danceRewardIntentSha256: hashJson(web2DanceRewardIntent(reward)) } : {}),
    ...(attachment.length ? {publishingAttachmentDigest:attachment[0]!.text as `0x${string}`} : {}),
    schema: release.schema,
    artifactDigest: release.artifactDigest,
    sourceDigest: release.sourceDigest,
    graph: {
      installationId: release.graph.installationId,
      durableScope: release.graph.durableScope,
      directoryRuntimeBinding: release.graph.directoryRuntimeBinding,
    },
  };
}

/** Only the installed server binding is trusted to supply this public key.
 * A document sent in a request can never select this trust anchor. */
export async function web2NativeOriginal(
  raw: string,
): Promise<Web2NativeOriginal> {
  insist(raw.length <= 1024 ** 2, "web2_native_original_size", 503);
  const input: Web2NativeOriginal = JSON.parse(raw);
  exact(object(input), [
    "schema",
    "record",
    "release",
    "trust",
    "durableScope",
  ]);
  exact(object(input.trust), ["keyId", "spki"]);
  insist(
    input.schema === "pirate.web2-native-application-original/1" &&
      /^[a-f0-9]{64}(?![\s\S])/.test(input.durableScope),
    "explicit_web2_native_original_required",
    503,
  );
  await verifyNativeRecord(input.record, input.trust);
  await verifyNativeRecord(input.release, input.trust);
  const body = input.record.body,
    release = input.release.body;
  exact(object(release), ["schema", "artifactDigest", "sourceDigest", "graph", ...(Object.hasOwn(release,"publishingAttachmentDigest") ? ["publishingAttachmentDigest"] : []),
    ...(Object.hasOwn(release, "danceRewardIntentSha256") ? ["danceRewardIntentSha256"] : [])]);
  exact(object(release.graph), [
    "installationId",
    "durableScope",
    "directoryRuntimeBinding",
  ]);
  exact(object(body), [
    "schema",
    "planId",
    "installationId",
    "durableScope",
    "generation",
    "draft",
    "releaseArtifactDigest",
    "releaseSourceDigest",
    "targetDigest",
    "hostFingerprint",
    "enrollment",
    "registrationAuthority",
    ...(Object.hasOwn(body,"publishingAttachmentDigest") ? ["publishingAttachmentDigest"] : []),
    ...(Object.hasOwn(body, "danceRewardIntentSha256") ? ["danceRewardIntentSha256"] : []),
  ]);
  const draft = linuxWeb2DraftFrom(body.draft);
  insist(
    body.schema === "pirate.linux-web2-install-plan/1" &&
      nativeCanonical(draft) === nativeCanonical(body.draft) &&
      body.planId === "web2-" + draft.enrollment.enrollmentId.slice(2) &&
      Number.isSafeInteger(body.generation) &&
      body.generation > 0 &&
      release.schema === "pirate.complete-linux-web2-release/1" &&
      release.graph.installationId === body.installationId &&
      release.graph.durableScope === input.durableScope &&
      body.durableScope === input.durableScope &&
      body.releaseArtifactDigest === release.artifactDigest &&
      body.releaseSourceDigest === release.sourceDigest &&
      body.publishingAttachmentDigest === release.publishingAttachmentDigest &&
      body.danceRewardIntentSha256 === release.danceRewardIntentSha256 &&
      (!Object.hasOwn(body, "danceRewardIntentSha256") || (typeof body.danceRewardIntentSha256 === "string" &&
        /^0x[0-9a-f]{64}$/.test(body.danceRewardIntentSha256))) &&
      (!Object.hasOwn(body,"publishingAttachmentDigest") || (typeof body.publishingAttachmentDigest === "string" && /^0x[0-9a-f]{64}$/.test(body.publishingAttachmentDigest))) &&
      nativeCanonical(JSON.parse(release.graph.directoryRuntimeBinding)) ===
        nativeCanonical(draft.deployment) &&
      body.enrollment.schema === "pirate.linux-web2-enrollment-evidence/1" &&
      body.enrollment.transactionHash ===
        draft.enrollment.operations.find((op) => op.kind === "registration")
          ?.transactionHash,
    "web2_native_original_binding_changed",
    503,
  );
  return input;
}

/** Same database identity/immutable-original guards as the old initializer.
 * This new schema has no namespace or synthetic historical mapping. */
export async function initializeWeb2NativeOriginal(
  db: D1Database,
  raw: string,
) {
  const original = await web2NativeOriginal(raw),
    draft = original.record.body.draft;
  const digest = nativeDigest(original),
    bytes = nativeCanonical(original);
  await db.batch([
    db
      .prepare(
        `INSERT INTO native_application_original(singleton,original_digest,original_json)
      VALUES(1,?,?) ON CONFLICT(singleton) DO NOTHING`,
      )
      .bind(digest, bytes),
    db
      .prepare(
        `INSERT INTO native_binding_guards(id,valid) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM native_application_original WHERE singleton=1 AND original_digest=? AND original_json=?
    ) THEN 1 ELSE 0 END`,
      )
      .bind(crypto.randomUUID(), digest, bytes),
    db
      .prepare(
        `INSERT INTO application_identity(id,community_id,community_origin) VALUES(1,?,?) ON CONFLICT DO NOTHING`,
      )
      .bind(draft.enrollment.communityId, draft.origin),
    db
      .prepare(
        `INSERT INTO native_binding_guards(id,valid) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?
    ) THEN 1 ELSE 0 END`,
      )
      .bind(crypto.randomUUID(), draft.enrollment.communityId, draft.origin),
  ]);
  return digest;
}
