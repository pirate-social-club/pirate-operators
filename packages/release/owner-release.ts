import {
  bytes32,
  canonical,
  CommunityError,
  exact,
  hashJson,
  insist,
  jsonBody,
  object,
  text,
} from "../community/common.ts";
import { address } from "../community/manifest-core.ts";
import { validateLyrics } from "../community/lyric-manifest.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import {
  unregisteredOwner,
  UNREGISTERED_OWNER_POLICY,
} from "../community/owner-policy.ts";
import { selectedAdmission } from "../moderation/curated-admission.ts";
import { verifyAdmission } from "../moderation/admission.ts";
import type { PreparedAdmission } from "../moderation/prepare-admission.ts";
import type { EvidenceRecord } from "../moderation/evidence.ts";
import type { AdmissionMedia } from "../moderation/prepare-admission.ts";
import {
  authorizeServiceRequest,
  type ManagedPairing,
} from "../moderation/pairing.ts";
import type { IpfsTransport } from "../community/ipfs.ts";
import type { AdmittedRelease, ReleaseContext } from "./authority.ts";
import { fundedPin } from "./pin-operations.ts";
import {
  pinOperationId,
  releaseArtifact,
  type ReleaseRole,
} from "./artifacts.ts";
import {
  claimOwnerWindow,
  ownerBudgetKey,
  reserveOwnerBudget,
  settleOwnerBudget,
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "./owner-grant.ts";

/** Roles an unregistered owner release pins. No registration metadata exists. */
export const ownerReleaseRoles = ["audio", "lyrics", "post_manifest"] as const;
/** Per-job release key: the existing per-release pin and artifact tables key on it. */
export const ownerReleaseKey = (grant: OwnerBudgetGrant, jobId: string) =>
  hashJson({ owner: ownerBudgetKey(grant, "songs").scope, jobId });

/** The grant must describe this community, policy and MegaETH destination. */
export function requireOwnerGrantScope(
  grant: OwnerBudgetGrant,
  config: CommunityConfig,
) {
  insist(
    unregisteredOwner(config.policies.admission) &&
      grant.communityId === config.communityId &&
      grant.communityOrigin === config.app.origin &&
      grant.policy.version === config.policies.admission.version &&
      grant.policy.sha256 === config.policies.admission.sha256 &&
      grant.destination.chainId === config.chainId &&
      grant.destination.postsContract === config.postsContract &&
      grant.destination.publisher === config.publisher,
    "owner_grant_scope_mismatch",
    403,
  );
}

function ownerContext(value: unknown): ReleaseContext {
  const o = object(value);
  exact(o, [
    "jobId",
    "admissionId",
    "postId",
    "authorId",
    "recipient",
    "lineage",
    "lyrics",
    "rating",
  ]);
  insist(o.lineage === "root", "derivative_registration_requires_parent", 409);
  insist(o.rating === "general" || o.rating === "adult", "invalid_rating");
  const context: ReleaseContext = {
    jobId: text(o.jobId, 128),
    admissionId: bytes32(o.admissionId),
    postId: bytes32(o.postId),
    authorId: bytes32(o.authorId),
    recipient: address(o.recipient),
    lineage: "root",
    lyrics: validateLyrics(o.lyrics),
    rating: o.rating,
  };
  insist(
    /^[A-Za-z0-9:_-]{1,128}$/.test(context.jobId),
    "invalid_release_identity",
    400,
  );
  return context;
}

/**
 * Admits one owner release under the bounded owner grant. In execute mode it
 * claims the window and reserves one song before any pin can spend. In
 * reconcile mode it never reserves and returns null for an unknown job.
 */
export async function establishOwnerRelease(
  db: D1Database,
  input: unknown,
  grant: OwnerBudgetGrant,
  config: CommunityConfig,
  providerEndpoint: string,
  now = Math.floor(Date.now() / 1000),
  mode: "execute" | "reconcile" = "execute",
): Promise<AdmittedRelease | null> {
  requireOwnerGrantScope(grant, config);
  const context = ownerContext(input);
  insist(
    context.recipient === grant.ownerWallet,
    "owner_release_recipient_mismatch",
    403,
  );
  insist(
    context.lyrics.communityId === config.communityId &&
      context.lyrics.postsContract === config.postsContract &&
      context.lyrics.chainId === config.chainId &&
      context.lyrics.postId === context.postId,
    "release_lyrics_identity_mismatch",
    409,
  );
  const key = ownerReleaseKey(grant, context.jobId),
    scope = ownerBudgetKey(grant, "songs").scope;
  const prior = await db
    .prepare("SELECT * FROM owner_releases WHERE job_id=?")
    .bind(context.jobId)
    .first<{
      release_key: string;
      request_hash: string;
      context_json: string;
      admission_sha256: string;
      created_at: number;
    }>();
  if (mode === "reconcile" && !prior) return null;
  const { admission } = await selectedAdmission(
    db,
    context.admissionId,
    config,
  );
  insist(
    admission.job_id === context.jobId &&
      admission.state === "complete" &&
      admission.prepared_json &&
      admission.result_json,
    "release_admission_unavailable",
    409,
  );
  const prepared = JSON.parse(admission.prepared_json!) as PreparedAdmission,
    result = object(JSON.parse(admission.result_json!)),
    request = object(JSON.parse(admission.request_json)),
    declared = object(request.declared);
  insist(
    result.schema === "pirate.owner-recognition/1" &&
      prepared.lyrics === context.lyrics.sourceText,
    "release_content_mismatch",
    409,
  );
  const contentSha256 = bytes32(declared.songSha256);
  const decision = await verifyAdmission(
    {
      communityId: config.communityId,
      submissionId: admission.submission_id,
      jobId: context.jobId,
      songSha256: contentSha256,
      songByteLength: object(object(request.inputs).song).byteLength as number,
      title: prepared.title,
      lyrics: prepared.lyrics,
      songType: "original",
      declaredRating: context.rating === "adult" ? "adult_18" : "general",
      windows: prepared.windows.map(
        ({ objectKey, byteLength, ...window }) => window,
      ),
      providerEndpoint,
    },
    result.evidence as EvidenceRecord[],
    {
      operators: [config.policies.moderationSigner],
      maxAgeSeconds: UNREGISTERED_OWNER_POLICY.recognition.maximumAgeSeconds,
      policyVersion: config.policies.admission.version,
    },
    mode === "reconcile" ? prior!.created_at : now,
  );
  insist(
    decision.decision === "publish",
    decision.decision === "block" ? "release_rejected" : "release_held",
    409,
  );
  // Not keyed by grant hash: a replacement grant in the same window replays.
  const requestHash = hashJson({
      context,
      scope,
      period: ownerBudgetKey(grant, "songs").period,
      configuration: hashJson(config),
    }),
    evidenceSha256 = hashJson(result);
  if (mode === "execute") {
    await claimOwnerWindow(db, grant, now);
    await reserveOwnerBudget(
      db,
      grant,
      "songs",
      `owner-song:${context.jobId}`,
      requestHash,
      "1",
      now,
    );
    await db
      .prepare(
        "INSERT INTO owner_releases(job_id,release_key,owner_scope,request_hash,context_json,admission_sha256,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .bind(
        context.jobId,
        key,
        scope,
        requestHash,
        canonical(context),
        evidenceSha256,
        now,
      )
      .run();
  }
  const saved = await db
    .prepare("SELECT * FROM owner_releases WHERE job_id=?")
    .bind(context.jobId)
    .first<{
      release_key: string;
      request_hash: string;
      context_json: string;
      admission_sha256: string;
      created_at: number;
    }>();
  insist(
    saved?.release_key === key &&
      saved.request_hash === requestHash &&
      saved.context_json === canonical(context) &&
      saved.admission_sha256 === evidenceSha256,
    "owner_release_already_bound",
    409,
  );
  return {
    context,
    grant: { sha256: key, contentSha256 },
    unregistered: true,
    config,
    prepared,
    decision,
    evidenceSha256,
    createdAt: saved.created_at,
    sourceAdmissionId: context.admissionId,
  };
}

export interface OwnerReleaseService {
  origin: string;
  ownerGrant: unknown;
  pairings: ManagedPairing[];
  currentConfiguration(pairing: ManagedPairing): Promise<CommunityConfig>;
  filebaseCredential: string;
  acrEndpoint: string;
  pinTransport?: IpfsTransport;
}
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

/**
 * Owner-policy release operations: pins only. There is no registration route,
 * registration signer, registration client or Aeneid dependency.
 */
export async function ownerReleaseFetch(
  request: Request,
  db: D1Database,
  media: AdmissionMedia,
  service: OwnerReleaseService,
) {
  try {
    const url = new URL(request.url),
      routes = {
        "/v1/releases/pin": { action: "release_pin", mode: "execute" },
        "/v1/releases/pin/status": {
          action: "release_pin_status",
          mode: "reconcile",
        },
      } as const;
    const route = routes[url.pathname as keyof typeof routes];
    insist(
      url.origin === service.origin &&
        request.method === "POST" &&
        route &&
        !url.search,
      "not_found",
      404,
    );
    const { body, current, pairing, authorization } =
      await authorizeServiceRequest(
        db,
        await jsonBody(request),
        route.action,
        service.origin,
        service.pairings,
        service.currentConfiguration,
      );
    exact(body, ["context", "role"]);
    const grant = validateOwnerGrant(service.ownerGrant);
    requireOwnerGrantScope(grant, current);
    const capturedConfig = hashJson(current),
      capturedPairing = hashJson(pairing);
    const authorizePurchase = async () => {
      const fresh = await service.currentConfiguration(pairing),
        active = service.pairings.find(
          (p) => p.communityId === pairing.communityId,
        );
      insist(
        active?.enabled && hashJson(active) === capturedPairing,
        "managed_pairing_changed",
        403,
      );
      insist(
        hashJson(fresh) === capturedConfig,
        "community_authority_changed",
        403,
      );
      const now = Math.floor(Date.now() / 1000);
      insist(
        grant.expiresAt > now && authorization.expiresAt > now,
        "owner_grant_outside_window",
        403,
      );
    };
    const pinTransport: IpfsTransport = async (request) => {
      if (new URL(request.url).pathname === "/api/v0/add")
        await authorizePurchase();
      return service.pinTransport
        ? service.pinTransport(request)
        : fetch(request);
    };
    const release = await establishOwnerRelease(
      db,
      body.context,
      grant,
      current,
      service.acrEndpoint,
      Math.floor(Date.now() / 1000),
      route.mode,
    );
    if (!release) return reply({ state: "absent" }, 404);
    const role = text(body.role, 32) as ReleaseRole;
    insist(
      (ownerReleaseRoles as readonly string[]).includes(role),
      "unsupported_release_artifact",
      400,
    );
    const artifact = await releaseArtifact(db, media, release, role);
    const operationId = pinOperationId(release.grant.sha256, role),
      reservation = hashJson({ operationId, intent: artifact.intent });
    if (route.mode === "execute") {
      await reserveOwnerBudget(
        db,
        grant,
        "pin_adds",
        `${operationId}:adds`,
        reservation,
        "1",
      );
      await reserveOwnerBudget(
        db,
        grant,
        "pin_bytes",
        `${operationId}:bytes`,
        reservation,
        String(artifact.bytes.length),
      );
    }
    const result = await fundedPin(
      db,
      operationId,
      {
        sha256: release.grant.sha256,
        period: ownerBudgetKey(grant, "songs").period,
        maximumAdds: 5,
      },
      artifact.intent,
      artifact.bytes,
      service.filebaseCredential,
      pinTransport,
      route.mode,
    );
    if (result.state === "confirmed") {
      // Settlement needs only the reservation, so it also works after expiry.
      const settled = await db
        .prepare(
          "SELECT status FROM spending_reservations WHERE reservation_id=? AND asset='pin_bytes'",
        )
        .bind(`${operationId}:bytes`)
        .first<{ status: string }>();
      if (settled?.status === "reserved") {
        await settleOwnerBudget(
          db,
          grant,
          "pin_adds",
          `${operationId}:adds`,
          "1",
        );
        await settleOwnerBudget(
          db,
          grant,
          "pin_bytes",
          `${operationId}:bytes`,
          String(artifact.bytes.length),
        );
      }
    }
    return reply(
      {
        schema: "pirate.managed-release-operation/1",
        operationId,
        grantSha256: grant.sha256,
        result,
      },
      result.state === "confirmed"
        ? 200
        : result.state === "absent"
          ? 404
          : 202,
    );
  } catch (error) {
    return reply(
      {
        error:
          error instanceof CommunityError
            ? error.code
            : "release_service_unavailable",
      },
      error instanceof CommunityError ? error.status : 503,
    );
  }
}
