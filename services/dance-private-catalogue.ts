/** Fresh private practice over the existing selected-song tables and Posts
 * proof. Policy activation is explicit; historical V4 context is never inferred
 * as private V2 policy. No public grant or learning-authority read occurs here. */
import type { Hex } from "viem";
import {
  bytes32,
  canonical,
  exact,
  hashText,
  insist,
  integer,
  object,
} from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import {
  DANCE_PRIVATE_MEDIA_POLICY,
  type DanceConsentPolicy,
  type DanceFence,
} from "../packages/dance/contracts.ts";
import type { PrivateCaptureV2 } from "../packages/dance/capture-v2.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  sameDanceTarget,
  validDanceTarget,
  type DanceProductionTarget,
} from "../packages/dance/production.ts";
import type { OfferRow } from "../packages/rewards/store.ts";
import { offerInput, offerView } from "../packages/rewards/offers.ts";
import { hashJson } from "../packages/community/common.ts";
import type { PublicReadPorts } from "./community-public.ts";
import { hostRowFence, type HostRow } from "./dance-account-facts-store.ts";
import { createDanceSongResources } from "./dance-song-resources.ts";
import type { DancePrivateActor } from "./dance-private-session.ts";
import type {
  DanceReferenceAccess,
  DanceSelectedSong,
} from "./dance-selected-catalogue.ts";

export interface DancePrivatePolicyV2 {
  version: "pirate.dance-private-policy/2";
  configurationRevision: number;
  rulesEpoch: number;
  mediaEpoch: number;
  captureTtlMs: number;
  consent: DanceConsentPolicy;
  rulesDocument: string;
  rubricText: string;
  mediaPolicyDocument: string;
}
type Snapshot = Omit<
  PrivateCaptureV2,
  "captureId" | "captureHash" | "consent" | "reservedAtMs"
>;
const targetOf = (
  c: Pick<
    PrivateCaptureV2,
    | "communityId"
    | "songKey"
    | "songRevision"
    | "audioSha256"
    | "reference"
    | "offer"
  >,
): DanceProductionTarget => ({
  communityId: c.communityId,
  songKey: c.songKey,
  songRevision: c.songRevision,
  audioSha256: c.audioSha256,
  reference: c.reference
    ? { id: c.reference.id, revision: c.reference.revision }
    : null,
  offerId: c.offer?.offerId ?? null,
});

