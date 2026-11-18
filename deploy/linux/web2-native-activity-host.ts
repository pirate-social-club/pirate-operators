import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
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
import { publicationHostOrigin, publicationHostPath } from "../../services/native-publication-reference.ts";
import type { NativePublicationActivityRoute } from "./web2-native-publication-host.ts";
import { nativeDanceHostPath } from "../../services/native-dance-retained-reference.ts";

const publicationRoute = (path?: string) => path === publicationHostPath || path === nativeDanceHostPath;

const UPLOAD_IDLE_MS = 15_000;
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
function inputRequest(incoming: IncomingMessage, signal: AbortSignal) {
  const headers = new Headers();
  for (const key of ["authorization", "content-type", "content-length"]) {
    const value = incoming.headers[key];
    if (typeof value === "string") headers.set(key, value);
  }
  const base = publicationRoute(incoming.url) ? publicationHostOrigin : "http://local-activity";
  return new Request(base + incoming.url, { method: "POST", headers,
    body: Readable.toWeb(incoming), signal, duplex: "half" } as RequestInit);
}

/** The existing installed Wizard service owns this Unix listener and its
 * bounded subprocesses. No public socket, provider fallback or second stack. */
export async function startWeb2NativeActivityHost(options: {
  selected: Web2NativeActivityPolicy; study: Web2LocalStudyPolicy; host: Web2NativeActivityHostInputs;
  ingress: PublicIngress; stateRoot: string; lease: OperationLease;
  publication?: NativePublicationActivityRoute;
  deferredPublication?: () => NativePublicationActivityRoute | undefined;
}) {
  const { selected, study, host, ingress, lease, publication, deferredPublication } = options;
  const socket = selected.socket;
  assert(socket === join(options.stateRoot, "activity-transport", "host.sock"), "selected_activity_socket_changed");
  assert(study.asr.upstream === "unix:" + socket &&
    Boolean(selected.karaoke) === Boolean(host.karaoke) && Boolean(selected.dance) === Boolean(host.dance),
    "selected_activity_host_mismatch");
  assert(!(publication && deferredPublication) &&
    (!publication || publication.lease === lease && publication.socket === socket),
    "native_publication_listener_scope_changed");
  await lease.assertHeld();
  await privateDirectory(dirname(socket));
  try { await lstat(socket); throw Error("activity_socket_original_held"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const studyAsr = await selectLocalAsr();
  assert(studyAsr?.selectedProgramSha256 === study.asr.selectedProgramSha256,
    "native_study_program_selection_changed");
  const studyAuth = await privateText(study.asr.authFile);
  const karo = host.karaoke;
  if (karo) {
    assert(selected.karaoke && karo.python.sha256 === selected.karaoke.pythonSha256 &&
      karo.script.sha256 === selected.karaoke.scriptSha256, "karaoke_program_selection_changed");
    await Promise.all([checkTool(karo.python), checkTool(karo.script)]);
    assert(karo.model.startsWith("/") && "0x"+hash(await readFile(karo.model)) === selected.karaoke.modelSha256,
      "karaoke_model_selection_changed");
  }
  const dance = host.dance;
  if (dance) {
    assert(selected.dance && dance.ffmpeg.sha256 === selected.dance.ffmpegSha256 &&
      dance.ffprobe.sha256 === selected.dance.ffprobeSha256 &&
      dance.tempRoot === join(options.stateRoot, "activity-scratch"), "dance_processor_selection_changed");
    await privateDirectory(dance.tempRoot);
    await Promise.all([checkTool(dance.ffmpeg), checkTool(dance.ffprobe)]);
  }
  const ca = dance ? await readFile(ingress.upstreamCaFile) : undefined;
  if (ca) assert(hash(ca) === ingress.upstreamCaSha256, "native_activity_upstream_ca_changed");
  const danceAuth = selected.dance ? await privateText(selected.dance.authorityFile) : undefined;
  const karaoke = karo && selected.karaoke ? localKaraokeTranscriber({
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
  async function route(request: Request) {
    const url = new URL(request.url);
    if (url.search) return new Response(null,{status:404});
    try { await lease.assertHeld(); }
    catch (error) {
      if (url.pathname === "/transcribe") noteStudyAsrStage("host_lease");
      throw error;
    }
    request.signal.throwIfAborted();
    if (publicationRoute(url.pathname) && (publication || deferredPublication)) {
      const route = publication ?? deferredPublication?.();
      if (!route) return new Response(null, { status: 503 });
      assert(route.lease === lease && route.socket === socket, "native_publication_listener_scope_changed");
      return route.fetch(request);
    }
    if(url.pathname==="/transcribe") {
      // The Study bridge checks its scoped bearer before running the model.
      const bytes = await readMediaBody(request,MAX_STUDY_AUDIO_BYTES).catch(error => {
        if (!request.signal.aborted) noteStudyAsrStage("host_body");
        throw error;
      });
      return studyAsr!.route(studyAuth,"POST",request.headers.get("authorization")??"",Buffer.from(bytes),request.signal);
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
  let active: Promise<void> | undefined, stopping = false;
  const server = createServer({requestTimeout:30000,headersTimeout:5000,maxHeaderSize:8192}, (incoming,outgoing)=>{
    if (stopping || active) {outgoing.writeHead(429,{connection:"close"}).end();return;}
    const processingMs = publicationRoute(incoming.url) && (publication || deferredPublication)
      ? 10000 : PROCESSING_MS.get(incoming.url ?? "");
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
    incoming.setTimeout(UPLOAD_IDLE_MS);
    const operation = (async () => {
      let sendingResponse = false;
      try {
        const response = await route(inputRequest(incoming, requestLifetime.signal));
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
    // A cancelled transport never concedes the host's one active slot.
    // Release it only when the original processing and response settle.
    active = operation.finally(() => { active = undefined; });
    void active.catch(() => outgoing.destroy());
  });
  const close = async () => {
    stopping=true;
    server.closeAllConnections();
    if(server.listening) await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await active;await karaoke?.close();await studyAsr!.settled();
  };
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,()=>{
      server.removeListener("error",reject);resolve();
    });});
    await chmod(socket,0o600);
    assert((await realpath(socket))===socket);
    await lease.assertHeld();
    return {close};
  } catch (error) { await close(); throw error; }
}
