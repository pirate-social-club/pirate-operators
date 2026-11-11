import { digest } from "../packages/protocol/index.ts";
import { studySong, type StudySong } from "../packages/study/lesson.ts";
import { studySourceLines } from "../packages/study/public-source.ts";
import {
  publicSongs,
  publicLyricManifest,
  type PublicReadPorts,
} from "./community-public.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import {
  telegramCheck,
  type ChatActor,
  type TelegramGrant,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramCatalogPort,
  TelegramOffers,
  TelegramPublicAudio,
  TelegramSong,
} from "../packages/telegram/study-contracts.ts";
import { httpsOrigin } from "../packages/telegram/security.ts";

/** Reconstruct a public DTO rather than forwarding a reward API object that
 * might contain account credit, balances, wallets or claim information. */
export function telegramPublicOffers(
  value: TelegramOffers,
  now: number,
): TelegramOffers {
  if (value.state !== "ready") return { state: "unavailable" };
  telegramCheck(
    Number.isSafeInteger(value.readAt) &&
      value.readAt <= now &&
      Number.isSafeInteger(value.validUntil) &&
      value.validUntil > now &&
      value.validUntil <= value.readAt + 300_000 &&
      value.offers.length <= 20,
    "telegram_offer_projection_invalid",
    503,
  );
  const offers = value.offers.map((offer) => {
    telegramCheck(
      typeof offer.id === "string" &&
        offer.id.length > 0 &&
        offer.id.length <= 80 &&
        ["practice", "testnet", "live"].includes(offer.mode) &&
        Number.isSafeInteger(offer.opensAt) &&
        Number.isSafeInteger(offer.cutoffAt) &&
        offer.cutoffAt > offer.opensAt &&
        Number.isSafeInteger(offer.tickets) &&
        offer.tickets >= 0 &&
        offer.tickets <= 1_000_000 &&
        offer.activities.length > 0 &&
        offer.activities.every((activity) =>
          ["study", "karaoke", "dance"].includes(activity),
        ) &&
        typeof offer.rules === "string" &&
        offer.rules.length <= 600,
      "telegram_offer_projection_invalid",
      503,
    );
    return {
      id: offer.id,
      mode: offer.mode,
      opensAt: offer.opensAt,
      cutoffAt: offer.cutoffAt,
      tickets: offer.tickets,
      activities: [...offer.activities],
      rules: offer.rules,
    };
  });
  return {
    state: "ready",
    readAt: value.readAt,
    validUntil: value.validUntil,
    offers,
  };
}
export function telegramPublishedCatalog(options: {
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
  origin: string;
  now?: () => number;
  publicOffers(songKey: string, postId: string): Promise<TelegramOffers>;
  nextDrawAt(): Promise<number | null>;
  songProgress(
    grant: TelegramGrant,
    song: StudySong,
  ): Promise<{ streak: number | null; resumable: boolean | null }>;
  referenceAudio: TelegramCatalogPort["referenceAudio"];
}): TelegramCatalogPort {
  const origin = httpsOrigin(options.origin),
    now = options.now ?? Date.now;
  async function source(song: StudySong) {
    telegramCheck(
      song.communityId === options.config.communityId &&
        song.postsContract === options.config.postsContract &&
        song.chainId === options.config.chainId,
      "telegram_wrong_community",
      403,
    );
    const records = await publicSongs(
      options.db,
      options.config,
      options.reads,
      song.postId,
    );
    telegramCheck(records.length === 1, "telegram_song_unavailable", 404);
    const lyrics = await publicLyricManifest(
      records[0].post,
      options.reads.transport,
      options.reads.contentCache,
    );
    telegramCheck(
      lyrics && lyrics.revision === song.lyricRevision,
      "telegram_song_revision_changed",
      409,
    );
    return { post: records[0].post, lyrics };
  }
  async function project(
    actor: ChatActor,
    post: Awaited<ReturnType<typeof publicSongs>>[number]["post"],
    grant: TelegramGrant | null,
  ) {
    telegramCheck(
      actor.communityId === options.config.communityId &&
        (!grant || grant.communityId === actor.communityId),
      "telegram_wrong_community",
      403,
    );
    const lyrics = await publicLyricManifest(
      post,
      options.reads.transport,
      options.reads.contentCache,
    );
    if (!lyrics || studySourceLines(lyrics).lines.length < 4) return null;
    const song = studySong({
      chainId: lyrics.chainId,
      postsContract: lyrics.postsContract,
      communityId: lyrics.communityId,
      postId: lyrics.postId,
      lyricRevision: lyrics.revision,
    });
    const key = digest(song),
      audio = post.media.find((media) => media.role === "audio");
    telegramCheck(audio, "telegram_public_audio_missing", 503);
    const offers = await options
      .publicOffers(key, post.postId)
      .then((value) => telegramPublicOffers(value, now()))
      .catch(() => ({ state: "unavailable" as const }));
    const personal = grant
      ? await options
          .songProgress(grant, song)
          .catch(() => ({ streak: null, resumable: null }))
      : { streak: null, resumable: false };
    telegramCheck(
      personal.streak === null ||
        (Number.isSafeInteger(personal.streak) && personal.streak >= 0),
      "telegram_progress_invalid",
      503,
    );
    const publicAudio: TelegramPublicAudio = {
      url: `${origin}/api/public/posts/${post.postId}/audio`,
      sha256: audio.sha256,
      filename: `${
        post.title
          .replace(/[^A-Za-z0-9 _-]/g, "")
          .trim()
          .slice(0, 100) || "song"
      }.mp3`,
      byteLength: audio.byteLength,
    };
    return {
      key,
      title: post.title,
      song,
      publicAudio,
      offers,
      streak: personal.streak,
      resumable: personal.resumable,
    } satisfies TelegramSong;
  }
  const catalog: TelegramCatalogPort = {
    async list(actor, grant) {
      telegramCheck(
        actor.communityId === options.config.communityId,
        "telegram_wrong_community",
        403,
      );
      const records = await publicSongs(
          options.db,
          options.config,
          options.reads,
        ),
        songs: TelegramSong[] = [];
      for (const record of records) {
        const song = await project(actor, record.post, grant);
        if (song) songs.push(song);
      }
      const drawAt = await options.nextDrawAt().catch(() => null);
      return {
        songs,
        drawAt:
          drawAt !== null && Number.isSafeInteger(drawAt) && drawAt > now()
            ? drawAt
            : null,
      };
    },
    async song(actor, key, grant) {
      const result = await catalog.list(actor, grant),
        song = result.songs.find((song) => song.key === key);
      telegramCheck(song, "telegram_song_revision_changed", 409);
      return song;
    },
    async lines(song) {
      return studySourceLines((await source(song)).lyrics).lines.map(
        (entry) => entry.line,
      );
    },
    referenceAudio: options.referenceAudio,
  };
  return catalog;
}
