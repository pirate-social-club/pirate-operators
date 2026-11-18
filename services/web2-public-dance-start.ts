import { bytesToHex, type Address, type Hex } from "viem";
import {
  bytes32,
  canonical,
  hashJson,
  hashText,
  insist,
  integer,
} from "../packages/community/common.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import {
  danceOfferId,
  danceSourceHash,
} from "../packages/dance-chain/v2/wire.ts";
import {
  DANCE_PRIVATE_MEDIA_POLICY,
  type DanceConsentPolicy,
  type DanceFence,
} from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW, DanceStore } from "../packages/dance/store.ts";
import {
  validateConsent,
  validateFence,
} from "../packages/dance/validation.ts";
import { offerInput, offerView } from "../packages/rewards/offers.ts";
import type { OfferRow } from "../packages/rewards/store.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DancePublicationCaptureSelection } from "./dance-publication-capture-start.ts";
import type { DancePublicationSourceV2 } from "./dance-publication-source.ts";
import type { DanceV2OriginalLookup } from "./dance-v2-action-recovery.ts";
import {
  readDanceV2ParticipantBindings,
  verifyDanceV2BindingOriginal,
  type DanceV2BindingOriginal,
} from "./dance-v2-participant-bindings.ts";
import { createDanceSongResources } from "./dance-song-resources.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { publicationSelectionHash } from "./publication-app-selection.ts";
import { assertInstalledRewardDanceSource } from "./web2-installed-dance-song.ts";
import {
  assertInstalledDanceRewardConfiguration,
  installedDanceOfferForSong,
  type InstalledDanceRewards,
} from "./web2-installed-dance-rewards.ts";

/** Alpha assigns the expanded-only migration. No runtime DDL. The attempt
 * stores only a hash and DB clock, with the existing capture deadline. */
export const DANCE_PUBLICATION_STARTS_SCHEMA_PROPOSAL = [
  "CREATE TABLE dance_publication_starts(community_id TEXT NOT NULL, account_id TEXT NOT NULL, command_id TEXT NOT NULL, original_hash TEXT NOT NULL, capture_id TEXT NOT NULL UNIQUE, reserved_at_ms INTEGER NOT NULL CHECK(reserved_at_ms>0), PRIMARY KEY(community_id,account_id,command_id))",
  "CREATE TRIGGER dance_publication_start_no_update BEFORE UPDATE ON dance_publication_starts BEGIN SELECT RAISE(ABORT,'dance_publication_start_immutable'); END",
  "CREATE TRIGGER dance_publication_start_no_delete BEFORE DELETE ON dance_publication_starts BEGIN SELECT RAISE(ABORT,'dance_publication_start_immutable'); END",
  "CREATE TRIGGER dance_publication_start_no_replace BEFORE INSERT ON dance_publication_starts WHEN EXISTS(SELECT 1 FROM dance_publication_starts WHERE (community_id=NEW.community_id AND account_id=NEW.account_id AND command_id=NEW.command_id) OR capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'dance_publication_start_immutable'); END",
] as const;

export interface Web2PublicDanceInputs {
  publication: PublicationApplicationPorts;
  source: DancePublicationSourceV2;
  /** Only the verified native installation may select a signed rewards peer. */
  installedReward?: InstalledDanceRewards;
  publisher: Address;
  owner: { epoch: bigint; wallet: Address };
  /** Separately selected read-only transport to the publisher nonce owner. */
  actionOriginals?: DanceV2OriginalLookup;
  /** Selected only after the two distinct fresh binding commands execute.
   * The consent API runs independently before these originals exist. */
  participants?: {
    pair: Parameters<typeof readDanceV2ParticipantBindings>[0]["participants"];
    originals: readonly [DanceV2BindingOriginal, DanceV2BindingOriginal];
    /** Exact retained private app account, alias and grant predicates from
     * the installed authority. The accepting batch consumes them again. */
    privateOriginalFences: (
      pair: Parameters<
        typeof readDanceV2ParticipantBindings
      >[0]["participants"],
    ) => Promise<readonly DanceFence[]>;
  };
  policy: {
    rules: string;
    terms: string;
    rubric: string;
    media: string;
    consentVersion: string;
    captureTtlMs: number;
  };
}

interface OriginalStart {
  original_hash: Hex;
  capture_id: Hex;
  reserved_at_ms: number;
}

/** Producer for the normal no-reference song entry. Every retry proves the
 * same original scope/resources, while the frozen DB start survives safe lag. */
