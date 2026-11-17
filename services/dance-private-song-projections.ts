/** Fresh private song projections over the EXISTING selected-song tables.
 * No V4 account/owner/alias/publication-grant facts are synthesized or read.
 * The server selects the exact interval/reference/offer; a trusted decoder
 * supplies only the measured canonical-audio duration and receipt. */
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  hashText,
  insist,
  object,
} from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { fetchPublicIpfs } from "../packages/community/ipfs.ts";
import { validatePost } from "../packages/community/post-manifest.ts";
import {
  DANCE_PRIVATE_MEDIA_POLICY,
  type DanceFence,
} from "../packages/dance/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { danceId, validateFence } from "../packages/dance/validation.ts";
import { hostCount, type HostRow } from "./dance-account-facts-store.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DanceSelectedSong } from "./dance-selected-catalogue.ts";
import { createDanceSongResources } from "./dance-song-resources.ts";
import { compactDanceFence } from "./dance-source3-bindings.ts";

export type DancePrivateSongSelection = Omit<
  DanceSelectedSong,
  "songDurationSamples" | "probeEvidenceSha256"
>;
export interface DancePrivateSongProjectionInputs {
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
  /** Exact current configuration/selection admission, captured ONCE per call.
   * Must include genuine D1 predicates for the server-selected facts. */
  current(): Promise<DanceFence[]>;
  /** Trusted actual decoder; called with digest AND CID verified audio bytes. */
  probe(
    bytes: Uint8Array,
  ): Promise<{ sampleRate: 48000; samples: number; receiptBytes: string }>;
}
type ProbeRow = { samples: number; receipt_bytes: string };
type MappingRow = { song_key: string; post_id: string };

function selectionShape(s: DancePrivateSongSelection) {
  exact(object(s), [
    "version",
    "postId",
    "songRevision",
    "manifestSha256",
    "audioSha256",
    "startSample",
    "durationSamples",
    "reference",
    "offerProgramId",
    "offer",
  ]);
  insist(
    s.version === "pirate.dance-selected-song/1",
    "dance_private_song_version",
    409,
  );
  [s.postId, s.manifestSha256, s.audioSha256].forEach(bytes32);
  hostCount(s.songRevision, 1);
  hostCount(s.startSample);
  hostCount(s.durationSamples, 1);
  insist(
    s.durationSamples >= DANCE_PRIVATE_MEDIA_POLICY.minSamples &&
      s.durationSamples <= DANCE_PRIVATE_MEDIA_POLICY.maxSamples &&
      s.durationSamples % 48 === 0 &&
      Number.isSafeInteger(s.startSample + s.durationSamples),
    "dance_interval_invalid",
    409,
  );
  if (s.reference !== null) {
    exact(object(s.reference), [
      "id",
      "revision",
      "epoch",
      "segmentId",
      "segmentLayoutSha256",
      "resourceId",
    ]);
    [
      s.reference.id,
      s.reference.segmentId,
      s.reference.segmentLayoutSha256,
    ].forEach(bytes32);
    hostCount(s.reference.revision, 1);
    hostCount(s.reference.epoch, 1);
    danceId(s.reference.resourceId);
  }
  if (s.offer !== null) {
    exact(object(s.offer), [
      "offerId",
      "offerIdCommitment",
      "inputHash",
      "sourceHash",
      "opensAtMs",
      "cutoffAtMs",
    ]);
    danceId(s.offer.offerId);
    [s.offer.offerIdCommitment, s.offer.inputHash, s.offer.sourceHash].forEach(
      bytes32,
    );
    hostCount(s.offer.opensAtMs, 1);
    hostCount(s.offer.cutoffAtMs, 1);
    insist(
      s.offer.cutoffAtMs > s.offer.opensAtMs &&
        typeof s.offerProgramId === "string" &&
        !!s.offerProgramId,
      "dance_offer_binding_mismatch",
      409,
    );
    danceId(s.offerProgramId);
  } else insist(s.offerProgramId === null, "dance_offer_binding_mismatch", 409);
}