export function createDancePrivateCatalogue(input: {
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
  policy: DancePrivatePolicyV2;
  referenceAccess?: DanceReferenceAccess;
}) {
  const { db } = input,
    config = structuredClone(input.config),
    policy = structuredClone(input.policy),
    store = new DanceStore(db);
  const resources = createDanceSongResources({ ...input, config }),
    community = config.communityId;
  exact(object(policy), [
    "version",
    "configurationRevision",
    "rulesEpoch",
    "mediaEpoch",
    "captureTtlMs",
    "consent",
    "rulesDocument",
    "rubricText",
    "mediaPolicyDocument",
  ]);
  insist(
    policy.version === "pirate.dance-private-policy/2" &&
      policy.configurationRevision === config.configurationRevision,
    "dance_private_policy_changed",
    503,
  );
  integer(policy.configurationRevision, 1, Number.MAX_SAFE_INTEGER);
  integer(policy.rulesEpoch, 0, Number.MAX_SAFE_INTEGER);
  integer(policy.mediaEpoch, 0, Number.MAX_SAFE_INTEGER);
  // Reservation is an upload deadline, distinct from the 48-hour unsubmitted
  // media lifetime and the seven-day accepted review window.
  integer(policy.captureTtlMs, 1, 3600000);
  exact(object(policy.consent), [
    "version",
    "termsHash",
    "publicityPolicyHash",
    "text",
    "admission",
  ]);
  insist(
    policy.consent.admission === "admitted" &&
      !!policy.consent.version &&
      !!policy.rulesDocument &&
      !!policy.rubricText &&
      hashText(policy.consent.text) === policy.consent.termsHash &&
      canonical(JSON.parse(policy.mediaPolicyDocument)) ===
        canonical(DANCE_PRIVATE_MEDIA_POLICY),
    "dance_private_policy_unavailable",
    503,
  );
  bytes32(policy.consent.termsHash);
  bytes32(policy.consent.publicityPolicyHash);
  const policyJson = canonical(policy);
  async function context() {
    const row = await db
      .prepare(
        "SELECT revision,body_json FROM dance_host_context WHERE community_id=?",
      )
      .bind(community)
      .first<HostRow>();
    insist(
      row && canonical(JSON.parse(row.body_json)) === policyJson,
      "dance_private_policy_changed",
      409,
    );
    const configRow = await db
      .prepare(
        "SELECT manifest_json,manifest_sha256 FROM public_configurations WHERE community_id=? AND revision=?",
      )
      .bind(community, config.configurationRevision)
      .first<{ manifest_json: string; manifest_sha256: string }>();
    insist(
      configRow &&
        canonical(JSON.parse(configRow.manifest_json)) === canonical(config) &&
        hashText(configRow.manifest_json) === configRow.manifest_sha256,
      "dance_private_configuration_missing",
      503,
    );
    return [
      hostRowFence("dance_host_context", "community_id=?", [community], row),
      {
        sql: "EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?) AND EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=? AND manifest_json=? AND manifest_sha256=?) AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)",
        values: [
          community,
          config.app.origin,
          community,
          config.configurationRevision,
          configRow.manifest_json,
          configRow.manifest_sha256,
          community,
          config.configurationRevision,
        ],
      } satisfies DanceFence,
    ];
  }
  async function account(actor: DancePrivateActor) {
    const row = await db
      .prepare(
        "SELECT a.created_at account_created,b.created_at binding_created FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND a.author_id=? AND b.binding_id=? AND b.namespace='moss' AND b.network=6343 AND b.subject=?",
      )
      .bind(actor.accountId, actor.authorId, actor.bindingId, actor.wallet)
      .first<{ account_created: number; binding_created: number }>();
    insist(row, "dance_private_account_changed", 403);
    return {
      sql: "EXISTS(SELECT 1 FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND a.author_id=? AND a.created_at=? AND b.binding_id=? AND b.created_at=? AND b.namespace='moss' AND b.network=6343 AND b.subject=?)",
      values: [
        actor.accountId,
        actor.authorId,
        row.account_created,
        actor.bindingId,
        row.binding_created,
        actor.wallet,
      ],
    } satisfies DanceFence;
  }
  async function offer(s: DanceSelectedSong): Promise<DanceFence[]> {
    if (!s.offer) return [];
    const row = await db
      .prepare("SELECT * FROM reward_offers WHERE program_id=? AND offer_id=?")
      .bind(s.offerProgramId, s.offer.offerId)
      .first<OfferRow>();
    insist(
      row &&
        row.state === "open" &&
        row.song_key === resources.songKeyForPost(s.postId) &&
        row.input_hash === s.offer.inputHash &&
        hashJson(offerInput(offerView(row))) === row.input_hash &&
        row.opens_at === s.offer.opensAtMs &&
        row.cutoff_at === s.offer.cutoffAtMs,
      "dance_offer_changed",
      409,
    );
    return [
      {
        sql: `EXISTS(SELECT 1 FROM reward_offers WHERE program_id=? AND offer_id=? AND state='open' AND input_hash=? AND song_key=? AND drawing_id=? AND opens_at=? AND cutoff_at=? AND opens_at<=${DANCE_DB_NOW} AND cutoff_at>${DANCE_DB_NOW})`,
        values: [
          s.offerProgramId,
          row.offer_id,
          row.input_hash,
          row.song_key,
          row.drawing_id,
          row.opens_at,
          row.cutoff_at,
        ],
      },
    ];
  }
  async function select(
    actor: DancePrivateActor,
    target: DanceProductionTarget,
  ) {
    insist(
      validDanceTarget(target) && target.communityId === community,
      "dance_preparation_target_changed",
      409,
    );
    const fences = [...(await context()), await account(actor)];
    const selected = await resources.selected(
        target.songKey,
        target.reference?.id ?? null,
        target.offerId,
      ),
      s = selected.song;
    const reference = s.reference
      ? {
          id: s.reference.id,
          revision: s.reference.revision,
          epoch: s.reference.epoch,
          segmentId: s.reference.segmentId,
          segmentLayoutSha256: s.reference.segmentLayoutSha256,
        }
      : null;
    const actual = {
      communityId: community,
      songKey: resources.songKeyForPost(s.postId),
      songRevision: s.songRevision,
      audioSha256: s.audioSha256,
      reference,
      offer: s.offer,
    };
    insist(
      sameDanceTarget(target, targetOf(actual)),
      "dance_preparation_target_changed",
      409,
    );
    const published = await resources.publication(target.songKey, s);
    fences.push(selected.fence, published.fence, ...(await offer(s)));
    let referenceGrant: {
      target: DanceProductionTarget;
      url: string;
      expiresAt: number;
      renewAt: number;
    } | null = null;
    if (reference) {
      insist(
        input.referenceAccess && s.reference,
        "dance_reference_access_missing",
        503,
      );
      const lease = await input.referenceAccess({
        communityId: community,
        accountId: actor.accountId,
        resourceId: s.reference.resourceId,
        target,
        interval: {
          startSample: s.startSample,
          durationSamples: s.durationSamples,
        },
        reference,
        mediaEpoch: policy.mediaEpoch,
      });
      const url = new URL(lease.url);
      insist(
        url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          Number.isSafeInteger(lease.renewAt) &&
          lease.renewAt > Date.now() &&
          Number.isSafeInteger(lease.expiresAt) &&
          lease.expiresAt > lease.renewAt,
        "dance_reference_access_expired",
        410,
      );
      referenceGrant = {
        target: structuredClone(target),
        url: lease.url,
        expiresAt: lease.expiresAt,
        renewAt: lease.renewAt,
      };
      fences.push(lease.fence, {
        sql: `${DANCE_DB_NOW}<?`,
        values: [lease.renewAt],
      });
    }
    const now = await store.now(),
      expiry = Math.min(
        now + policy.captureTtlMs,
        s.offer?.cutoffAtMs ?? Number.MAX_SAFE_INTEGER,
      );
    const capture: Snapshot = {
      version: "pirate.dance/2",
      ...actual,
      learner: { accountId: actor.accountId, wallet: actor.wallet },
      songDurationSamples: s.songDurationSamples,
      manifestSha256: s.manifestSha256,
      audioSha256: s.audioSha256,
      mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
      mediaPolicyHash: hashText(policy.mediaPolicyDocument),
      reference,
      startSample: s.startSample,
      durationSamples: s.durationSamples,
      policy: "moderator-review-policy-v2",
      rulesHash: hashText(policy.rulesDocument),
      termsHash: policy.consent.termsHash,
      rubricHash: hashText(policy.rubricText),
      rubricText: policy.rubricText,
      expiresAtMs: expiry,
      expected: {
        configurationRevision: policy.configurationRevision,
        rulesEpoch: policy.rulesEpoch,
        mediaEpoch: policy.mediaEpoch,
      },
      publication: { kind: "private" },
      canonical: null,
    };
    await store.assert(fences);
    return {
      capture,
      consentPolicy: structuredClone(policy.consent),
      fences,
      referenceGrant,
      title: published.title,
    };
  }
  async function current(actor: DancePrivateActor, c: PrivateCaptureV2) {
    insist(
      c.publication.kind === "private" &&
        c.learner.accountId === actor.accountId &&
        c.learner.wallet === actor.wallet,
      "dance_private_account_changed",
      403,
    );
    const selected = await select(actor, targetOf(c));
    const {
      captureId: _id,
      captureHash: _hash,
      consent: _consent,
      reservedAtMs: _at,
      expiresAtMs: _expiry,
      ...original
    } = c;
    const { expiresAtMs: _newExpiry, ...fresh } = selected.capture;
    insist(
      canonical(original) === canonical(fresh),
      "dance_captured_inputs_changed",
      409,
    );
    return selected.fences;
  }
  async function mediaAccess(
    actor: { accountId: string },
    c: PrivateCaptureV2,
  ) {
    insist(
      actor.accountId === c.learner.accountId,
      "dance_private_account_changed",
      403,
    );
    const row = await db
      .prepare(
        "SELECT a.author_id,b.binding_id FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND b.namespace='moss' AND b.network=6343 AND b.subject=?",
      )
      .bind(actor.accountId, c.learner.wallet)
      .first<{ author_id: Hex; binding_id: string }>();
    insist(row, "dance_private_account_changed", 403);
    return current(
      {
        accountId: actor.accountId,
        wallet: c.learner.wallet,
        bindingId: row.binding_id,
        authorId: row.author_id,
      },
      c,
    );
  }
  async function list(
    actor: DancePrivateActor,
    songKey: string,
    cursor: string | null,
  ) {
    bytes32(songKey);
    insist(cursor === null, "dance_invalid_cursor", 409);
    const rows = await db
      .prepare(
        "SELECT reference_id,offer_id FROM dance_host_selections WHERE community_id=? AND song_key=? ORDER BY reference_id,offer_id LIMIT 21",
      )
      .bind(community, songKey)
      .all<{ reference_id: string; offer_id: string }>();
    insist(rows.results.length <= 20, "dance_private_catalogue_limit", 503);
    const choices = [],
      fences = await context();
    for (const row of rows.results) {
      const chosen = await resources.selected(
          songKey,
          row.reference_id || null,
          row.offer_id || null,
        ),
        s = chosen.song;
      const target = {
        communityId: community,
        songKey,
        songRevision: s.songRevision,
        audioSha256: s.audioSha256,
        reference: s.reference
          ? { id: s.reference.id, revision: s.reference.revision }
          : null,
        offerId: s.offer?.offerId ?? null,
      };
      const selected = await select(actor, target);
      fences.push(...selected.fences);
      choices.push({
        ...target,
        title: selected.title,
        durationMs: s.durationSamples / 48,
        playback: selected.referenceGrant
          ? ("ready" as const)
          : ("unavailable" as const),
        recordingAllowed: true,
      });
    }
    await store.assert(fences);
    return {
      page: {
        version: "pirate.dance-catalogue/1" as const,
        communityId: community,
        accountId: actor.accountId,
        choices,
        consent: structuredClone(policy.consent),
        owner: false,
        cursor: null,
      },
      fences,
    };
  }
  async function guide(actor: DancePrivateActor, c: PrivateCaptureV2) {
    const fences = await current(actor, c),
      mapping = await resources.mapping(c.songKey);
    await store.assert([...fences, mapping.fence]);
    return {
      communityId: community,
      songKey: c.songKey,
      songRevision: c.songRevision,
      audioSha256: c.audioSha256,
      access: "public" as const,
      playback_url:
        config.app.origin + "/api/public/posts/" + mapping.postId + "/audio",
    };
  }
  async function active(actor: { accountId: string }) {
    const row = await db
      .prepare(
        "SELECT 1 AS active FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND b.namespace='moss' AND b.network=6343",
      )
      .bind(actor.accountId)
      .first();
    return !!row;
  }
  async function publishedSong(songKey: string, revision: number) {
    const row = await db
      .prepare(
        "SELECT reference_id,offer_id FROM dance_host_selections WHERE community_id=? AND song_key=? ORDER BY reference_id,offer_id LIMIT 1",
      )
      .bind(community, bytes32(songKey))
      .first<{ reference_id: string; offer_id: string }>();
    insist(row, "dance_selection_missing", 503);
    const selected = await resources.selected(
        songKey,
        row.reference_id || null,
        row.offer_id || null,
      ),
      s = selected.song;
    insist(revision === s.songRevision, "dance_publication_changed", 409);
    const published = await resources.publication(songKey, s);
    await store.assert([selected.fence, published.fence, ...(await context())]);
    return {
      communityId: community,
      songKey,
      songRevision: revision,
      audioSha256: s.audioSha256.slice(2),
      durationSamples: s.songDurationSamples,
      title: published.title,
    };
  }
  return {
    select,
    current,
    mediaAccess,
    list,
    guide,
    active,
    publishedSong,
    songKeyForPost: resources.songKeyForPost,
  };
}
