import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isAbsolute } from "node:path";
import type { Hex } from "viem";
import type { karaokeLocalSessions } from "./karaoke-local-session.ts";
import { karaokeNativeFailureHeader, type KaraokeNativeFailureOutcome } from "../packages/karaoke/stt-adapter.ts";

const INPUT_LIMIT = 32_000 * 30;
const OUTPUT_LIMIT = 65_536;

type BridgeFailure = KaraokeNativeFailureOutcome | "model_changed" | "timeout";
const nativeExitOutcome: Readonly<Partial<Record<number, BridgeFailure>>> = {
  64: "bridge_input",
  65: "model_changed",
  66: "native_boot",
  67: "native_decode",
  68: "token_text",
  69: "token_timing",
  70: "native_output",
  71: "native_internal",
};

function nativeFailure(outcome: BridgeFailure, status = 503): Response {
  return new Response(null, { status, headers: { [karaokeNativeFailureHeader]: outcome } });
}

export function localKaraokeTranscriber(options: {
  python: string; script: string; model: string; modelSha256: Hex;
}) {
  if (![options.python, options.script, options.model].every(isAbsolute) ||
      !/^0x[0-9a-f]{64}$/.test(options.modelSha256))
    throw Error("karaoke_local_recognizer_pin_invalid");
  let child: ChildProcessWithoutNullStreams | null = null;
  let busy = false;
  let closed = false;
  const fetchLocal = async (request: Request): Promise<Response> => {
    if (new URL(request.url).href !== "http://local-karaoke/recognize" ||
        request.method !== "POST" || request.headers.get("content-type") !== "application/octet-stream")
      return new Response(null, { status: 404 });
    if (closed) return nativeFailure("bridge_cancelled");
    if (busy) return nativeFailure("bridge_busy");
    busy = true;
    try {
      if (Number(request.headers.get("content-length") ?? 0) > INPUT_LIMIT)
        return nativeFailure("bridge_input_limit", 413);
      const reader = request.body?.getReader();
      if (!reader) return nativeFailure("bridge_input", 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        readTimer = setTimeout(() => reject(Error("karaoke_local_pcm_timeout")), 1000);
      });
      try {
        for (;;) {
          const item = await Promise.race([reader.read(), timeout]);
          if (item.done) break;
          size += item.value.byteLength;
          if (size > INPUT_LIMIT) return nativeFailure("bridge_input_limit", 413);
          chunks.push(item.value);
        }
      } catch {
        return nativeFailure("bridge_input", 400);
      } finally {
        clearTimeout(readTimer);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!size || size % 2) return nativeFailure("bridge_input", 400);
      if (request.signal.aborted || closed) return nativeFailure("bridge_cancelled");

      const owned = spawn(options.python, [options.script, options.model, options.modelSha256], {
        shell: false, stdio: "pipe", env: { PATH: "/usr/bin:/bin", OPENBLAS_NUM_THREADS: "1" },
      });
      child = owned;
      const stop = () => { owned.kill("SIGKILL"); };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stop(); }, 10_000);
      request.signal.addEventListener("abort", stop, { once: true });
      try {
        const output: Buffer[] = [];
        let length = 0;
        let spawnFailed = false;
        let stdinFailed = false;
        const { code, signal } = await new Promise<{
          code: number | null; signal: NodeJS.Signals | null;
        }>((resolve) => {
          owned.on("error", () => { spawnFailed = true; });
          owned.stdin.on("error", () => { stdinFailed = true; });
          owned.stderr.resume();
          owned.stdout.on("data", (part: Buffer) => {
            length += part.length;
            if (length > OUTPUT_LIMIT) stop();
            else output.push(part);
          });
          owned.once("close", (code, signal) => resolve({ code, signal }));
          owned.stdin.end(Buffer.concat(chunks));
        });
        if (timedOut) return nativeFailure("timeout", 504);
        if (request.signal.aborted || closed) return nativeFailure("bridge_cancelled");
        if (length > OUTPUT_LIMIT) return nativeFailure("native_output");
        if (spawnFailed) return nativeFailure("child_spawn");
        const outcome = code === null ? undefined : nativeExitOutcome[code];
        if (outcome) return nativeFailure(outcome, outcome === "model_changed" ? 409 : 503);
        if (signal) return nativeFailure("child_signal");
        if (stdinFailed) return nativeFailure("child_stdin");
        if (code !== 0) return nativeFailure("child_exit");
        if (length === 0) return nativeFailure("native_output");
        return new Response(new Uint8Array(Buffer.concat(output)), {
          headers: { "content-type": "application/json" },
        });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", stop);
        child = null;
      }
    } finally {
      busy = false;
    }
  };
  return {
    fetch: fetchLocal,
    async close() {
      closed = true;
      const owned = child;
      if (owned) await new Promise<void>(resolve => {
        owned.once("close", () => resolve());
        owned.kill("SIGKILL");
      });
    },
  };
}

