import type { PublicClient, Hex } from "viem";
import { insist } from "../packages/community/common.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { verifyDanceSourceAt } from "../packages/dance-chain/reader.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import { canonicalDanceControlBinding } from "../packages/dance-chain/control-command.ts";
import { address } from "../packages/community/manifest-core.ts";
import { bytes32 } from "../packages/community/common.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { DanceCapture, DanceConsentPolicy, DanceFence, DancePorts, DanceSelection } from "../packages/dance/contracts.ts";
import type { DanceCataloguePage, DanceGuideGrant, DanceProductionTarget, DanceReferenceGrant } from "../packages/dance/production.ts";
import { sameDanceTarget, validDanceTarget } from "../packages/dance/production.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { sameCapturedPrincipal, validateAuthority, validateFence } from "../packages/dance/validation.ts";
import { canonicalDanceBindings, storedDanceVerdictJournal } from "./dance-canonical-ports.ts";
import { danceV4AuthorizationPorts } from "./dance-v4-authorization.ts";

/** Selected community metadata/rules producer. Its SQL fence must guard the
 * exact song/revision/reference/offer/config epochs in the accepting D1 batch.
 * No public-feed DTO or current role boolean can supply this historical proof. */
export interface DanceSelectedCatalogue {
  /** Identifier mapping only; list/select still prove publication/admission. */
  songKeyForPost(postId: string): string;
  list(communityId: string, accountId: string, songKey: string, cursor: string | null): Promise<{
    page: Omit<DanceCataloguePage, "owner">; fence: DanceFence;
  }>;
  select(communityId: string, accountId: string, selection: DanceSelection): Promise<{
    capture: Omit<DanceCapture, "captureId" | "consent" | "reservedAtMs" | "captureHash">;
    consentPolicy: DanceConsentPolicy; fence: DanceFence;
  }>;
  rules(capture: DanceCapture): Promise<DanceFence>;
  songPostId(capture: Omit<DanceCapture, "captureHash" | "consent">): Promise<Hex>;
  guide(capture: DanceCapture): Promise<DanceGuideGrant>;
  reference(accountId: string, target: DanceProductionTarget): Promise<{
    grant: DanceReferenceGrant; fence: DanceFence;
  }>;
}

export function withProductionDanceSongKeys(source: DanceCanonicalSource,
  metadata: Omit<DanceSelectedCatalogue, "songKeyForPost">): DanceSelectedCatalogue {
  insist(source.domain.chainId === 6343n, "dance_wrong_chain", 503);
  return { ...metadata, songKeyForPost: postId => songKeyOf({ chainId: Number(source.domain.chainId),
    posts: source.pin.posts, communityId: source.domain.communityId, postId: bytes32(postId) }) };
}

/** Concrete assembly over the admitted hash/reader/V4 helpers. Identity,
 * current authority projection and selected song metadata are REQUIRED host
 * producers; absence cannot create a successful Dance runtime. media is added
 * once by CommunityPrivateDance, using its existing source3 pipeline. */
export function createProductionDancePorts(input: {
  db: D1Database;
  source: DanceCanonicalSource;
  client: PublicClient;
  catalogue: DanceSelectedCatalogue;
  authority: DancePorts["authority"];
  reviewerConsent: DancePorts["reviewerConsent"];
}): Omit<DancePorts, "media"> {
  const store = new DanceStore(input.db), communityId = input.source.domain.communityId;
  const canonical = canonicalDanceBindings({
    source: input.source, rpc: danceReadPort(input.client),
    journal: storedDanceVerdictJournal(input.db, communityId),
    songPostId: c => input.catalogue.songPostId(c),
  });
  return {
    ...canonical,
    ...danceV4AuthorizationPorts(input),
    authority: input.authority,
    async reviewerRoleEpoch(wallet) {
      const rpc = danceReadPort(input.client), safe = await rpc.safe();
      insist(await rpc.chainId() === 6343 && input.source.domain.chainId === 6343n,
        "dance_wrong_chain", 503);
      await verifyDanceSourceAt(danceReadPort(input.client, safe), input.source, safe.number);
      const block = { blockHash: safe.hash, requireCanonical: true } as const;
      const [epoch] = await input.client.readContract({
        address: input.source.domain.verifier, abi: danceVerdictsAbi,
        functionName: "reviewerRoles", args: [address(wallet.toLowerCase())],
        ...block,
      });
      const after = await rpc.block(safe.number);
      insist(after.hash === safe.hash && after.timestamp === safe.timestamp &&
        epoch >= 0n && epoch <= BigInt(Number.MAX_SAFE_INTEGER),
        "dance_authority_anchor_changed", 503);
      return Number(epoch);
    },
    controlBinding: async (intent, caller) => canonicalDanceControlBinding(input.source, intent, caller),
    reviewerConsent: Object.freeze({ ...input.reviewerConsent }),
    rules: c => input.catalogue.rules(c),
    async admitCapture(community, actor, selection) {
      insist(community === communityId, "dance_wrong_community", 403);
      const f = await input.authority(community, actor, actor);
      validateAuthority(f, actor, actor);
      const admitted = await input.catalogue.select(community, actor, selection);
      const c = admitted.capture;
      sameCapturedPrincipal(f.actor, c.learner);
      insist(c.communityId === community && c.songKey === selection.songKey &&
        (c.reference?.id ?? null) === selection.referenceId &&
        (c.offer?.offerId ?? null) === selection.offerId &&
        c.source.sourceHash === input.source.sourceHash &&
        c.expected.ownerEpoch === f.owner.epoch &&
        c.expected.configurationRevision === f.epochs.configurationRevision &&
        c.expected.rulesEpoch === f.epochs.rulesEpoch &&
        c.expected.mediaEpoch === f.epochs.mediaEpoch,
        "dance_capture_binding_mismatch", 409);
      validateFence(admitted.fence);
      await store.assert([f.fence, admitted.fence]);
      return admitted;
    },
  };
}

export function captureProductionTarget(c: DanceCapture): DanceProductionTarget {
  return { communityId: c.communityId, songKey: c.songKey,
    songRevision: c.songRevision, audioSha256: c.audioSha256,
    reference: c.reference ? { id: c.reference.id, revision: c.reference.revision } : null,
    offerId: c.offer?.offerId ?? null };
}
export function requireProductionTarget(value: unknown, communityId: string): DanceProductionTarget {
  insist(validDanceTarget(value) && value.communityId === communityId,
    "dance_preparation_target_changed", 409);
  // Whitelist resource fields; session/account authority never comes from JSON.
  return { communityId: value.communityId, songKey: value.songKey,
    songRevision: value.songRevision, audioSha256: value.audioSha256,
    reference: value.reference ? { ...value.reference } : null, offerId: value.offerId };
}
export function requireSameProductionTarget(c: DanceCapture, target: DanceProductionTarget) {
  insist(sameDanceTarget(captureProductionTarget(c), target), "dance_preparation_target_changed", 409);
}