export function createDancePrivateSongProjections(
  input: DancePrivateSongProjectionInputs,
) {
  // Capture caller-owned objects/functions before any asynchronous producer.
  const db = input.db,
    config = structuredClone(input.config),
    reads = Object.freeze({
      ...input.reads,
      profile: structuredClone(input.reads.profile),
    }),
    current = input.current,
    probe = input.probe,
    community = config.communityId,
    store = new DanceStore(db),
    resources = createDanceSongResources({ db, config, reads });
  insist(
    typeof current === "function" && typeof probe === "function",
    "dance_private_song_producer_missing",
    503,
  );

  async function configurationFence(): Promise<DanceFence> {
    const row = await db
      .prepare(
        `SELECT manifest_json,manifest_sha256,publisher,manifest_uri,
      block_number,block_hash,transaction_hash FROM public_configurations WHERE community_id=? AND revision=?`,
      )
      .bind(community, config.configurationRevision)
      .first<{
        manifest_json: string;
        manifest_sha256: string;
        publisher: string;
        manifest_uri: string;
        block_number: string;
        block_hash: string;
        transaction_hash: string;
      }>();
    insist(
      row &&
        canonical(JSON.parse(row.manifest_json)) === canonical(config) &&
        hashText(row.manifest_json) === row.manifest_sha256 &&
        row.publisher === config.publisher,
      "dance_private_song_configuration_missing",
      503,
    );
    return {
      sql: `EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
      AND EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=?
        AND manifest_json=? AND manifest_sha256=? AND publisher=? AND manifest_uri=?
        AND block_number=? AND block_hash=? AND transaction_hash=?)
      AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
      values: [
        community,
        config.app.origin,
        community,
        config.configurationRevision,
        row.manifest_json,
        row.manifest_sha256,
        row.publisher,
        row.manifest_uri,
        row.block_number,
        row.block_hash,
        row.transaction_hash,
        community,
        config.configurationRevision,
      ],
    };
  }
  const compact = (fences: DanceFence[]) =>
    fences.map((f) => compactDanceFence([validateFence(f)]));

  async function selection(
    candidate: DancePrivateSongSelection,
    expectedRevision: number | null,
  ) {
    const selected = structuredClone(candidate);
    selectionShape(selected);
    if (expectedRevision !== null) hostCount(expectedRevision, 1);
    const produced = structuredClone(await current());
    insist(
      Array.isArray(produced) && produced.length > 0,
      "dance_private_song_current_missing",
      503,
    );
    const admission = compact([...produced, await configurationFence()]);
    await store.assert(admission);
    const key = resources.songKeyForPost(selected.postId);
    const source = await db
      .prepare(
        `SELECT manifest_json,manifest_sha256 FROM public_post_revisions
      WHERE community_id=? AND post_id=? AND revision=? AND quarantined=0`,
      )
      .bind(community, selected.postId, selected.songRevision)
      .first<{ manifest_json: string; manifest_sha256: string }>();
    insist(
      source && source.manifest_sha256 === selected.manifestSha256,
      "dance_private_song_publication_missing",
      503,
    );
    const post = validatePost(JSON.parse(source.manifest_json)),
      audio = post.media.filter((m) => m.role === "audio");
    insist(
      post.communityId === community &&
        post.postsContract === config.postsContract &&
        post.postId === selected.postId &&
        post.revision === selected.songRevision &&
        hashJson(post) === selected.manifestSha256 &&
        audio.length === 1 &&
        audio[0].sha256 === selected.audioSha256,
      "dance_private_song_audio_changed",
      409,
    );
    const { bytes } = await fetchPublicIpfs(
      audio[0].uri,
      audio[0].sha256,
      audio[0].byteLength,
      reads.transport,
      reads.contentCache,
    );
    const measured = structuredClone(await probe(bytes.slice()));
    insist(
      measured.sampleRate === 48000 &&
        Number.isSafeInteger(measured.samples) &&
        measured.samples > 0 &&
        typeof measured.receiptBytes === "string" &&
        measured.receiptBytes.length > 0 &&
        measured.receiptBytes.length <= 64 * 1024,
      "dance_private_song_probe_unavailable",
      503,
    );
    insist(
      selected.startSample + selected.durationSamples <= measured.samples,
      "dance_interval_invalid",
      409,
    );
    const receipt = canonical({
      version: "pirate.dance-measured-audio/1",
      audioSha256: selected.audioSha256,
      sampleRate: measured.sampleRate,
      samples: measured.samples,
      producerReceipt: measured.receiptBytes,
    });
    insist(
      receipt.length <= 128 * 1024,
      "dance_private_song_probe_unavailable",
      503,
    );
    const song: DanceSelectedSong = {
      ...selected,
      songDurationSamples: measured.samples,
      probeEvidenceSha256: hashText(receipt),
    };
    // Reuse the complete established Posts receipt/checkpoint/schema proof.
    // It runs before ANY projection write. No placeholder measured fields are
    // passed to the helper, and the raw index alone can never admit a song.
    const published = await resources.publication(key, song);
    const fences = [...admission, ...compact([published.fence])];
    const keys = [
      community,
      key,
      song.reference?.id ?? "",
      song.offer?.offerId ?? "",
    ];
    const selectionWhere =
      "community_id=? AND song_key=? AND reference_id=? AND offer_id=?";
    const probeWhere =
      "community_id=? AND audio_sha256=? AND evidence_sha256=?";
    const probeKeys = [community, song.audioSha256, song.probeEvidenceSha256];
    const body = canonical(song);
    const readSelection = () =>
      db
        .prepare(
          `SELECT revision,body_json FROM dance_host_selections WHERE ${selectionWhere}`,
        )
        .bind(...keys)
        .first<HostRow>();
    const readProbe = () =>
      db
        .prepare(
          `SELECT samples,receipt_bytes FROM dance_host_audio_probes WHERE ${probeWhere}`,
        )
        .bind(...probeKeys)
        .first<ProbeRow>();
    const readMappings = async () =>
      (
        await db
          .prepare(
            `SELECT song_key,post_id FROM dance_host_song_keys
      WHERE community_id=? AND (song_key=? OR post_id=?)`,
          )
          .bind(community, key, song.postId)
          .all<MappingRow>()
      ).results;
    const finalFences = (revision: number): DanceFence[] =>
      compact([
        {
          sql: "EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=? AND song_key=? AND post_id=?)",
          values: [community, key, song.postId],
        },
        {
          sql: `EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE ${probeWhere} AND samples=? AND receipt_bytes=?)`,
          values: [...probeKeys, measured.samples, receipt],
        },
        {
          sql: `EXISTS(SELECT 1 FROM dance_host_selections WHERE ${selectionWhere} AND revision=? AND body_json=?)`,
          values: [...keys, revision, body],
        },
      ]);
    async function exactOutcome() {
      const [saved, savedProbe, mappings] = await Promise.all([
        readSelection(),
        readProbe(),
        readMappings(),
      ]);
      if (
        !saved ||
        saved.body_json !== body ||
        !savedProbe ||
        savedProbe.samples !== measured.samples ||
        savedProbe.receipt_bytes !== receipt ||
        mappings.length !== 1 ||
        mappings[0].song_key !== key ||
        mappings[0].post_id !== song.postId
      )
        return null;
      hostCount(saved.revision, 1);
      return saved;
    }
    const [before, beforeProbe, mappings] = await Promise.all([
      readSelection(),
      readProbe(),
      readMappings(),
    ]);
    insist(
      mappings.length === 0 ||
        (mappings.length === 1 &&
          mappings[0].song_key === key &&
          mappings[0].post_id === song.postId),
      "dance_private_song_mapping_changed",
      409,
    );
    insist(
      !beforeProbe ||
        (beforeProbe.samples === measured.samples &&
          beforeProbe.receipt_bytes === receipt),
      "dance_private_song_probe_changed",
      409,
    );
    if (before?.body_json === body) {
      hostCount(before.revision, 1);
      await store.assert([...fences, ...finalFences(before.revision)]);
      return {
        songKey: key,
        revision: before.revision,
        song: structuredClone(song),
      };
    }
    if (before) hostCount(before.revision, 1);
    insist(
      (before?.revision ?? null) === expectedRevision,
      "dance_private_song_cas_changed",
      409,
    );
    const prestate = compact([
      mappings.length
        ? {
            sql: "EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=? AND song_key=? AND post_id=?)",
            values: [community, key, song.postId],
          }
        : {
            sql: "NOT EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=? AND (song_key=? OR post_id=?))",
            values: [community, key, song.postId],
          },
      beforeProbe
        ? {
            sql: `EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE ${probeWhere} AND samples=? AND receipt_bytes=?)`,
            values: [
              ...probeKeys,
              beforeProbe.samples,
              beforeProbe.receipt_bytes,
            ],
          }
        : {
            sql: `NOT EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE ${probeWhere})`,
            values: probeKeys,
          },
      before
        ? {
            sql: `EXISTS(SELECT 1 FROM dance_host_selections WHERE ${selectionWhere} AND revision=? AND body_json=?)`,
            values: [...keys, before.revision, before.body_json],
          }
        : {
            sql: `NOT EXISTS(SELECT 1 FROM dance_host_selections WHERE ${selectionWhere})`,
            values: keys,
          },
    ]);
    const statements: D1PreparedStatement[] = [];
    if (!mappings.length)
      statements.push(
        db
          .prepare(
            `INSERT INTO dance_host_song_keys
      (community_id,song_key,post_id) VALUES(?,?,?)`,
          )
          .bind(community, key, song.postId),
      );
    if (!beforeProbe)
      statements.push(
        db
          .prepare(
            `INSERT INTO dance_host_audio_probes
      (community_id,audio_sha256,evidence_sha256,samples,receipt_bytes) VALUES(?,?,?,?,?)`,
          )
          .bind(...probeKeys, measured.samples, receipt),
      );
    statements.push(
      before
        ? db
            .prepare(
              `UPDATE dance_host_selections SET revision=revision+1,body_json=?
      WHERE ${selectionWhere} AND revision=? AND body_json=?`,
            )
            .bind(body, ...keys, before.revision, before.body_json)
        : db
            .prepare(
              `INSERT INTO dance_host_selections (community_id,song_key,reference_id,offer_id,revision,body_json)
        VALUES(?,?,?,?,1,?)`,
            )
            .bind(...keys, body),
      store.changed(),
    );
    try {
      await store.atomic([...fences, ...prestate], statements);
    } catch (error) {
      const saved = await exactOutcome();
      if (!saved) throw error;
      // A lost ACK or equal concurrent writer is not fresh admission. Reassert
      // the ORIGINAL fences and all exact persisted bytes; never recapture a
      // newer current() generation, clean up rows or retry the accepting write.
      await store.assert([...fences, ...finalFences(saved.revision)]);
      return {
        songKey: key,
        revision: saved.revision,
        song: structuredClone(song),
      };
    }
    const saved = await exactOutcome();
    insist(saved, "dance_private_song_outcome_unknown", 503);
    return {
      songKey: key,
      revision: saved.revision,
      song: structuredClone(song),
    };
  }
  return { selection };
}
