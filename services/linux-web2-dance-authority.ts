import { web2PrivateDanceHostPorts, type CommunityEnv } from "./community-application.ts";
import { bytes32, canonical, exact, hashJson, hashText, insist, integer, jsonBody, object } from "../packages/community/common.ts";
import { MediaRepository } from "../packages/community-media/repository.ts";
import { fetchPublicIpfs } from "../packages/community/ipfs.ts";
import { publicSongs } from "./community-public.ts";
import { preparePrivateDanceState } from "./dance-private-practice-state.ts";
import { createDancePrivateSongProjections } from "./dance-private-song-projections.ts";
import { communityPrivatePractice } from "./community-private-practice.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import type { DancePrivatePolicyV2 } from "./dance-private-catalogue.ts";
import { localAlignmentReplay } from "./linux-web2-local-alignment.ts";
import { sha256 } from "viem";
import { publishedLyrics, publishedStem, runSongAlignment } from "./karaoke-song.ts";

export const danceHostPrefix = "/_operator/native-private-dance/";
export interface NativeDanceEnv extends CommunityEnv {
  PRIVATE_DANCE_NATIVE_AUTHORITY?: string;
  KARAOKE_ALIGNMENT_ARCHIVE_SHA256?: string;
}
const response = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });

/** Reachable through the owned loopback upstream only. Public ingress blocks
 * /_operator and callers still need the native authority credential. */