export function web2PublicDanceStart(
  input: Web2PublicDanceInputs,
  config: Web2CommunityConfig,
  reads: PublicReadPorts,
): DancePublicationCaptureSelection {
  const { db, installation, catalog, client } = input.publication;
  const installed = input.installedReward;
  const clock = { ...input.publication.clock };
  const { source, publisher, owner, policy } = structuredClone({
    source: input.source,
    publisher: input.publisher,
    owner: input.owner,
    policy: input.policy,
  });
  const release = catalog.fresh();
  const releaseHash = publicationSelectionHash(release);
  const configJson = canonical(config);
  const community = config.communityId;
  const ttl = integer(policy.captureTtlMs, 1, 3600000);
  if (installed) {
    assertInstalledDanceRewardConfiguration(installed, config);
    assertInstalledRewardDanceSource(installed, source);
  }
  insist(
    installation?.db === db &&
      installation.catalog === catalog &&
      canonical(release.configuration) === configJson &&
      source.domain.communityId === community &&
      source.domain.chainId === 6343n &&
      source.sourceHash === danceSourceHash(source.domain, source.pin) &&
      publisher === config.publisher &&
      reads.profile.runtimeCodeHash === source.pin.postsRuntimeHash &&
      hashText(policy.rules) === source.pin.rulesSha256 &&
      hashText(policy.terms) === source.pin.termsSha256 &&
      hashText(policy.rubric) === source.pin.rubricSha256 &&
      hashText(policy.media) === source.pin.mediaPolicySha256,
    "dance_publication_source_changed",
    503,
  );
  const profile = parseWeb2ProfileDocument(release.profile);
  const resources = createDanceSongResources({ db, config, reads });
  const store = new DanceStore(db);
  const consent: DanceConsentPolicy = Object.freeze({
    admission: "admitted",
    version: policy.consentVersion,
    termsHash: source.pin.termsSha256,
    publicityPolicyHash: source.pin.publicityPolicyHash,
    text: policy.terms,
  });
  const configuration: DanceFence = {
    sql: "EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=? AND manifest_json=? AND manifest_sha256=?) AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)",
    values: [
      community,
      config.configurationRevision,
      configJson,
      hashText(configJson),
      community,
      config.configurationRevision,
    ],
  };

  return {
    source,
    publisher,
    owner,
    async retainStart({
      actor,
      request,
      requestHash,
      grantId,
      authorization,
      source: requestedSource,
    }) {
      const target = request.target;
      insist(
        target.communityId === community &&
          target.reference === null &&
          requestedSource.sourceHash === source.sourceHash &&
          danceSourceHash(requestedSource.domain, requestedSource.pin) ===
            source.sourceHash,
        "dance_publication_target_changed",
        409,
      );
      if (installed && target.offerId !== null)
        insist(target.offerId === installed.offerId, "dance_reward_offer_changed", 409);
      validateConsent(request.consent, consent);
      const predicates: DanceFence[] = [authorization, configuration];
      const afterAwait = () => store.assert(predicates);
      await afterAwait();
      const selected = await resources.selected(
        target.songKey,
        null,
        target.offerId,
      );
      const s = selected.song;
      insist(
        s.songRevision === target.songRevision &&
          s.audioSha256 === target.audioSha256,
        "dance_preparation_target_changed",
        409,
      );
      const publication = await resources.publication(target.songKey, s);
      predicates.push(selected.fence, publication.fence);
      if (s.offer) {
        const o = s.offer;
        if (installed) {
          const retained = await installedDanceOfferForSong(db, installed, target.songKey, await store.now());
          insist(retained && retained.offerProgramId === s.offerProgramId &&
            canonical(retained.offer) === canonical(o), "dance_reward_offer_changed", 409);
        }
        const row = await db
          .prepare(
            "SELECT * FROM reward_offers WHERE program_id=? AND offer_id=?",
          )
          .bind(s.offerProgramId, o.offerId)
          .first<OfferRow>();
        insist(
          row &&
            row.state === "open" &&
            row.song_key === target.songKey &&
            row.input_hash === o.inputHash &&
            hashJson(offerInput(offerView(row))) === row.input_hash &&
            offerView(row).resultSources?.includes(source.sourceHash) &&
            o.offerIdCommitment === danceOfferId(source.domain, o.offerId) &&
            o.sourceHash === source.sourceHash &&
            row.opens_at === o.opensAtMs &&
            row.cutoff_at === o.cutoffAtMs,
          "dance_offer_changed",
          409,
        );
        predicates.push({
          sql: `EXISTS(SELECT 1 FROM reward_offers WHERE program_id=? AND offer_id=? AND song_key=? AND input_hash=?
          AND drawing_id=? AND purchase_hash=? AND ticket_ids_json=? AND purchase_evidence=? AND state='open'
          AND opens_at=? AND opens_at<=${DANCE_DB_NOW} AND cutoff_at=? AND cutoff_at>${DANCE_DB_NOW})`,
          values: [
            s.offerProgramId,
            o.offerId,
            target.songKey,
            row.input_hash,
            row.drawing_id,
            row.purchase_hash,
            row.ticket_ids_json,
            row.purchase_evidence,
            o.opensAtMs,
            o.cutoffAtMs,
          ],
        });
      }
      const participants = input.participants;
      insist(participants, "dance_publication_identity_unavailable", 503);
      const { pair, originals } = structuredClone({
        pair: participants.pair,
        originals: participants.originals,
      });
      insist(
        pair[0].accountId === actor.accountId &&
          pair[0].wallet === actor.wallet &&
          pair[0].grantId === grantId &&
          originals[0].hash !== originals[1].hash &&
          originals.every(
            (original, index) =>
              original.plan.accountId === pair[index]!.accountId &&
              original.plan.wallet === pair[index]!.wallet,
          ),
        "dance_publication_participants_changed",
        403,
      );
      const originalFences = (
        await participants.privateOriginalFences(structuredClone(pair))
      ).map(validateFence);
      insist(
        originalFences.length > 0,
        "dance_publication_fences_missing",
        503,
      );
      predicates.push(...originalFences);
      await afterAwait();
      for (const original of originals) {
        await verifyDanceV2BindingOriginal({ client, source, original });
        await afterAwait();
      }
      const proof = await readDanceV2ParticipantBindings({
        client,
        selected: source,
        config,
        profile,
        caller: publisher,
        owner,
        clock,
        participants: pair,
        afterAwait,
        async verifyPrivateOriginals(expected) {
          insist(
            canonical(expected) === canonical(pair),
            "dance_publication_participants_changed",
            409,
          );
          await afterAwait();
        },
      });
      const { identityEpoch, groupId, groupEpoch } = proof.participants[0];
      const identity = { identityEpoch, groupId, groupEpoch };
      const snapshot = {
        version: "pirate.dance/2" as const,
        communityId: community,
        learner: { accountId: actor.accountId, wallet: actor.wallet },
        songKey: target.songKey,
        songRevision: s.songRevision,
        songDurationSamples: s.songDurationSamples,
        manifestSha256: s.manifestSha256,
        audioSha256: s.audioSha256,
        mediaPolicyVersion: DANCE_PRIVATE_MEDIA_POLICY.version,
        mediaPolicyHash: source.pin.mediaPolicySha256,
        reference: null,
        startSample: s.startSample,
        durationSamples: s.durationSamples,
        policy: "moderator-review-policy-v2" as const,
        rulesHash: source.pin.rulesSha256,
        termsHash: source.pin.termsSha256,
        rubricHash: source.pin.rubricSha256,
        rubricText: policy.rubric,
        offer: s.offer,
        expected: {
          ownerEpoch: String(owner.epoch),
          configurationRevision: String(config.configurationRevision),
          rulesEpoch: "0",
          mediaEpoch: "0",
        },
      };
      const originalHash = hashJson({
        schema: "pirate.dance-publication-start/1",
        releaseHash,
        requestHash,
        sourceHash: source.sourceHash,
        postId: s.postId,
        ttl,
        snapshot,
        subject: actor,
        groupId,
        identityEpoch: String(identityEpoch),
        groupEpoch: String(groupEpoch),
      });
      const key = [community, actor.accountId, request.commandId];
      const read = () =>
        db
          .prepare(
            `SELECT original_hash,capture_id,reserved_at_ms
           FROM dance_publication_starts WHERE community_id=? AND account_id=? AND command_id=?`,
          )
          .bind(...key)
          .first<OriginalStart>();
      let original = await read();
      if (!original) {
        // The time is read by the accepting batch and is never a client clock,
        // grant timestamp or safe block timestamp.
        const captureId = bytesToHex(
          crypto.getRandomValues(new Uint8Array(32)),
        );
        try {
          await store.atomic(predicates, [
            db
              .prepare(
                `INSERT INTO dance_publication_starts
            SELECT ?,?,?,?,?,${DANCE_DB_NOW} WHERE NOT EXISTS(SELECT 1 FROM dance_publication_starts
              WHERE community_id=? AND account_id=? AND command_id=?)`,
              )
              .bind(...key, originalHash, captureId, ...key),
          ]);
        } catch (error) {
          if (!(await read())) throw error;
        }
        original = await read();
      }
      insist(
        original && original.original_hash === originalHash,
        "dance_idempotency_conflict",
        409,
      );
      const reservedAtMs = integer(
        original.reserved_at_ms,
        1,
        Number.MAX_SAFE_INTEGER - ttl,
      );
      const expiresAtMs = reservedAtMs + ttl;
      const captureId = bytes32(original.capture_id);
      predicates.push({
        sql: `EXISTS(SELECT 1 FROM dance_publication_starts WHERE community_id=? AND account_id=? AND command_id=?
          AND original_hash=? AND capture_id=? AND reserved_at_ms=?) AND ${DANCE_DB_NOW}<?`,
        values: [...key, originalHash, captureId, reservedAtMs, expiresAtMs],
      });
      await afterAwait();
      return {
        snapshot: { ...snapshot, captureId, reservedAtMs, expiresAtMs },
        postId: bytes32(s.postId),
        identity,
        consent,
        fences: predicates,
      };
    },
  };
}
