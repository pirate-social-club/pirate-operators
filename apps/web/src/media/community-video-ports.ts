import type { PublishedMediaSong } from "../../../../packages/community-media/contracts.ts";
import { PUBLIC_POSTING_UNDECIDED } from "../../../../packages/community-media/contracts.ts";
import type { MediaClient } from "./client.ts";
import type { MediaAttemptStorage } from "./media-attempt.ts";
import type { VideoComposerPorts } from "./video-flow.ts";
import type { CommunityOwner } from "./community-contracts.ts";
import { fileHash, SONG_BYTES } from "./community-contracts.ts";
import type { CommunityHttp } from "./community-http.ts";
import { ServiceRefusal } from "./reference/src/service-refusal.ts";
import type { SongSourceReader } from "./reference/src/features/posts/post-composer/song-excerpt-source.ts";
import type { SongIntervalPreflight } from "./reference/src/features/posts/video-submission/song-reference.ts";

/** Required missing producer contract, not an implemented endpoint or an
 * inferred relation between a Post revision and a song/audio revision. */
export interface CanonicalVideoSongFacts extends PublishedMediaSong {
  version: "pirate.community-video-song-facts/1";
  postId: string;
  postRevision: number;
  audioRevision: number;
}
interface Proof {
  schema: string;
  transactionHash: string;
  post: {
    communityId: string;
    postId: string;
    authorId: string;
    revision: number;
    media: { role: string; sha256: string; byteLength: number }[];
  };
}
export function createCommunityVideoPorts(options: {
  owner: CommunityOwner;
  http: CommunityHttp;
  media: MediaClient;
  storage: MediaAttemptStorage;
  canonicalFacts?: (
    postId: string,
    signal?: AbortSignal,
  ) => Promise<CanonicalVideoSongFacts>;
  preflight?: SongIntervalPreflight;
  transport?: typeof fetch;
}): { ports: VideoComposerPorts; hold: string } {
  const { owner, http } = options;
  const proof = async (postId: string, signal?: AbortSignal) => {
    owner.assert();
    if (!/^0x[0-9a-f]{64}$/.test(postId))
      throw new Error("A canonical published Post ID is required.");
    const post = owner.current.feed.posts.filter(
      (value) => value.manifest.postId === postId,
    );
    if (post.length !== 1)
      throw new Error("The published song is unavailable in this community.");
    const result = await http<Proof>(
      `/api/public/posts/${postId}/proof`,
      {},
      signal,
    );
    const audio = result.post.media.filter((value) => value.role === "audio");
    if (
      result.schema !== "pirate.community-publication-proof/1" ||
      result.post.communityId !== owner.communityId ||
      result.post.postId !== postId ||
      result.post.authorId !== post[0].manifest.authorId ||
      result.transactionHash !== post[0].transactionHash ||
      !Number.isSafeInteger(result.post.revision) ||
      audio.length !== 1 ||
      !/^0x[0-9a-f]{64}$/.test(audio[0].sha256) ||
      !Number.isSafeInteger(audio[0].byteLength) ||
      audio[0].byteLength <= 0 ||
      audio[0].byteLength > SONG_BYTES
    )
      throw new Error("Canonical audio proof changed.");
    owner.assert();
    return { proof: result, audio: audio[0], song: post[0] };
  };
  const facts = async (postId: string, signal?: AbortSignal) => {
    if (!options.canonicalFacts)
      throw new Error("Server-probed canonical song timing is unavailable.");
    const published = await proof(postId, signal),
      value = await options.canonicalFacts(postId, signal);
    if (
      value.version !== "pirate.community-video-song-facts/1" ||
      value.communityId !== owner.communityId ||
      value.postId !== postId ||
      value.postRevision !== published.proof.post.revision ||
      value.audioSha256 !== published.audio.sha256.slice(2) ||
      value.title !== published.song.manifest.title ||
      !Number.isSafeInteger(value.durationSamples) ||
      value.durationSamples <= 0 ||
      !Number.isSafeInteger(value.audioRevision) ||
      value.audioRevision < 1 ||
      !Number.isSafeInteger(value.songRevision) ||
      value.songRevision < 1 ||
      !value.songKey
    )
      throw new Error("Canonical media song binding changed.");
    owner.assert();
    return value;
  };
  const reader: SongSourceReader = async (request, signal) => {
    if (request.kind !== "post")
      throw new Error("This community resolves canonical Post IDs only.");
    const published = await proof(request.postId, signal);
    return {
      postId: request.postId,
      title: published.song.manifest.title,
      audioUrl: new URL(
        `/api/public/posts/${request.postId}/audio`,
        owner.current.community.origin,
      ).href,
    };
  };
  return {
    hold: "Public video rights are denied; canonical media timing and processor selection remain separate producer gates.",
    ports: {
      storage: options.storage,
      songReader: reader,
      songPicker: async (communityId, cursor) => {
        owner.assert();
        if (communityId !== owner.communityId || cursor !== null)
          throw new Error("Song picker scope changed.");
        return {
          nextCursor: null,
          songs: owner.current.feed.posts.map((song) => ({
            postId: song.manifest.postId,
            title: song.manifest.title,
            artist: "",
            artworkSrc: null,
          })),
        };
      },
      songPreflight: async (request, signal) => {
        owner.assert();
        if (
          request.path.communityId !== owner.communityId ||
          !PUBLIC_POSTING_UNDECIDED.allowed
        )
          throw new ServiceRefusal(
            403,
            "media_public_posting_not_permitted",
            false,
            { reason_code: "capability_unavailable" },
          );
        const song = await facts(request.body.song_post_id, signal),
          capability = await options.media.capability(
            song.songKey,
            song.songRevision,
          );
        if (!capability.publicPosting.allowed)
          throw new ServiceRefusal(
            403,
            "media_public_posting_not_permitted",
            false,
            { reason_code: "capability_unavailable" },
          );
        const interval = request.body.interval;
        if (
          interval &&
          (interval.clip_start_samples < 0 ||
            interval.clip_duration_samples < 3 * 48000 ||
            interval.clip_duration_samples > 15 * 48000 ||
            interval.clip_start_samples + interval.clip_duration_samples >
              song.durationSamples)
        )
          throw new ServiceRefusal(400, "invalid_interval", false, {
            reason_code: "invalid_interval",
          });
        if (!options.preflight)
          throw new ServiceRefusal(503, "media_preflight_unavailable", false, {
            reason_code: "capability_unavailable",
          });
        const answer = await options.preflight(request, signal);
        if (
          answer.song_post_id !== song.postId ||
          (answer.state === "ready" &&
            (answer.audio_revision !== song.audioRevision ||
              answer.canonical_duration_samples !== song.durationSamples))
        )
          throw new Error("Canonical preflight changed audio identity.");
        return answer;
      },
      resolveSong: async (selection, signal) => {
        const song = await facts(selection.songPostId, signal);
        if (song.audioRevision !== selection.audioRevision)
          throw new Error("Selected song audio changed.");
        return {
          version: "pirate.video-song-resolution/1",
          sourcePostId: song.postId,
          audioRevision: song.audioRevision,
          song,
        };
      },
      prepareGuideSource: async (postId, signal) => {
        const published = await proof(postId, signal);
        owner.assert();
        const response = await (options.transport ?? fetch)(
          `/api/public/posts/${postId}/audio`,
          {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.any([
              owner.signal,
              signal,
              AbortSignal.timeout(30000),
            ]),
          },
        );
        if (!response.ok || !response.body)
          throw new Error("Canonical guide audio is unavailable.");
        const bytes = new Uint8Array(published.audio.byteLength),
          stream = response.body.getReader();
        let length = 0;
        try {
          for (;;) {
            const part = await stream.read();
            if (part.done) break;
            if (length + part.value.byteLength > bytes.length)
              throw new Error("Guide audio exceeded canonical size.");
            bytes.set(part.value, length);
            length += part.value.byteLength;
          }
        } finally {
          await stream.cancel().catch(() => {});
          stream.releaseLock();
        }
        if (
          length !== bytes.length ||
          (await fileHash(new Blob([bytes]))) !== published.audio.sha256
        )
          throw new Error("Guide audio digest changed.");
        owner.assert();
        const blob = new Blob([bytes], { type: "audio/mpeg" }),
          url = URL.createObjectURL(blob);
        let released = false;
        return {
          url,
          blob,
          release() {
            if (!released) {
              released = true;
              URL.revokeObjectURL(url);
            }
          },
        };
      },
    },
  };
}
