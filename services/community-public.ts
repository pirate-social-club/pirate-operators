import type { PublicClient } from "viem";
import { canonical, hashJson, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { PublicSongView } from "../packages/community/application-api.ts";
import {
  fetchPublicIpfs,
  type IpfsTransport,
} from "../packages/community/ipfs.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../packages/community/lyric-manifest.ts";
import {
  syncPublicPosts,
  indexedPublicPosts,
} from "../packages/community/post-index.ts";
import type { PostsProfile } from "../packages/community/post-chain.ts";

export interface PublicReadPorts {
  client: PublicClient;
  profile: PostsProfile;
  transport?: IpfsTransport;
  configurationHistory?: () => Promise<readonly CommunityConfig[]>;
  manifestAvailable?: (hash: import("viem").Hex) => Promise<boolean>;
}
export async function publicSongs(
  db: D1Database,
  config: CommunityConfig,
  ports: PublicReadPorts,
  postId?: string,
) {
  const history = [
    ...(ports.configurationHistory
      ? await ports.configurationHistory()
      : [config]),
  ];
  const scan = await syncPublicPosts(
    db,
    ports.client,
    ports.profile,
    history,
    config,
    ports.transport,
  );
  insist(scan.caughtUp, "public_index_catching_up", 503);
  return indexedPublicPosts(
    db,
    ports.client,
    ports.profile,
    history,
    config,
    scan.head,
    postId,
  );
}
type PublicPost = Awaited<ReturnType<typeof publicSongs>>[number]["post"];
/** A published post's pinned lyric manifest, bound to that exact post. */
export async function publicLyricManifest(
  post: PublicPost,
  transport?: IpfsTransport,
): Promise<LyricManifest | undefined> {
  const lyric = post.media.find((m) => m.role === "lyrics");
  if (!lyric) return undefined;
  const { bytes } = await fetchPublicIpfs(
      lyric.uri,
      lyric.sha256,
      lyric.byteLength,
      transport,
    ),
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    manifest = validateLyrics(JSON.parse(decoded));
  insist(
    decoded === canonical(manifest) &&
      hashJson(manifest) === lyric.sha256 &&
      manifest.communityId === post.communityId &&
      manifest.postsContract === post.postsContract &&
      manifest.postId === post.postId &&
      manifest.chainId === post.chainId,
    "public_lyrics_binding_changed",
    503,
  );
  return manifest;
}
export async function publicSongViews(
  db: D1Database,
  config: CommunityConfig,
  ports: PublicReadPorts,
) {
  const records = await publicSongs(db, config, ports),
    views: PublicSongView[] = [];
  for (const { post, transactionHash } of records) {
    const lyricsText = (await publicLyricManifest(post, ports.transport))
      ?.sourceText;
    views.push({
      manifest: {
        schema: post.schema,
        postId: post.postId,
        authorId: post.authorId,
        title: post.title,
        language: post.language,
        rating: post.rating,
        ...(post.schema === "pirate.community-post/2"
          ? {
              declarationSource: post.admission.declarationSource,
              automatedContent: post.admission.automatedContent,
            }
          : {}),
      },
      audioUrl: `/api/public/posts/${post.postId}/audio`,
      postUrl: `/#song-${post.postId}`,
      transactionHash,
      ...(lyricsText !== undefined ? { lyricsText } : {}),
    });
  }
  return views;
}
export async function publicSongResource(
  request: Request,
  db: D1Database,
  config: CommunityConfig,
  ports: PublicReadPorts,
) {
  const url = new URL(request.url),
    match = /^\/api\/public\/posts\/(0x[0-9a-f]{64})\/(audio|proof)$/.exec(
      url.pathname,
    );
  if (!match) return null;
  insist(
    (request.method === "GET" || request.method === "HEAD") && !url.search,
    "method_not_allowed",
    405,
  );
  const records = await publicSongs(db, config, ports, match[1]);
  insist(records.length === 1, "public_song_not_found", 404);
  const record = records[0]!,
    headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    });
  if (match[2] === "proof")
    return Response.json(
      { schema: "pirate.community-publication-proof/1", ...record },
      { headers },
    );
  const audio = record.post.media.find((m) => m.role === "audio")!,
    { bytes } = await fetchPublicIpfs(
      audio.uri,
      audio.sha256,
      audio.byteLength,
      ports.transport,
    );
  insist(bytes.length === audio.byteLength, "public_audio_length_changed", 503);
  headers.set("content-type", "audio/mpeg");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", `"${audio.sha256}"`);
  const range = request.headers.get("range");
  if (!range) {
    headers.set("content-length", String(bytes.length));
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  }
  const parts = /^bytes=(\d+)-(\d*)$/.exec(range);
  insist(parts, "invalid_audio_range", 416);
  const start = Number(parts[1]),
    end = parts[2]
      ? Math.min(Number(parts[2]), bytes.length - 1)
      : bytes.length - 1;
  insist(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      start <= end &&
      start < bytes.length,
    "invalid_audio_range",
    416,
  );
  headers.set("content-range", `bytes ${start}-${end}/${bytes.length}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(
    request.method === "HEAD" ? null : bytes.slice(start, end + 1),
    { status: 206, headers },
  );
}
export async function firstSongPublicReady(
  db: D1Database,
  config: CommunityConfig,
  ports: PublicReadPorts,
) {
  try {
    const songs = await publicSongs(db, config, ports);
    if (!songs.length) return false;
    for (const { post } of songs)
      await publicLyricManifest(post, ports.transport);
    const audio = songs[0]!.post.media.find((m) => m.role === "audio")!;
    const { bytes } = await fetchPublicIpfs(
      audio.uri,
      audio.sha256,
      audio.byteLength,
      ports.transport,
    );
    return bytes.length === audio.byteLength;
  } catch {
    return false;
  }
}
