import { createDanceSongResources } from "./dance-song-resources.ts";
import type { Hex } from "viem";
import { bytes32, canonical, exact, hashJson, hashText, insist, object } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { verifyDanceSourceAt } from "../packages/dance-chain/reader.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import { danceOfferId } from "../packages/dance-chain/wire.ts";
import { offerInput, offerView } from "../packages/rewards/offers.ts";
import type { OfferRow } from "../packages/rewards/store.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import type { DanceCapture, DanceFence, DanceOfferSelection } from "../packages/dance/contracts.ts";
import { DANCE_PRIVATE_MEDIA_POLICY, DANCE_VERSION } from "../packages/dance/contracts.ts";
import { danceId, validateFence } from "../packages/dance/validation.ts";
import type { DanceProductionTarget } from "../packages/dance/production.ts";
import { sameDanceTarget } from "../packages/dance/production.ts";
import type { DanceAccountAuthorityFacts } from "./dance-production-authority.ts";
import type { DanceSelectedCatalogue } from "./dance-production.ts";
import { captureProductionTarget } from "./dance-production.ts";
import { readDanceHostContext, hostBody, hostCount, hostRowFence, joinDanceFences, type HostRow } from "./dance-account-facts-store.ts";

export interface DanceSelectedSong {
  version: "pirate.dance-selected-song/1";
  postId: string;
  songRevision: number;
  manifestSha256: string;
  audioSha256: string;
  songDurationSamples: number;
  /** Root's retained actual canonical-audio sample probe; not a readiness flag. */
  probeEvidenceSha256: string;
  startSample: number;
  durationSamples: number;
  reference: (NonNullable<DanceCapture["reference"]> & { resourceId: string }) | null;
  offerProgramId: string | null;
  offer: DanceOfferSelection | null;
}
export interface DanceReferenceAccess {
  (input: { communityId: string; accountId: string; resourceId: string;
    target: DanceProductionTarget; interval: { startSample: number; durationSamples: number };
    reference: NonNullable<DanceCapture["reference"]>; mediaEpoch: number }): Promise<{
      url: string; expiresAt: number; renewAt: number; fence: DanceFence;
    }>;
}

/** Actual selected D1 metadata + canonical publication reader. No index sync,
 * DDL, provider selection, URL cache, reference renderer or admission writer.
 * Root's source3 access callback must check the EXACT selected resource on
 * every grant; an uploader's song/interval is never capture linkage proof. */
