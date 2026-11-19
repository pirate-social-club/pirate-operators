import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { chmod, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { canonical } from "../../packages/community/common.ts";
import { FFmpegMediaProcessor } from "../../packages/community-media/ffmpeg.ts";
import type { MediaRecord, PublishedMediaSong } from "../../packages/community-media/contracts.ts";
import { communityMediaRender } from "../../packages/community-media/processor-transport.ts";
import { MAX_MEDIA_BYTES, readMediaBody } from "../../packages/community-media/validation.ts";
import { MAX_STUDY_AUDIO_BYTES } from "../../packages/study/contracts.ts";
import { MEDIA_LEASE_MS } from "../../services/community-media-jobs.ts";
import { localKaraokeTranscriber } from "../../harness/karaoke-local-bridge.ts";
import { hash, privateDirectory, privateFile, type OperationLease } from "./backend-state.ts";
import type { PublicIngress } from "./public-ingress.ts";
import type { Web2NativeActivityPolicy } from "./web2-native-activities.ts";
import type { Web2LocalStudyPolicy } from "./web2-local-study.ts";
import { selectLocalAsr } from "./web2-native-study-asr.ts";
import { noteStudyAsrStage } from "./web2-study-asr-diagnostics.ts";
import { publicationAcceptSessionHeader, publicationHostOrigin, publicationHostPath } from "../../services/native-publication-reference.ts";
import type { NativePublicationActivityRoute } from "./web2-native-publication-host.ts";
import { nativeDanceDispatchPath, nativeDanceHostPath, nativeDanceObservationPath } from "../../services/native-dance-retained-reference.ts";
import { protectedPostsRoute, type ProtectedFirstSongRoute } from "./web2-protected-posts-mount.ts";
import { protectedPostsMixedLimit, protectedPostsMixedRoute, protectedPostsReadLane,
  type ProtectedPostsMixedRoute, type ProtectedPostsReadLane } from "./web2-protected-posts-scheduling.ts";

const postsRoute = (path?: string) => protectedPostsRoute(path) || protectedPostsMixedRoute(path) !== undefined;
const publicationRoute = (path?: string) => path === publicationHostPath || path === nativeDanceHostPath ||
  path === nativeDanceDispatchPath || path === nativeDanceObservationPath;

const UPLOAD_IDLE_MS = 15_000;
const MIXED_POSTS_UPLOAD_MS = 5_000;
const PROCESSING_MS = new Map<string, number>([
  ["/recognize", 20_000], // 10 s model child plus pinned input checks.
  ["/transcribe", 30_000], // 20 s model child plus pinned input checks.
  ["/probe", 30_000], // 20 s FFmpeg decode plus pinned input checks.
  ["/render", MEDIA_LEASE_MS], // Up to 60 s FFmpeg, authority reads and probes.
]);

type Tool = { path: string; sha256: string };
export interface Web2NativeActivityHostInputs {
  karaoke?: { python: Tool; script: Tool; model: string };
  dance?: { ffmpeg: Tool; ffprobe: Tool; tempRoot: string };
}
async function checkTool(tool: Tool) {
  assert(tool.path.startsWith("/") && /^[a-f0-9]{64}$/.test(tool.sha256) &&
    hash(await readFile(tool.path)) === tool.sha256, "native_activity_tool_changed");
}
async function privateText(path: string) {
  const file = await privateFile(path, 43);
  try {
    const text = await file.readFile("ascii");
    assert(/^[A-Za-z0-9_-]{43}$/.test(text), "native_activity_credential_changed");
    return text;
  } finally { await file.close(); }
}
function inputRequest(incoming: IncomingMessage, signal: AbortSignal, bytes?: Uint8Array) {
  const headers = new Headers();
  for (const key of ["authorization", "content-type", "content-length"]) {
    const value = incoming.headers[key];
    if (typeof value === "string") headers.set(key, value);
  }
  if (incoming.url === nativeDanceDispatchPath || incoming.url === nativeDanceObservationPath) {
    const session = incoming.headers[publicationAcceptSessionHeader];
    if (typeof session === "string") headers.set(publicationAcceptSessionHeader, session);
  }
  const base = publicationRoute(incoming.url) || postsRoute(incoming.url) ? publicationHostOrigin : "http://local-activity";
  return new Request(base + incoming.url, { method: "POST", headers,
    body: bytes ? new Uint8Array(bytes) : Readable.toWeb(incoming), signal, duplex: "half" } as RequestInit);
}

/** The existing installed Wizard service owns this Unix listener and its
 * bounded subprocesses. No public socket, provider fallback or second stack. */
export async function startWeb2NativeActivityHost(options: {
  ingress: PublicIngress; stateRoot: string; lease: OperationLease;
  publication?: NativePublicationActivityRoute;
  deferredPublication?: () => NativePublicationActivityRoute | undefined;
  deferredProtectedPosts?: () => ProtectedFirstSongRoute | undefined;
} & (
  { selected: Web2NativeActivityPolicy; study: Web2LocalStudyPolicy; host: Web2NativeActivityHostInputs } |
  { selected?: never; study?: never; host?: never }
)) {
  const { selected, study, host, ingress, lease, publication, deferredPublication, deferredProtectedPosts } = options;
  const socket = join(options.stateRoot, "activity-transport", "host.sock");
  if (selected) {
    assert(selected.socket === socket, "selected_activity_socket_changed");
    assert(study.asr.upstream === "unix:" + socket &&
      Boolean(selected.karaoke) === Boolean(host.karaoke) && Boolean(selected.dance) === Boolean(host.dance),
      "selected_activity_host_mismatch");
  } else assert(deferredProtectedPosts && !publication && !deferredPublication, "selected_activity_host_mismatch");
  assert(!(publication && deferredPublication) &&
    (!publication || publication.lease === lease && publication.socket === socket),
    "native_publication_listener_scope_changed");
  await lease.assertHeld();
  await privateDirectory(dirname(socket));
  try { await lstat(socket); throw Error("activity_socket_original_held"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const studyAsr = study ? await selectLocalAsr() : undefined;
  if (study) assert(studyAsr?.selectedProgramSha256 === study.asr.selectedProgramSha256,
    "native_study_program_selection_changed");
  const studyAuth = study ? await privateText(study.asr.authFile) : undefined;
  const karo = host?.karaoke;
  if (karo) {
    assert(selected?.karaoke && karo.python.sha256 === selected.karaoke.pythonSha256 &&
      karo.script.sha256 === selected.karaoke.scriptSha256, "karaoke_program_selection_changed");
    await Promise.all([checkTool(karo.python), checkTool(karo.script)]);
    assert(karo.model.startsWith("/") && "0x"+hash(await readFile(karo.model)) === selected.karaoke.modelSha256,
      "karaoke_model_selection_changed");
  }
  const dance = host?.dance;
  if (dance) {
    assert(selected?.dance && dance.ffmpeg.sha256 === selected.dance.ffmpegSha256 &&
      dance.ffprobe.sha256 === selected.dance.ffprobeSha256 &&
      dance.tempRoot === join(options.stateRoot, "activity-scratch"), "dance_processor_selection_changed");
    await privateDirectory(dance.tempRoot);
    await Promise.all([checkTool(dance.ffmpeg), checkTool(dance.ffprobe)]);
  }
  const ca = dance ? await readFile(ingress.upstreamCaFile) : undefined;
  if (ca) assert(hash(ca) === ingress.upstreamCaSha256, "native_activity_upstream_ca_changed");
  const danceAuth = selected?.dance ? await privateText(selected.dance.authorityFile) : undefined;
  const karaoke = karo && selected?.karaoke ? localKaraokeTranscriber({
    python: karo.python.path, script: karo.script.path, model: karo.model, modelSha256: selected.karaoke.modelSha256,
  }) : undefined;
  const upstream = new URL(ingress.upstream), origin = new URL(ingress.origin);
  assert(upstream.protocol === "https:" && upstream.hostname === "127.0.0.1" && upstream.port,
    "native_activity_loopback_upstream_required");
  const authority = (operation: "facts" | "audio", id: string, claim: string, limit: number, signal: AbortSignal) =>
    new Promise<Buffer>((resolve, reject) => {
      signal.throwIfAborted();
      assert(ca && danceAuth);
      const body = JSON.stringify({ id, claim });
      const req = httpsRequest({ method: "POST", hostname:"127.0.0.1", port:upstream.port, ca, agent:false, signal,
        servername:ingress.upstreamServerName, path:"/_operator/native-private-dance/"+operation,
        headers:{ host:origin.host, "content-type":"application/json", "content-length":Buffer.byteLength(body),
          authorization:"Bearer "+danceAuth } }, (reply) => {
        if (reply.statusCode !== 200) { reply.resume(); reject(Error("native_dance_authority_unavailable")); return; }
        let bytes=0; const parts:Buffer[]=[];
        reply.on("data", (part:Buffer) => { bytes+=part.length; if(bytes>limit) req.destroy(Error("native_dance_authority_overflow")); else parts.push(part); });
        reply.on("error",reject);
        reply.on("end",()=>resolve(Buffer.concat(parts)));
      });
      req.setTimeout(15000,()=>req.destroy(Error("native_dance_authority_timeout")));
      req.on("error",reject);req.end(body);
    });
  async function render(request: Request) {
    assert(dance);
    await Promise.all([checkTool(dance.ffmpeg), checkTool(dance.ffprobe)]);
    const raw = await readMediaBody(request, MAX_MEDIA_BYTES+8196);
    assert(raw.length>=5);
    const size = new DataView(raw.buffer,raw.byteOffset,4).getUint32(0);
    assert(size>0 && size<=8192 && raw.length>size+4);
    const requestBody = JSON.parse(new TextDecoder().decode(raw.subarray(4,4+size))) as {media:MediaRecord};
    const {id,claim} = requestBody.media;
    assert(typeof id==="string" && typeof claim==="string" && id.length<=128 && claim.length<=128);
    const facts = async () => JSON.parse((await authority("facts",id,claim,65536,request.signal)).toString("utf8")) as {media:MediaRecord;song:PublishedMediaSong};
    const processor = new FFmpegMediaProcessor({ffmpeg:dance.ffmpeg.path, ffprobe:dance.ffprobe.path, tempRoot:dance.tempRoot,
      async loadSong(song) {
        const current = await facts();
        assert(canonical(current.song)===canonical(song));
        return new Uint8Array(await authority("audio",id,claim,25*1024*1024,request.signal));
      }});
    return communityMediaRender(new Request(request.url,{method:"POST",body:new Uint8Array(raw),signal:request.signal}),processor,{
      async authorize(){await lease.assertHeld();request.signal.throwIfAborted();return true;},
      async current(community,record){const {media}=await facts();assert(media.communityId===community && media.id===record);return media;},
      async song(community,key,revision){const {song}=await facts();assert(song.communityId===community && song.songKey===key && song.songRevision===revision);return song;},
      now:Date.now,
    });
  }
  async function route(request: Request, lane?: ProtectedPostsReadLane) {
    const url = new URL(request.url);
    if (url.search) return new Response(null,{status:404});
    try { await lease.assertHeld(); }
    catch (error) {
      if (url.pathname === "/transcribe") noteStudyAsrStage("host_lease");
      throw error;
    }
    request.signal.throwIfAborted();
    if (postsRoute(url.pathname) && deferredProtectedPosts) {
      const posts = deferredProtectedPosts();
      if (!posts) return new Response(null, { status: 503 });
      assert(posts.lease === lease && posts.socket === socket, "protected_posts_listener_scope_changed");
      if (lane) {
        if (!posts.fetchNested) return new Response(null, { status: 503 });
        return await posts.fetchNested(request, lane) ?? new Response(null, { status: 404 });
      }
      return await posts.fetch(request) ?? new Response(null, { status: 404 });
    }
    if (publicationRoute(url.pathname) && (publication || deferredPublication)) {
      const route = publication ?? deferredPublication?.();
      if (!route) return new Response(null, { status: 503 });
      assert(route.lease === lease && route.socket === socket, "native_publication_listener_scope_changed");
      return route.fetch(request);
    }
    if(url.pathname==="/transcribe" && studyAsr && studyAuth) {
      // The Study bridge checks its scoped bearer before running the model.
      const bytes = await readMediaBody(request,MAX_STUDY_AUDIO_BYTES).catch(error => {
        if (!request.signal.aborted) noteStudyAsrStage("host_body");
        throw error;
      });
      return studyAsr.route(studyAuth,"POST",request.headers.get("authorization")??"",Buffer.from(bytes),request.signal);
    }
    if(url.pathname==="/recognize" && karaoke && karo) {
      await Promise.all([checkTool(karo.python), checkTool(karo.script)]);
      return karaoke.fetch(new Request("http://local-karaoke/recognize",{method:"POST",headers:request.headers,
        body:request.body,signal:request.signal,duplex:"half"} as RequestInit));
    }
    if(url.pathname==="/render" && dance) return render(request);
    if(url.pathname==="/probe" && dance) {
      await checkTool(dance.ffmpeg);
      const audio = await readMediaBody(request,25*1024*1024);
      request.signal.throwIfAborted();
      const samples = await new Promise<number>((resolve,reject)=>{
        const child=execFile(dance.ffmpeg.path,["-nostdin","-v","error","-threads","1","-protocol_whitelist","pipe",
          "-f","mp3","-i","pipe:0","-map","0:a:0","-ac","1","-ar","48000","-t","600","-f","s16le","pipe:1"],
          {encoding:"buffer",maxBuffer:58*1024*1024,timeout:20000,killSignal:"SIGKILL"},(e,pcm)=>{
            if(e || !pcm.length || pcm.length%2 || pcm.length>=600*48000*2) reject(Error("native_dance_probe_invalid"));
            else resolve(pcm.length/2);
          });
        child.stdin?.on("error",()=>{});child.stdin?.end(audio);
      });
      return Response.json({sampleRate:48000,samples,receiptBytes:canonical({decoder:dance.ffmpeg.sha256,
        audioSha256:hash(audio),format:"s16le",samples})});
    }
    return new Response(null,{status:404});
  }
  let active: Promise<void> | undefined, activePosts: Promise<void> | undefined;
  let stopping = false, postsStopping = false;
  const activeReads = new Map<ProtectedPostsReadLane, Promise<void>>();
  const readingBodies = new Set<ProtectedPostsMixedRoute>();
  const serialOccupied = () => Boolean(active) || activeReads.size > 0;

  function dispatch(incoming: IncomingMessage, outgoing: ServerResponse, bytes?: Uint8Array, lane?: ProtectedPostsReadLane) {
    const isPosts = postsRoute(incoming.url) && Boolean(deferredProtectedPosts);
    const readStopped = postsStopping && !activePosts && (lane !== "canonical" || !activeReads.has("ready"));
    const occupied = lane
      ? activeReads.has(lane) || Boolean(active && !activePosts) || readStopped
      : serialOccupied() || (isPosts && postsStopping);
    if (stopping || occupied) { outgoing.writeHead(429, { connection: "close" }).end(); return; }
    if (outgoing.destroyed) return;
    const processingMs = isPosts ? 55000 : publicationRoute(incoming.url) && (publication || deferredPublication)
      ? (incoming.url === nativeDanceDispatchPath ? 20000 : 10000) : PROCESSING_MS.get(incoming.url ?? "");
    if (incoming.method !== "POST" || processingMs === undefined) {
      outgoing.writeHead(404, { connection: "close" }).end();
      return;
    }
    const isStudy = incoming.url === "/transcribe";
    const requestLifetime = new AbortController();
    let processingTimer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => {
      if (!outgoing.writableFinished && !requestLifetime.signal.aborted) {
        if (isStudy) noteStudyAsrStage("host_peer_interrupted");
        requestLifetime.abort(Error("native_activity_request_interrupted"));
      }
    };
    const finishUpload = () => {
      if (processingTimer !== undefined || requestLifetime.signal.aborted) return;
      incoming.removeListener("timeout", uploadTimeout);
      // IncomingMessage sets the timeout on the same socket that carries the
      // reply. Disable the upload timer before the quiet processor phase.
      incoming.setTimeout(0);
      processingTimer = setTimeout(() => {
        if (isStudy && !requestLifetime.signal.aborted) noteStudyAsrStage("host_processing_deadline");
        requestLifetime.abort(Error("native_activity_processing_timeout"));
        if (outgoing.destroyed) return;
        if (outgoing.headersSent) outgoing.destroy();
        else outgoing.writeHead(504, { connection: "close" }).end();
      }, processingMs);
      processingTimer.unref();
    };
    const uploadTimeout = () => {
      if (incoming.complete) {
        finishUpload();
        return;
      }
      if (isStudy && !requestLifetime.signal.aborted) noteStudyAsrStage("host_upload_deadline");
      requestLifetime.abort(Error("native_activity_upload_timeout"));
      incoming.destroy();
    };
    incoming.once("aborted", disconnected);
    outgoing.once("close", disconnected);
    incoming.once("end", finishUpload);
    incoming.once("timeout", uploadTimeout);
    if (bytes) finishUpload();
    else incoming.setTimeout(UPLOAD_IDLE_MS);
    const operation = (async () => {
      let sendingResponse = false;
      try {
        const response = await route(inputRequest(incoming, requestLifetime.signal, bytes), lane);
        if (requestLifetime.signal.aborted || outgoing.destroyed) {
          await response.body?.cancel();
          return;
        }
        sendingResponse = true;
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          await pipeline(
            Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
            outgoing,
            { signal: requestLifetime.signal },
          );
        } else {
          const sent = finished(outgoing, { cleanup: true });
          outgoing.end();
          await sent;
        }
      } catch {
        if (requestLifetime.signal.aborted || outgoing.destroyed) return;
        if (isStudy && sendingResponse) noteStudyAsrStage("host_response_delivery");
        if (!outgoing.headersSent) outgoing.writeHead(503, { connection: "close" }).end();
        else outgoing.destroy();
      } finally {
        clearTimeout(processingTimer);
        incoming.removeListener("end", finishUpload);
        incoming.removeListener("timeout", uploadTimeout);
        incoming.removeListener("aborted", disconnected);
        outgoing.removeListener("close", disconnected);
      }
    })();
    // A cancelled transport keeps its slot until processing and delivery settle.
    const settled = operation.finally(() => {
      if (lane) activeReads.delete(lane);
      else {
        active = undefined;
        if (isPosts) activePosts = undefined;
      }
    });
    if (lane) activeReads.set(lane, settled);
    else {
      active = settled;
      if (isPosts) activePosts = settled;
    }
    void settled.catch(() => outgoing.destroy());
  }

  async function classify(incoming: IncomingMessage, outgoing: ServerResponse, mixed: ProtectedPostsMixedRoute) {
    if (stopping || readingBodies.has(mixed)) {
      outgoing.writeHead(429, { connection: "close" }).end();
      return;
    }
    const auth = incoming.headers.authorization;
    if (incoming.headers["content-type"] !== "application/json" || !auth?.startsWith("Bearer ")) {
      outgoing.writeHead(404, { connection: "close" }).end();
      return;
    }
    // An ordinary request that arrived while a slot was busy cannot use
    // body classification as a queue for the serial effect slot.
    const serialBusyOnArrival = serialOccupied() || postsStopping;
    readingBodies.add(mixed);
    const timer = setTimeout(() => incoming.destroy(), MIXED_POSTS_UPLOAD_MS);
    timer.unref();
    let bytes: Buffer;
    let lane: ProtectedPostsReadLane | undefined;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > protectedPostsMixedLimit(mixed)) {
          outgoing.writeHead(413, { connection: "close" }).end();
          return;
        }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, size);
      lane = protectedPostsReadLane(mixed, bytes);
    } catch {
      if (!outgoing.destroyed) outgoing.writeHead(400, { connection: "close" }).end();
      return;
    } finally {
      clearTimeout(timer);
      readingBodies.delete(mixed);
    }
    if (!lane && serialBusyOnArrival) {
      if (!outgoing.destroyed) outgoing.writeHead(429, { connection: "close" }).end();
      return;
    }
    dispatch(incoming, outgoing, bytes, lane);
  }

  const server = createServer({ requestTimeout: 30000, headersTimeout: 5000, maxHeaderSize: 8192 }, (incoming, outgoing) => {
    const mixed = deferredProtectedPosts && incoming.method === "POST" ? protectedPostsMixedRoute(incoming.url) : undefined;
    if (mixed) void classify(incoming, outgoing, mixed).catch(() => outgoing.destroy());
    else dispatch(incoming, outgoing);
  });
  const close = async () => {
    stopping = true;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await Promise.all([active, ...activeReads.values()]);
    await karaoke?.close();
    await studyAsr?.settled();
  };
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,()=>{
      server.removeListener("error",reject);resolve();
    });});
    await chmod(socket,0o600);
    assert((await realpath(socket))===socket);
    await lease.assertHeld();
    return {
      close,
      async drainProtectedPosts() {
        postsStopping = true;
        await activePosts;
        await activeReads.get("ready");
        await activeReads.get("canonical");
      },
    };
  } catch (error) { await close(); throw error; }
}
