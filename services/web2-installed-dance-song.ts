import { bytes32, canonical, hashJson, hashText, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { syncPublicPosts } from "../packages/community/post-index.ts";
import { danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW, DanceStore } from "../packages/dance/store.ts";
import { offerInput } from "../packages/rewards/offers.ts";
import type { RewardOffer } from "../packages/rewards/contracts.ts";
import { RewardStore } from "../packages/rewards/store.ts";
import { hostRowFence, type HostRow } from "./dance-account-facts-store.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DancePublicationSourceV2 } from "./dance-publication-source.ts";
import { createDanceSongResources } from "./dance-song-resources.ts";
import {
  assertInstalledDanceRewardConfiguration,
  installedDanceOfferForSong,
  readInstalledDanceOffer,
  type InstalledDanceRewards,
} from "./web2-installed-dance-rewards.ts";

/** An attached offer and the active Dance mount must use one complete V2 pin. */
export function assertInstalledRewardDanceSource(
  selection: Pick<InstalledDanceRewards, "sourceHash" | "source">,
  source: DancePublicationSourceV2,
) {
  insist(source.version === 2 && selection.source.version === 2 &&
    source.sourceHash === selection.sourceHash &&
    danceSourceHash(source.domain, source.pin) === selection.sourceHash &&
    source.capturePolicy === selection.source.capturePolicy &&
    source.capturePolicyRuntimeHash === selection.source.capturePolicyRuntimeHash,
  "dance_reward_source_changed", 503);
}

/** An authorized operator attachment reads the existing measured practice
 * selection before writing. Its replay can finish only the same projection. */
export async function prepareInstalledDanceOfferProjection(input: {
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
  selection: InstalledDanceRewards;
  songKey: string;
  authorityFences: readonly DanceFence[];
  current(): Promise<void>;
}) {
  const { db, config, reads, selection, current } = input;
  const community = config.communityId, songKey = bytes32(input.songKey);
  const resources = createDanceSongResources({ db, config, reads });
  const store = new DanceStore(db);
  const rewards = new RewardStore(db, selection.profile);
  const configBytes = canonical(config);
  const configuration: DanceFence = {
    sql: `EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=? AND manifest_json=? AND manifest_sha256=?)
      AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
    values: [community, config.configurationRevision, configBytes, hashText(configBytes), community, config.configurationRevision],
  };
  assertInstalledDanceRewardConfiguration(selection, config);
  await current();
  const base = await resources.selected(songKey, null, null);
  insist(base.song.reference === null && base.song.offer === null, "dance_reward_song_selection_changed", 409);
  insist(reads.configurationHistory, "dance_reward_history_unavailable", 503);
  const history = await reads.configurationHistory();
  const checkpoint = await syncPublicPosts(db, reads.client, reads.profile, [...history], config, reads.transport);
  insist(checkpoint.caughtUp, "dance_publication_index_pending", 503);
  const published = await resources.publication(songKey, base.song);
  const songFences = [configuration, base.fence, published.fence, ...input.authorityFences];
  await current();
  await store.assert(songFences);

  return async function project(attached: RewardOffer) {
    insist(attached.offerId === selection.offerId && attached.songKey === songKey &&
      attached.state === "open", "dance_reward_offer_changed", 409);
    const original = await readInstalledDanceOffer(rewards, selection);
    insist(original && original.row.input_hash === hashJson(offerInput(attached)) &&
      original.offer.songKey === songKey && original.offer.state === "open",
    "dance_reward_offer_changed", 409);
    const { row } = original;
    // Materialize the frozen interval for a scheduled offer. Discovery and
    // capture still apply the real D1 clock to its opensAt/cutoffAt.
    const terms = await installedDanceOfferForSong(db, selection, songKey, row.opens_at);
    insist(terms && terms.offer.inputHash === row.input_hash, "dance_reward_offer_changed", 409);
    const ledgerFence: DanceFence = {
      sql: `EXISTS(SELECT 1 FROM reward_offers WHERE program_id=? AND offer_id=? AND song_key=?
        AND input_hash=? AND drawing_id=? AND purchase_hash=? AND purchase_evidence=? AND ticket_ids_json=?
        AND state='open' AND opens_at=? AND cutoff_at=? AND cutoff_at>${DANCE_DB_NOW})`,
      values: [terms.offerProgramId, row.offer_id, songKey, row.input_hash, row.drawing_id,
        row.purchase_hash, row.purchase_evidence, row.ticket_ids_json, row.opens_at, row.cutoff_at],
    };
    const where = "community_id=? AND song_key=? AND reference_id=? AND offer_id=?";
    const keys = [community, songKey, "", selection.offerId];
    const body = canonical({ ...base.song, ...terms });
    const read = () => db.prepare(`SELECT revision,body_json FROM dance_host_selections WHERE ${where}`)
      .bind(...keys).first<HostRow>();
    const verify = async (saved: HostRow) => {
      insist(saved.revision === 1 && saved.body_json === body, "dance_reward_song_projection_changed", 409);
      await store.assert([...songFences, ledgerFence, hostRowFence("dance_host_selections", where, keys, saved)]);
    };
    const retained = await read();
    await current();
    if (retained) return verify(retained);
    try {
      await store.atomic([...songFences, ledgerFence, {
        sql: `NOT EXISTS(SELECT 1 FROM dance_host_selections WHERE ${where})`, values: keys,
      }], [
        db.prepare(`INSERT INTO dance_host_selections (community_id,song_key,reference_id,offer_id,revision,body_json)
          VALUES (?,?,?,?,1,?)`).bind(...keys, body),
        store.changed(),
      ]);
    } catch (error) {
      const raced = await read();
      if (!raced) throw error;
      await current();
        return verify(raced);
    }
    const saved = await read();
    insist(saved, "dance_reward_song_projection_unavailable", 503);
    await current();
    await verify(saved);
  };
}
