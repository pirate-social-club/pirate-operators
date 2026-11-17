/** Shared canonical song/resource proof used by historical and fresh private Dance.
 * Reads actual Posts receipts/index/configuration and measured audio evidence.
 * It never reads learning, publication grants, naming or wallet authority. */
import { decodeEventLog, type Hex } from "viem";
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
import type { IndexedPost } from "../packages/community/post-index.ts";
import {
  postsAbi,
  publicationEvent,
  verifiedPostsHead,
} from "../packages/community/post-chain.ts";
import {
  quarantined,
  validatePostForEvent,
} from "../packages/community/post-manifest.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { danceId } from "../packages/dance/validation.ts";
import { DanceStore } from "../packages/dance/store.ts";
import {
  hostBody,
  hostCount,
  hostRowFence,
  joinDanceFences,
  type HostRow,
} from "./dance-account-facts-store.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DanceSelectedSong } from "./dance-selected-catalogue.ts";

export function createDanceSongResources(input: {
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
}) {
  const { db, config, reads } = input,
    community = config.communityId,
    store = new DanceStore(db);
  insist(
    config.chainId === 6343 && reads.profile.address === config.postsContract,
    "dance_host_source_changed",
    503,
  );
  const songKeyForPost = (postId: string) =>
    songKeyOf({
      chainId: 6343,
      posts: config.postsContract,
      communityId: community,
      postId: bytes32(postId),
    });
  const tuple = (
    song: string,
    reference: string | null,
    offer: string | null,
  ) => [community, song, reference ?? "", offer ?? ""];
  async function mapping(songKey: string) {
    const row = await db
      .prepare(
        "SELECT post_id FROM dance_host_song_keys WHERE community_id=? AND song_key=?",
      )
      .bind(community, bytes32(songKey))
      .first<{ post_id: Hex }>();
    insist(
      row && songKeyForPost(row.post_id) === songKey,
      "dance_song_mapping_missing",
      503,
    );
    return {
      postId: row.post_id,
      fence: {
        sql: "EXISTS(SELECT 1 FROM dance_host_song_keys WHERE (((community_id=?)\n        AND (song_key=?))\n        AND (post_id=?)))",
        values: [community, songKey, row.post_id],
      } satisfies DanceFence,
    };
  }
  async function selected(
    songKey: string,
    reference: string | null,
    offer: string | null,
  ) {
    const keys = tuple(bytes32(songKey), reference, offer);
    const row = await db
      .prepare(
        `SELECT revision,body_json FROM dance_host_selections
      WHERE community_id=? AND song_key=? AND reference_id=? AND offer_id=?`,
      )
      .bind(...keys)
      .first<HostRow>();
    insist(row, "dance_selection_missing", 503);
    const raw = hostBody(row);
    exact(raw, [
      "version",
      "postId",
      "songRevision",
      "manifestSha256",
      "audioSha256",
      "songDurationSamples",
      "probeEvidenceSha256",
      "startSample",
      "durationSamples",
      "reference",
      "offerProgramId",
      "offer",
    ]);
    const s = raw as unknown as DanceSelectedSong;
    insist(
      s.version === "pirate.dance-selected-song/1" &&
        songKeyForPost(s.postId) === songKey &&
        (s.reference?.id ?? null) === reference &&
        (s.offer?.offerId ?? null) === offer,
      "dance_selection_binding_changed",
      409,
    );
    [s.postId, s.manifestSha256, s.audioSha256, s.probeEvidenceSha256].forEach(
      bytes32,
    );
    hostCount(s.songRevision, 1);
    hostCount(s.songDurationSamples, 1);
    hostCount(s.startSample);
    hostCount(s.durationSamples, 1);
    insist(
      s.durationSamples >= 288000 &&
        s.durationSamples <= 1440000 &&
        s.durationSamples % 48 === 0 &&
        Number.isSafeInteger(s.startSample + s.durationSamples) &&
        s.startSample + s.durationSamples <= s.songDurationSamples,
      "dance_interval_invalid",
      409,
    );
    if (s.reference) {
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
      danceId(s.reference.resourceId);
      hostCount(s.reference.revision, 1);
      hostCount(s.reference.epoch, 1);
    }
    insist(
      (s.offer === null && s.offerProgramId === null) ||
        (s.offer !== null &&
          typeof s.offerProgramId === "string" &&
          !!s.offerProgramId),
      "dance_offer_binding_mismatch",
      409,
    );
    const mapped = await mapping(songKey);
    insist(mapped.postId === s.postId, "dance_song_mapping_changed", 409);
    const probe = await db
      .prepare(
        `SELECT samples,receipt_bytes FROM dance_host_audio_probes
      WHERE community_id=? AND audio_sha256=? AND evidence_sha256=?`,
      )
      .bind(community, s.audioSha256, s.probeEvidenceSha256)
      .first<{ samples: number; receipt_bytes: string }>();
    insist(
      probe &&
        probe.samples === s.songDurationSamples &&
        typeof probe.receipt_bytes === "string" &&
        probe.receipt_bytes.length <= 128 * 1024 &&
        hashText(probe.receipt_bytes) === s.probeEvidenceSha256,
      "dance_canonical_probe_missing",
      503,
    );
    const probeFence: DanceFence = {
      sql: `EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE ((((community_id=?)
        AND (audio_sha256=?))
        AND ((evidence_sha256=?)
        AND (samples=?)))
        AND (receipt_bytes=?)))`,
      values: [
        community,
        s.audioSha256,
        s.probeEvidenceSha256,
        probe.samples,
        probe.receipt_bytes,
      ],
    };
    return {
      song: s,
      fence: joinDanceFences(
        mapped.fence,
        probeFence,
        hostRowFence(
          "dance_host_selections",
          "(((community_id=?)\n        AND (song_key=?))\n        AND ((reference_id=?)\n        AND (offer_id=?)))",
          keys,
          row,
        ),
      ),
    };
  }
  async function publication(songKey: string, s: DanceSelectedSong) {
    const head = await verifiedPostsHead(reads.client, reads.profile, config);
    const scan = await db
      .prepare(
        "SELECT next_block,checkpoint_hash FROM chain_scan_state WHERE chain_id=6343 AND contract_address=?",
      )
      .bind(config.postsContract)
      .first<{ next_block: string; checkpoint_hash: string }>();
    insist(
      scan &&
        /^[0-9]+$/.test(scan.next_block) &&
        BigInt(scan.next_block) > head &&
        scan.checkpoint_hash,
      "dance_publication_index_pending",
      503,
    );
    const checkpoint = await reads.client.getBlock({
      blockNumber: BigInt(scan.next_block) - 1n,
    });
    insist(
      checkpoint.hash === scan.checkpoint_hash,
      "dance_publication_checkpoint_changed",
      503,
    );
    const history = reads.configurationHistory
      ? [...(await reads.configurationHistory())]
      : [config];
    // Snapshot ONCE, then verify these exact bytes/provenance using the same
    // owned posts ABI/event/schema helpers as indexedPublicPosts. Rereading a
    // mutable index row after verification must never choose a new fence value.
    const row = await db
      .prepare(
        "SELECT * FROM public_post_revisions WHERE community_id=? AND post_id=? AND revision=?",
      )
      .bind(community, s.postId, s.songRevision)
      .first<IndexedPost>();
    insist(
      row && row.quarantined === 0 && BigInt(row.block_number) <= head,
      "dance_publication_missing",
      503,
    );
    const event = publicationEvent(
      {
        communityId: row.community_id,
        postId: row.post_id,
        authorId: row.author_id,
        kind: 0,
        revision: BigInt(row.revision),
        configurationRevision: BigInt(row.configuration_revision),
        manifestURI: row.manifest_uri,
        manifestSha256: row.manifest_sha256,
      },
      reads.profile,
    );
    insist(
      !quarantined(event, BigInt(row.block_number), history, config),
      "dance_publication_quarantined",
      503,
    );
    const [onchain, block, receipt] = await Promise.all([
      reads.client.readContract({
        address: reads.profile.address,
        abi: postsAbi,
        functionName: "getPost",
        args: [community, s.postId as Hex],
        blockNumber: head,
      }),
      reads.client.getBlock({ blockNumber: BigInt(row.block_number) }),
      reads.client.getTransactionReceipt({ hash: row.transaction_hash }),
    ]);
    insist(
      onchain.authorId === row.author_id &&
        onchain.kind === 0 &&
        onchain.revision === BigInt(row.revision) &&
        onchain.configurationRevision === BigInt(row.configuration_revision) &&
        onchain.manifestSha256 === row.manifest_sha256 &&
        onchain.manifestURI === row.manifest_uri &&
        block.hash === row.block_hash &&
        receipt.status === "success" &&
        receipt.transactionHash === row.transaction_hash &&
        receipt.blockNumber === BigInt(row.block_number) &&
        receipt.blockHash === row.block_hash,
      "dance_publication_provenance_changed",
      503,
    );
    const logs = receipt.logs.filter(
      (log) =>
        log.logIndex === row.log_index &&
        log.address.toLowerCase() === reads.profile.address,
    );
    insist(logs.length === 1, "dance_publication_log_missing", 503);
    const log = logs[0];
    insist(
      log.removed !== true &&
        log.transactionHash === row.transaction_hash &&
        log.blockHash === row.block_hash &&
        log.blockNumber === BigInt(row.block_number),
      "dance_publication_provenance_changed",
      503,
    );
    const decoded = publicationEvent(
      decodeEventLog({
        abi: postsAbi,
        eventName: "PostRevisionPublished",
        topics: log.topics,
        data: log.data,
        strict: true,
      }).args,
      reads.profile,
    );
    insist(
      canonical(decoded) === canonical(event),
      "dance_publication_provenance_changed",
      503,
    );
    const publicationConfig = history.find(
      (c) =>
        c.configurationRevision === row.configuration_revision &&
        c.communityId === community,
    );
    insist(publicationConfig, "dance_publication_configuration_missing", 503);
    const post = validatePostForEvent(
        JSON.parse(row.manifest_json),
        event,
        publicationConfig,
      ),
      audio = post.media.filter((m) => m.role === "audio");
    insist(
      post.postId === s.postId &&
        post.communityId === community &&
        post.postsContract === config.postsContract &&
        post.revision === s.songRevision &&
        hashJson(post) === s.manifestSha256 &&
        audio.length === 1 &&
        audio[0].sha256 === s.audioSha256 &&
        songKeyForPost(post.postId) === songKey,
      "dance_publication_changed",
      409,
    );
    insist(
      row.manifest_sha256 === s.manifestSha256 &&
        canonical(JSON.parse(row.manifest_json)) === canonical(post),
      "dance_publication_changed",
      409,
    );
    return {
      title: post.title,
      fence: {
        sql: `(((EXISTS(SELECT 1 FROM public_post_revisions WHERE (((((community_id=?)
        AND (post_id=?))
        AND ((revision=?)
        AND (author_id=?)))
        AND (((manifest_uri=?)
        AND (manifest_sha256=?))
        AND ((manifest_json=?)
        AND (configuration_revision=?))))
        AND ((((block_number=?)
        AND (block_hash=?))
        AND ((transaction_hash=?)
        AND (log_index=?)))
        AND (quarantined=0)))))
        AND (NOT EXISTS(SELECT 1 FROM public_post_revisions WHERE (((community_id=?)
        AND (post_id=?))
        AND (revision>?)))))
        AND (EXISTS(SELECT 1 FROM chain_scan_state WHERE (((chain_id=6343)
        AND (contract_address=?))
        AND ((next_block=?)
        AND (checkpoint_hash=?))))))`,
        values: [
          community,
          s.postId,
          s.songRevision,
          row.author_id,
          row.manifest_uri,
          row.manifest_sha256,
          row.manifest_json,
          row.configuration_revision,
          row.block_number,
          row.block_hash,
          row.transaction_hash,
          row.log_index,
          community,
          s.postId,
          s.songRevision,
          config.postsContract,
          scan.next_block,
          scan.checkpoint_hash,
        ],
      } satisfies DanceFence,
    };
  }
  return { songKeyForPost, mapping, selected, publication };
}