export async function nativeDanceAuthority(request: Request, env: NativeDanceEnv, deployment: Web2CommunityDeploymentProfile) {
  const url = new URL(request.url), token = env.PRIVATE_DANCE_NATIVE_AUTHORITY,
    renderer = env.PRIVATE_DANCE_RENDERER, selection = env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON,
    policyBytes = env.PRIVATE_DANCE_POLICY_JSON;
  const supplied = request.headers.get("authorization") ?? "";
  if (request.method !== "POST" || url.origin !== deployment.origin || url.search ||
      !token || !/^[A-Za-z0-9_-]{43}$/.test(token) || supplied.length !== 50 || !renderer || !policyBytes)
    return new Response(null, { status: 404 });
  let difference = 0;
  const expected = "Bearer " + token;
  for (let i=0; i<expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (difference) return new Response(null, { status: 404 });
  try {
    const privateProfile = communityPrivatePractice(env, deployment);
    const policy = JSON.parse(policyBytes) as DancePrivatePolicyV2;
    insist(privateProfile?.activities.dance?.policyHash === hashJson(policy), "dance_private_policy_changed", 409);
    const host = web2PrivateDanceHostPorts(env), config = await host.current(), configBytes = canonical(config);
    const current = async () => {
      const same = () => env.PRIVATE_DANCE_NATIVE_AUTHORITY === token && env.PRIVATE_DANCE_RENDERER === renderer &&
        env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON === selection && env.PRIVATE_DANCE_POLICY_JSON === policyBytes;
      insist(same(), "dance_private_selection_changed", 409);
      const fresh = await host.current();
      insist(same() && canonical(fresh) === configBytes, "dance_private_selection_changed", 409);
    };
    const replay = url.pathname === danceHostPrefix + "replay-local-alignment";
    const archivePin = env.KARAOKE_ALIGNMENT_ARCHIVE_SHA256;
    if (replay) insist(privateProfile?.activities.karaoke && new URL(deployment.origin).hostname === "localhost" &&
      archivePin && /^0x[a-f0-9]{64}$/.test(archivePin), "karaoke_local_alignment_replay_unavailable", 503);
    const body = object(await jsonBody(request, replay ? 256*1024 : 4096));
    await current();
    if (replay) {
      exact(body, ["signed", "archive"]);
      insist(typeof body.archive === "string" && hashText(body.archive) === archivePin &&
        env.KARAOKE_ALIGNMENT_ARCHIVE_SHA256 === archivePin, "karaoke_alignment_archive_changed", 409);
      const preserved = object(JSON.parse(body.archive));
      const signed = object(body.signed), postId = bytes32(object(signed.request).postId);
      const lyrics = await publishedLyrics(env.DB, config, host.reads, postId);
      const vocal = await publishedStem(env.DB, config.communityId, postId, "vocals");
      await publishedStem(env.DB, config.communityId, postId, "instrumental");
      await current();
      // The selected archive binds the source material as well as the original
      // provider response. The actual installed controller still signs its new
      // installation's exact alignment request before the owning importer runs.
      exact(preserved, ["raw", "rawSha256", "vocalSha256", "transcriptSha256"]);
      insist(typeof preserved.raw === "string" && hashText(preserved.raw) === preserved.rawSha256 &&
        preserved.vocalSha256 === vocal.sha256 && preserved.transcriptSha256 === hashText(lyrics.sourceText),
        "karaoke_alignment_archive_source_changed", 409);
      const replayBody = localAlignmentReplay(JSON.parse(preserved.raw), lyrics.sourceText);
      return response(await runSongAlignment(env.DB, env.MEDIA, config, host.reads, signed, {
        apiKey: "local-recorded-alignment-replay",
        beforeSend: current,
        transport: { async request(providerRequest) {
          await current();
          insist(providerRequest.method === "POST" && providerRequest.url === "https://api.elevenlabs.io/v1/forced-alignment" &&
            env.KARAOKE_ALIGNMENT_ARCHIVE_SHA256 === archivePin, "karaoke_alignment_replay_scope_changed", 409);
          return Response.json(replayBody);
        } },
      }));
    }
    if (url.pathname === danceHostPrefix + "select-song") {
      exact(body, ["postId", "startSample", "durationSamples"]);
      const postId = bytes32(body.postId), startSample = integer(body.startSample, 0, Number.MAX_SAFE_INTEGER),
        durationSamples = integer(body.durationSamples, 1, Number.MAX_SAFE_INTEGER);
      const prepared = await preparePrivateDanceState({ db: env.DB, config, policy, policyHash: hashJson(policy), current });
      const published = (await publicSongs(env.DB, config, host.reads, postId))[0]?.post;
      await current();
      insist(published?.postId === postId, "dance_publication_changed", 409);
      const audio = published.media.find(m => m.role === "audio");
      insist(audio, "dance_audio_unavailable", 503);
      const projections = createDancePrivateSongProjections({ db: env.DB, config, reads: host.reads,
        async current() {
          await current();
          return [{sql:"EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=? AND body_json=?)",
            values:[config.communityId, prepared.bodyJson]}];
        },
        async probe(bytes) {
          const reply = await renderer.fetch("http://community-media.internal/probe", { method:"POST", body:new Uint8Array(bytes) });
          insist(reply.ok && Number(reply.headers.get("content-length")) <= 4096, "dance_audio_probe_unavailable",503);
          const facts = object(await reply.json());
          insist(facts.sampleRate === 48000 && typeof facts.receiptBytes === "string", "dance_audio_probe_invalid",503);
          return { sampleRate: 48000, samples: integer(facts.samples, 1, 600*48000), receiptBytes: facts.receiptBytes };
        },
      });
      await projections.selection({ version:"pirate.dance-selected-song/1", postId, songRevision:published.revision,
        manifestSha256:hashJson(published), audioSha256:audio.sha256, startSample, durationSamples,
        reference:null, offer:null, offerProgramId:null }, null);
      return response({ postId, songRevision:published.revision, communityId:config.communityId });
    }
    if (url.pathname !== danceHostPrefix+"facts" && url.pathname !== danceHostPrefix+"audio")
      return new Response(null,{status:404});
    exact(body,["id","claim"]);
    insist(typeof body.id === "string" && typeof body.claim === "string", "media_state_changed", 409);
    const repo = new MediaRepository(env.DB, config.communityId);
    async function liveClaim() {
      const media = await repo.get(String(body.id));
      await current();
      insist(media.state === "processing" && media.claim === body.claim && (media.leaseUntil ?? 0) > Date.now() &&
        media.expiresAt > Date.now() && media.purpose === "private-review", "media_state_changed",409);
      return media;
    }
    const media = await liveClaim();
    const runtime = await host.runtime(config);
    const song = await runtime.privateV2!.publishedSong(media.songKey, media.songRevision);
    insist(song.audioSha256 === media.audioSha256 && song.communityId === config.communityId, "dance_publication_changed",409);
    if (url.pathname === danceHostPrefix+"facts") {
      insist(canonical(await liveClaim()) === canonical(media), "media_state_changed", 409);
      return response({media,song});
    }
    const map = await env.DB.prepare("SELECT post_id FROM dance_host_song_keys WHERE community_id=? AND song_key=?")
      .bind(config.communityId, song.songKey).first<{post_id:string}>();
    insist(map, "dance_selection_missing",503);
    const post = (await publicSongs(env.DB,config,host.reads,bytes32(map.post_id)))[0]?.post;
    insist(post?.postId === map.post_id && post.revision === song.songRevision, "dance_publication_changed",409);
    const audio = post.media.find(m => m.role === "audio" && m.sha256.slice(2) === song.audioSha256);
    insist(audio && audio.byteLength <= 25*1024*1024, "dance_audio_unavailable",503);
    const bytes = (await fetchPublicIpfs(audio.uri,audio.sha256,audio.byteLength,host.reads.transport,host.reads.contentCache)).bytes;
    insist(sha256(bytes) === audio.sha256 && canonical(await liveClaim()) === canonical(media), "media_state_changed",409);
    return new Response(new Uint8Array(bytes),{headers:{"cache-control":"no-store","content-type":"audio/mpeg"}});
  } catch {
    return Response.json({error:"private_dance_authority_unavailable"},{status:503,headers:{"cache-control":"no-store"}});
  }
}