export function createDanceSelectedCatalogue(input: {
  db: D1Database; source: DanceCanonicalSource; config: CommunityConfig;
  reads: PublicReadPorts;
  accounts(community: string, actor: string, learner: string): Promise<DanceAccountAuthorityFacts>;
  referenceAccess: DanceReferenceAccess;
}): DanceSelectedCatalogue {
  const { db, source, config, reads } = input, community = source.domain.communityId, store = new DanceStore(db);
  insist(source.domain.chainId === 6343n && config.chainId === 6343 && config.communityId === community &&
    config.postsContract === source.pin.posts && reads.profile.address === source.pin.posts &&
    reads.profile.runtimeCodeHash === source.pin.postsRuntimeHash, "dance_host_source_changed", 503);
  const { songKeyForPost, mapping, selected, publication } = createDanceSongResources(input);
  async function context() {
    const host = await readDanceHostContext(input), c = host.context;
    exact(object(c.consent), ["version", "termsHash", "publicityPolicyHash", "text", "admission"]);
    danceId(c.consent.version);
    insist(["admitted", "review_pending"].includes(c.consent.admission) &&
      hashText(c.rulesDocument) === source.pin.rulesSha256 && hashText(c.rubricText) === source.pin.rubricSha256 &&
      hashText(c.consent.text) === source.pin.termsSha256 && c.consent.termsHash === source.pin.termsSha256 &&
      c.consent.publicityPolicyHash === source.pin.publicityPolicyHash &&
      hashText(c.mediaPolicyDocument) === source.pin.mediaPolicySha256,
      "dance_selected_policy_changed", 409);
    const media = object(JSON.parse(c.mediaPolicyDocument));
    exact(media, ["version", "minSamples", "maxSamples"]);
    insist(canonical(media) === canonical(DANCE_PRIVATE_MEDIA_POLICY), "dance_selected_media_policy_changed", 409);
    return host;
  }
  async function offerFence(songKey: string, s: DanceSelectedSong): Promise<DanceFence> {
    if (!s.offer) return { sql: "1", values: [] }; // Explicit no-offer sentinel from the exact selected row.
    const o = s.offer;
    exact(object(o), ["offerId", "offerIdCommitment", "inputHash", "sourceHash", "opensAtMs", "cutoffAtMs"]);
    insist(o.sourceHash === source.sourceHash && o.offerIdCommitment === danceOfferId(source.domain, o.offerId),
      "dance_offer_binding_mismatch", 409);
    const row = await db.prepare("SELECT * FROM reward_offers WHERE program_id=? AND offer_id=?")
      .bind(s.offerProgramId, o.offerId).first<OfferRow>();
    insist(row && row.state === "open" && row.song_key === songKey && row.input_hash === o.inputHash &&
      hashJson(offerInput(offerView(row))) === row.input_hash && row.opens_at === o.opensAtMs && row.cutoff_at === o.cutoffAtMs &&
      offerView(row).resultSources?.includes(source.sourceHash), "dance_offer_changed", 409);
    return { sql: `EXISTS(SELECT 1 FROM reward_offers WHERE (((((program_id=?)
        AND (offer_id=?))
        AND ((song_key=?)
        AND (state='open')))
        AND (((input_hash=?)
        AND (drawing_id=?))
        AND ((opens_at=?)
        AND (cutoff_at=?))))
        AND ((((purchase_hash=?)
        AND (ticket_ids_json=?))
        AND ((purchase_evidence=?)
        AND (opens_at<=${DANCE_DB_NOW})))
        AND (cutoff_at>${DANCE_DB_NOW}))))`,
      values: [s.offerProgramId, o.offerId, songKey, row.input_hash, row.drawing_id, row.opens_at, row.cutoff_at, row.purchase_hash,
        row.ticket_ids_json, row.purchase_evidence] };
  }
  const captureReference = (s: DanceSelectedSong): DanceCapture["reference"] => s.reference ? {
    id: s.reference.id, revision: s.reference.revision, epoch: s.reference.epoch,
    segmentId: s.reference.segmentId, segmentLayoutSha256: s.reference.segmentLayoutSha256,
  } : null;
  async function referenceEpoch(s: DanceSelectedSong) {
    if (!s.reference) return;
    const rpc = danceReadPort(reads.client), safe = await rpc.safe();
    insist(await rpc.chainId() === 6343, "dance_wrong_chain", 503);
    await verifyDanceSourceAt(danceReadPort(reads.client, safe), source, safe.number);
    const block = { blockHash: safe.hash, requireCanonical: true } as const;
    const [epoch, revision, layout, active] = await reads.client.readContract({ address: source.domain.verifier,
      abi: danceVerdictsAbi, functionName: "references", args: [bytes32(s.reference.id)], ...block });
    const after = await rpc.block(safe.number);
    insist(active && epoch === BigInt(s.reference.epoch) && revision === BigInt(s.reference.revision) &&
      layout === s.reference.segmentLayoutSha256 && after.hash === safe.hash && after.timestamp === safe.timestamp,
      "dance_reference_changed", 409);
  }
  async function facts(accountId: string, songKey: string, referenceId: string | null, offerId: string | null) {
    const host = await context(), account = await input.accounts(community, accountId, accountId);
    const chosen = await selected(songKey, referenceId, offerId);
    const published = await publication(songKey, chosen.song);
    const offer = await offerFence(songKey, chosen.song);
    await referenceEpoch(chosen.song);
    const reference = await currentReference(accountId, chosen.song, host.context.mediaEpoch);
    const fence = joinDanceFences(host.fence, account.fence, chosen.fence, published.fence, offer, ...reference.fences);
    await store.assert([fence]);
    if (reference.lease) checkLease(reference.lease);
    return { host: host.context, account, chosen: chosen.song, title: published.title, fence, referenceLease: reference.lease };
  }
  async function currentReference(accountId: string, s: DanceSelectedSong, mediaEpoch: number) {
    if (!s.reference) return { lease: null, fences: [] as DanceFence[] };
    const lease = await input.referenceAccess({ communityId: community, accountId, resourceId: s.reference.resourceId,
      target: target(songKeyForPost(s.postId), s), interval: { startSample: s.startSample, durationSamples: s.durationSamples },
      reference: captureReference(s)!, mediaEpoch });
    checkLease(lease);
    return { lease, fences: [validateFence(lease.fence), leaseFence(lease)] };
  }
  const target = (songKey: string, s: DanceSelectedSong): DanceProductionTarget => ({ communityId: community,
    songKey, songRevision: s.songRevision, audioSha256: s.audioSha256,
    reference: s.reference ? { id: s.reference.id, revision: s.reference.revision } : null, offerId: s.offer?.offerId ?? null });
  const catalogue: DanceSelectedCatalogue = {
    songKeyForPost,
    async list(id, accountId, songKey, cursor) {
      insist(id === community, "dance_wrong_community", 403);
      const host = await context();
      let after = "";
      if (cursor !== null) {
        const c = object(JSON.parse(cursor)); exact(c, ["communityId", "songKey", "contextRevision", "after"]);
        insist(c.communityId === community && c.songKey === songKey && c.contextRevision === host.row.revision && typeof c.after === "string",
          "dance_catalogue_cursor_changed", 409); after = c.after;
      }
      const rows = await db.prepare(`SELECT reference_id,offer_id FROM dance_host_selections WHERE community_id=? AND song_key=?
        AND (reference_id||char(1)||offer_id)>? ORDER BY reference_id,offer_id LIMIT 21`)
        .bind(community, bytes32(songKey), after).all<{ reference_id: string; offer_id: string }>();
      insist(rows.results.length > 0, "dance_selection_missing", 503);
      const choices = [], fences = [host.fence];
      for (const row of rows.results.slice(0, 20)) {
        const f = await facts(accountId, songKey, row.reference_id || null, row.offer_id || null);
        let playback: "ready" | "unavailable" = "unavailable";
        if (f.referenceLease) playback = "ready";
        choices.push({ ...target(songKey, f.chosen), title: f.title, durationMs: f.chosen.durationSamples / 48,
          playback, recordingAllowed: f.account.actor.active && f.host.consent.admission === "admitted" });
        fences.push(f.fence);
      }
      const fence = joinDanceFences(...fences); await store.assert([fence]);
      const last = rows.results[Math.min(rows.results.length, 20) - 1];
      return { page: { version: "pirate.dance-catalogue/1", communityId: community, accountId, choices,
        consent: host.context.consent, cursor: rows.results.length > 20 ? JSON.stringify({ communityId: community,
          songKey, contextRevision: host.row.revision, after: last.reference_id + String.fromCharCode(1) + last.offer_id }) : null }, fence };
    },
    async select(id, accountId, selection) {
      insist(id === community, "dance_wrong_community", 403);
      const f = await facts(accountId, selection.songKey, selection.referenceId, selection.offerId), s = f.chosen, h = f.host;
      const now = await store.now(), expiresAtMs = Math.min(now + h.captureTtlMs, h.owner.expiresAtMs, s.offer?.cutoffAtMs ?? Number.MAX_SAFE_INTEGER);
      insist(Number.isSafeInteger(expiresAtMs) && expiresAtMs > now && h.consent.admission === "admitted", "dance_capture_admission_held", 409);
      await store.assert([f.fence]);
      return { capture: { version: DANCE_VERSION, communityId: community, learner: f.account.actor,
        songKey: selection.songKey, songRevision: s.songRevision, songDurationSamples: s.songDurationSamples,
        manifestSha256: s.manifestSha256, audioSha256: s.audioSha256, mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
        mediaPolicyHash: source.pin.mediaPolicySha256, reference: captureReference(s), startSample: s.startSample,
        durationSamples: s.durationSamples, policy: "moderator-review-policy-v2", rulesHash: source.pin.rulesSha256,
        termsHash: source.pin.termsSha256, rubricHash: source.pin.rubricSha256, rubricText: h.rubricText,
        offer: s.offer, source: { chainId: 6343, address: source.domain.verifier, runtimeCodeHash: source.pin.runtimeCodeHash,
          fromBlock: source.pin.deploymentBlock.toString(), communityId: community, publisher: source.pin.fixedPublisher,
          policyHash: source.pin.publicityPolicyHash, sourceHash: source.sourceHash }, expiresAtMs,
        expected: { ownerEpoch: h.ownerEpoch, configurationRevision: h.configurationRevision, rulesEpoch: h.rulesEpoch, mediaEpoch: h.mediaEpoch } },
        consentPolicy: h.consent, fence: f.fence };
    },
    async rules(c) {
      insist(c.communityId === community && c.source.sourceHash === source.sourceHash, "dance_host_source_changed", 409);
      const host = await context(), chosen = await selected(c.songKey, c.reference?.id ?? null, c.offer?.offerId ?? null), s = chosen.song, h = host.context;
      insist(sameDanceTarget(captureProductionTarget(c), target(c.songKey, s)) && c.manifestSha256 === s.manifestSha256 &&
        c.songDurationSamples === s.songDurationSamples && c.startSample === s.startSample && c.durationSamples === s.durationSamples &&
        canonical(c.reference) === canonical(captureReference(s)) && canonical(c.offer) === canonical(s.offer) &&
        c.rulesHash === source.pin.rulesSha256 && c.termsHash === source.pin.termsSha256 && c.rubricHash === source.pin.rubricSha256 &&
        c.rubricText === h.rubricText && c.mediaPolicyHash === source.pin.mediaPolicySha256 &&
        canonical(c.expected) === canonical({ ownerEpoch: h.ownerEpoch, configurationRevision: h.configurationRevision,
          rulesEpoch: h.rulesEpoch, mediaEpoch: h.mediaEpoch }), "dance_captured_inputs_changed", 409);
      const published = await publication(c.songKey, s), offer = await offerFence(c.songKey, s); await referenceEpoch(s);
      const reference = await currentReference(c.learner.accountId, s, h.mediaEpoch);
      const fence = joinDanceFences(host.fence, chosen.fence, published.fence, offer, ...reference.fences);
      await store.assert([fence]); if (reference.lease) checkLease(reference.lease); return fence;
    },
    async songPostId(c) { insist(c.communityId === community && c.source.sourceHash === source.sourceHash,
      "dance_host_source_changed", 409); return (await mapping(c.songKey)).postId; },
    async guide(c) {
      await catalogue.rules(c);
      return { communityId: community, songKey: c.songKey, songRevision: c.songRevision, audioSha256: c.audioSha256,
        access: "public", playback_url: config.app.origin + "/api/public/posts/" + (await mapping(c.songKey)).postId + "/audio" };
    },
    async reference(accountId, t) {
      insist(t.communityId === community && t.reference, "dance_reference_missing", 404);
      const f = await facts(accountId, t.songKey, t.reference.id, t.offerId);
      insist(sameDanceTarget(t, target(t.songKey, f.chosen)) && f.chosen.reference, "dance_reference_changed", 409);
      const r = f.referenceLease;
      insist(r, "dance_reference_access_missing", 403);
      checkLease(r); const fence = f.fence; await store.assert([fence]);
      checkLease(r);
      return { grant: { target: t, url: r.url, expiresAt: r.expiresAt, renewAt: r.renewAt }, fence };
    },
  };
  return catalogue;
}
function checkLease(r: { url: string; expiresAt: number; renewAt: number }) {
  const url = new URL(r.url);
  insist(url.protocol === "https:" && !url.username && !url.password && !url.hash &&
    Number.isSafeInteger(r.expiresAt) && Number.isSafeInteger(r.renewAt) && r.renewAt > Date.now() && r.expiresAt > r.renewAt,
    "dance_reference_access_expired", 410);
}
function leaseFence(r: { renewAt: number }): DanceFence {
  return { sql: `${DANCE_DB_NOW}<?`, values: [r.renewAt] };
}
