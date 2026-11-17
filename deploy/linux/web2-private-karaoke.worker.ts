import { DurableObject } from "cloudflare:workers";
import runtime, { ServiceState as KaraokeAudioState } from "../../services/karaoke-audio-runtime.ts";
import type { Env } from "../../services/runtime.ts";
import { bytes32 } from "../../packages/community/common.ts";
import {
  NativeKaraokeLeaseRegistry, nativeKaraokeSessionRow, type NativeKaraokeLeaseCapture,
} from "../../services/linux-web2-karaoke-session-row.ts";
import { privateKaraokeLeaseCurrent, type PrivateKaraokeLease } from "../../services/karaoke-socket-session.ts";

interface NativeLeaseEnv extends Env {
  KARAOKE_NATIVE_SESSION_SCOPE?: string;
  KARAOKE_NATIVE_SESSION_CAPTURE?: DurableObjectNamespace<NativeKaraokeSessions>;
}

/** Same native module but a distinct internal service with D1. The audio
 * operator receives only the lease-check Fetcher and has no D1 binding. */
export class NativeKaraokeSessions extends DurableObject<NativeLeaseEnv> {
  private readonly registry: NativeKaraokeLeaseRegistry;
  constructor(ctx: DurableObjectState, env: NativeLeaseEnv) {
    super(ctx, env);
    if (!env.DB || !env.KARAOKE_NATIVE_SESSION_SCOPE) throw Error("native_karaoke_lease_scope_required");
    const db = env.DB, input = JSON.parse(env.KARAOKE_NATIVE_SESSION_SCOPE) as { communityId: string; origin: string };
    const scope = Object.freeze({ communityId: bytes32(input.communityId), origin: input.origin });
    if (new URL(scope.origin).origin !== scope.origin || !scope.origin.startsWith("https:"))
      throw Error("native_karaoke_lease_scope_required");
    this.registry = new NativeKaraokeLeaseRegistry(hash => nativeKaraokeSessionRow(db, scope, hash));
  }
  capture(input: NativeKaraokeLeaseCapture) { return this.registry.capture(input); }
  current(id: string) { return this.registry.current(id); }
  release(id: string) { return this.registry.release(id); }
}

function leaseOf(socket: WebSocket) {
  return (socket.deserializeAttachment() as { browserLease?: PrivateKaraokeLease } | null)?.browserLease;
}

/** Uses all owning audio/EOS methods, with a native idle authority sweep and
 * release on transport close. The owning audio operator retains its evidence. */
export class ServiceState extends KaraokeAudioState {
  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    const lease = leaseOf(socket);
    try { await super.webSocketClose(socket, code, reason); }
    finally {
      if (this.env.KARAOKE_LOCAL_SESSION_GATE && lease && /^[0-9a-f]{64}$/.test(lease.id))
        await this.env.KARAOKE_LOCAL_SESSION_GATE.fetch("http://local-karaoke-session/check/"+lease.id,
          { method: "DELETE", signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    }
  }
  override async alarm() {
    try { await super.alarm(); }
    finally {
      const sockets = this.ctx.getWebSockets();
      if (this.env.KARAOKE_PRIVATE_PROFILE && sockets.length) {
        const stillOpen = await Promise.all(sockets.slice(0,16).map(async socket => {
          if (await privateKaraokeLeaseCurrent(this.env, leaseOf(socket))) return socket.readyState === 1;
          try { socket.close(4401,"session ended"); } catch { /* Transport was already lost. */ }
          return false;
        }));
        for (const socket of sockets.slice(16)) try { socket.close(4401,"session ended"); } catch { /* Already closed. */ }
        if (stillOpen.includes(true)) {
          const due = Date.now()+2000, existing = await this.ctx.storage.getAlarm();
          if (existing === null || due < existing) await this.ctx.storage.setAlarm(due);
        }
      }
    }
  }
}

const httpPaths = new Set(["/quote", "/prepare", "/attempt-start", "/result", "/record", "/history"]);
export default {
  async fetch(request: Request, env: NativeLeaseEnv) {
    const url = new URL(request.url);
    if (env.KARAOKE_NATIVE_SESSION_CAPTURE) {
      const lease = /^\/check\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
      if (!lease || url.origin !== "http://local-karaoke-session" || url.search ||
          !["GET","DELETE"].includes(request.method) || !env.KARAOKE_NATIVE_SESSION_SCOPE)
        return new Response(null,{status:404});
      const scope = JSON.parse(env.KARAOKE_NATIVE_SESSION_SCOPE) as {communityId:string};
      const gate = env.KARAOKE_NATIVE_SESSION_CAPTURE.getByName(bytes32(scope.communityId));
      if (request.method === "DELETE") {
        await gate.release(lease);
        return new Response(null,{status:204});
      }
      return new Response(null,{status:await gate.current(lease)?204:403});
    }
    const socket = url.origin === "http://service" && url.pathname === "/attempt" &&
      request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (!socket && (url.origin !== "http://service" || request.method !== "POST" ||
        url.search || !httpPaths.has(url.pathname))) return new Response(null, { status: 404 });
    return runtime.fetch(request, env);
  },
};
