import type { PublicClient } from "viem";
import { canonical, hashJson, insist, object } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { PublicSongView } from "../packages/community/application-api.ts";
import {
  fetchPublicIpfs,
  type IpfsTransport,
  type PublicIpfsCache,
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
import type { RecognitionProfile } from "../packages/recognition/intent.ts";
import type { PostManifest } from "../packages/community/post-manifest.ts";
import { isCompactPosting } from "../packages/recognition/compact-catalog-read.ts";
import { catalogSongPublicProof, type CatalogSongRecord, type RetainedCatalogSongProof } from "./catalog-song-public-proof.ts";

export interface PublicReadPorts {
  client: PublicClient;
  profile: PostsProfile;
  transport?: IpfsTransport;
  contentCache?: PublicIpfsCache;
  configurationHistory?: () => Promise<readonly CommunityConfig[]>;
  manifestAvailable?: (hash: import("viem").Hex) => Promise<boolean>;
}
async function visiblePublicSongs(
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
  const records = await indexedPublicPosts(
    db,
    ports.client,
    ports.profile,
    history,
    config,
    scan.head,
    postId,
  );
  const visible: { record: (typeof records)[number]; compact?: Awaited<ReturnType<typeof catalogSongPublicProof>> }[]=[];
  for(const record of records) {
    if(record.post.schema!=="pirate.community-post/4") { visible.push({record}); continue; }
    const row=await retainedCatalogSong(db,record.post);
    if(!row) {
      if(postId) insist(false,"catalog_pending",503);
      continue;
    }
    const posting:unknown=row.posting_json?JSON.parse(row.posting_json):null;
    if(!isCompactPosting(posting)) {
      insist(!posting||!Object.hasOwn(object(posting),"schema"),"catalog_public_proof_invalid",503);
      visible.push({record});
      continue;
    }
    const issued=history.find(c=>c.configurationRevision===record.post.configurationRevision);
    insist(issued?.policies.recognition&&row.chain_receipt_json&&row.promotion_receipt_json,"catalog_pending",503);
    const compact=await catalogSongPublicProof(row,{record,profile:issued.policies.recognition,
      now:Math.floor(Date.now()/1000),compact:{config:issued,client:ports.client,posts:ports.profile,ipfs:ports.transport}});
    visible.push({record,compact});
  }
  return visible;
}
export async function publicSongs(db:D1Database,config:CommunityConfig,ports:PublicReadPorts,postId?:string) {
  return (await visiblePublicSongs(db,config,ports,postId)).map(item=>item.record);
}
const completedCatalogSong = `FROM publication_catalog_obligations o
  JOIN publication_jobs j ON j.job_id=o.job_id JOIN media_submissions s ON s.submission_id=j.submission_id
  WHERE o.reservation_id=? AND o.intent_sha256=? AND o.state='complete' AND o.promotion_receipt_json IS NOT NULL
  AND j.phase='published' AND s.post_id=? AND json_extract(o.intent_json,'$.communityId')=?`;

function catalogSongKeys(post: PostManifest) {
  const r = post.recognition!;
  return [r.reservationId, r.intentSha256, post.postId, post.communityId] as const;
}

function retainedCatalogSong(db: D1Database,post: PostManifest) {
  return db.withSession("first-primary").prepare(
    "SELECT o.posting_json, o.chain_receipt_json, o.promotion_receipt_json " + completedCatalogSong,
  ).bind(...catalogSongKeys(post)).first<RetainedCatalogSongProof>();
}

export async function publicCatalogSongProof(
  db: D1Database, record: CatalogSongRecord, config: CommunityConfig, approved: RecognitionProfile, now: number, ports?: PublicReadPorts,
) {
  const { post } = record;
  insist(post.schema === "pirate.community-post/4" && post.recognition && config.policies.recognition &&
    config.communityId === post.communityId && config.postsContract === post.postsContract &&
    config.configurationRevision === post.configurationRevision &&
    canonical(config.policies.recognition) === canonical(approved), "public_catalog_song_not_found", 404);
  const row = await retainedCatalogSong(db,post);
  insist(row && row.posting_json && row.chain_receipt_json && row.promotion_receipt_json, "catalog_pending", 503);
  return catalogSongPublicProof(row, { record, profile: approved, now,
    ...(ports?{compact:{config,client:ports.client,posts:ports.profile,ipfs:ports.transport}}:{}) });
}
type PublicPost = Awaited<ReturnType<typeof publicSongs>>[number]["post"];
/** A published post's pinned lyric manifest, bound to that exact post. */
export async function publicLyricManifest(
  post: PublicPost,
  transport?: IpfsTransport,
  cache?: PublicIpfsCache,
): Promise<LyricManifest | undefined> {
  const lyric = post.media.find((m) => m.role === "lyrics");
  if (!lyric) return undefined;
  const { bytes } = await fetchPublicIpfs(
      lyric.uri,
      lyric.sha256,
      lyric.byteLength,
      transport,
      cache,
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
    const lyricsText = (
      await publicLyricManifest(post, ports.transport, ports.contentCache)
    )?.sourceText;
    views.push({
      manifest: {
        schema: post.schema,
        postId: post.postId,
        authorId: post.authorId,
        title: post.title,
        language: post.language,
        rating: post.rating,
        ...(post.schema === "pirate.community-post/2" ||
        post.schema === "pirate.community-post/3" || post.schema === "pirate.community-post/4"
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
  catalogProof?: { profile: RecognitionProfile; now(): number },
) {
  const url = new URL(request.url),
    match = /^\/api\/public\/posts\/(0x[0-9a-f]{64})\/(audio|proof|catalog-proof)$/.exec(
      url.pathname,
    );
  if (!match) return null;
  insist(
    (request.method === "GET" || request.method === "HEAD") && !url.search,
    "method_not_allowed",
    405,
  );
  if (match[2] === "catalog-proof")
    insist(request.method === "GET", "public_catalog_song_not_found", 404);
  const records = await visiblePublicSongs(db, config, ports, match[1]);
  insist(records.length === 1, "public_song_not_found", 404);
  const {record,compact} = records[0]!,
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
  if (match[2] === "catalog-proof") {
    if(compact) return Response.json(compact,{headers});
    insist(catalogProof,"public_catalog_song_not_found",404);
    const history = ports.configurationHistory ? await ports.configurationHistory() : [config];
    const issued = history.find(item => item.configurationRevision === record.post.configurationRevision);
    insist(issued, "publication_configuration_missing", 503);
    const blockNumber = BigInt(record.blockNumber);
    const before = await ports.client.getBlock({ blockNumber });
    insist(before.hash, "catalog_public_receipt_changed", 503);
    const proof = await publicCatalogSongProof(db, { ...record, blockHash: before.hash },
      issued, catalogProof!.profile, catalogProof!.now());
    const [after, receipt] = await Promise.all([
      ports.client.getBlock({ blockNumber }),
      ports.client.getTransactionReceipt({ hash: record.transactionHash }),
    ]);
    insist(after.hash === before.hash && receipt.status === "success" && receipt.blockHash === after.hash &&
      receipt.blockNumber === blockNumber && receipt.transactionHash === record.transactionHash,
      "catalog_public_receipt_changed", 503);
    return Response.json(proof, { headers });
  }
  const audio = record.post.media.find((m) => m.role === "audio")!,
    { bytes } = await fetchPublicIpfs(
      audio.uri,
      audio.sha256,
      audio.byteLength,
      ports.transport,
      ports.contentCache,
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
      await publicLyricManifest(post, ports.transport, ports.contentCache);
    const audio = songs[0]!.post.media.find((m) => m.role === "audio")!;
    const { bytes } = await fetchPublicIpfs(
      audio.uri,
      audio.sha256,
      audio.byteLength,
      ports.transport,
      ports.contentCache,
    );
    return bytes.length === audio.byteLength;
  } catch {
    return false;
  }
}