/** One owned HTTPS ingress delegates only its authenticated /attempt upgrade to
 * the loopback worker. The worker still checks the original ticket and proof. */
export function localKaraokeUpgrade(options: {
  origin: string;
  operator: URL;
  sessions: ReturnType<typeof karaokeLocalSessions>;
  ingressBinding: string;
}) {
  if (options.operator.protocol !== "http:" || options.operator.hostname !== "127.0.0.1")
    throw Error("karaoke_local_operator_loopback_required");
  const sockets = new Set<Duplex>();
  let closed = false;
  function upgrade(request: IncomingMessage, downstream: Duplex, head: Buffer) {
    sockets.add(downstream);
    downstream.once("close", () => sockets.delete(downstream));
    downstream.on("error", () => downstream.destroy());
    downstream.pause();
    const timer = setTimeout(() => downstream.destroy(), 5000);
    downstream.once("close", () => clearTimeout(timer));
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", options.origin);
        const key = request.headers["sec-websocket-key"];
        if (closed || request.headers.host !== new URL(options.origin).host ||
            request.headers.origin !== options.origin || url.origin !== options.origin ||
            url.pathname !== "/attempt" || request.method !== "GET" || head.length !== 0 ||
            request.headers.upgrade?.toLowerCase() !== "websocket" ||
            typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
            request.headers["sec-websocket-version"] !== "13" ||
            !/^0x[0-9a-f]{64}$/.test(url.searchParams.get("ticketId") ?? "") ||
            !/^0x[0-9a-fA-F]{130}$/.test(url.searchParams.get("proof") ?? "") ||
            [...url.searchParams.keys()].length !== 2) {
          downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        const lease = request.headers.cookie
          ? await options.sessions.capture(request.headers.cookie, () => downstream.destroy())
          : null;
        if (!lease || closed || downstream.destroyed) {
          lease?.release();
          downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        downstream.once("close", lease.release);
        const upstream = httpRequest(new URL("/attempt" + url.search, options.operator), {
          headers: { upgrade: "websocket", connection: "Upgrade", origin: options.origin,
            "sec-websocket-key": key, "sec-websocket-version": "13",
            "x-pirate-local-karaoke-ingress": options.ingressBinding,
            "x-pirate-local-karaoke-account": lease.account,
            "x-pirate-local-karaoke-lease": lease.id,
            "x-pirate-local-karaoke-expires": String(lease.expiresAt) },
        });
        downstream.once("close", () => upstream.destroy());
        upstream.once("error", () => downstream.destroy());
        upstream.once("response", res => { res.resume(); downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
        upstream.once("upgrade", (res, socket, buffered) => {
          const accept = res.headers["sec-websocket-accept"];
          if (closed || downstream.destroyed || res.statusCode !== 101 || typeof accept !== "string") {
            socket.destroy(); downstream.destroy(); return;
          }
          clearTimeout(timer);
          sockets.add(socket);
          socket.once("close", () => { sockets.delete(socket); downstream.destroy(); });
          socket.on("error", () => socket.destroy());
          downstream.once("close", () => socket.destroy());
          downstream.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
          if (buffered.length) downstream.write(buffered);
          socket.pipe(downstream);
          downstream.pipe(socket);
          downstream.resume();
        });
        upstream.end();
      } catch {
        downstream.destroy();
      }
    })();
  }
  return {
    upgrade,
    close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
    },
  };
}

export const createKaraokeIngressBinding = () => randomBytes(32).toString("hex");
