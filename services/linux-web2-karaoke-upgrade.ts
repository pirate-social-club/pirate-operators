import { accountSession } from "../packages/community/accounts.ts";
import type { CommunityEnv } from "./community-application.ts";
import { communityPrivatePractice } from "./community-private-practice.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { nativeKaraokeSessionRow, type NativeKaraokeLeaseStub } from "./linux-web2-karaoke-session-row.ts";

export interface NativeKaraokeSocketEnv extends CommunityEnv {
  KARAOKE_SOCKET_OPERATOR?: Fetcher;
  KARAOKE_LOCAL_INGRESS?: string;
  KARAOKE_NATIVE_SESSION_CAPTURE?: { getByName(name: string): NativeKaraokeLeaseStub };
}

/** Only the installed app can mint from an authenticated cookie. The operator
 * receives the opaque lease and proof headers, never the auth cookie. */
export async function linuxWeb2KaraokeUpgrade(request: Request, env: NativeKaraokeSocketEnv,
  deployment: Web2CommunityDeploymentProfile) {
  const url = new URL(request.url), operator = env.KARAOKE_SOCKET_OPERATOR,
    ingress = env.KARAOKE_LOCAL_INGRESS, capture = env.KARAOKE_NATIVE_SESSION_CAPTURE,
    context = { communityId: deployment.directoryProfile.communityId, origin: deployment.origin };
  const selection = env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON, db = env.DB;
  if (!communityPrivatePractice(env, deployment)?.activities.karaoke || !operator || !capture ||
      !ingress || !/^[A-Za-z0-9_-]{43}$/.test(ingress)) return new Response(null, { status: 404 });
  const key = request.headers.get("sec-websocket-key"), cookie = request.headers.get("cookie");
  if (request.method !== "GET" || url.origin !== deployment.origin || url.pathname !== "/attempt" ||
      request.headers.get("origin") !== deployment.origin || request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("sec-websocket-version") !== "13" || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      !cookie || !/^0x[0-9a-f]{64}$/.test(url.searchParams.get("ticketId") ?? "") ||
      !/^0x[0-9a-fA-F]{130}$/.test(url.searchParams.get("proof") ?? "") ||
      [...url.searchParams.keys()].length !== 2) return new Response(null, { status: 403 });
  const stable = () => env.DB === db && env.KARAOKE_SOCKET_OPERATOR === operator &&
    env.KARAOKE_LOCAL_INGRESS === ingress && env.KARAOKE_NATIVE_SESSION_CAPTURE === capture &&
    env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON === selection;
  const authority = capture.getByName(context.communityId);
  const session = await accountSession(request, db, context).catch(() => null);
  if (!session || !stable()) return new Response(null, { status: 403 });
  const original = await nativeKaraokeSessionRow(db, context, session.session_hash).catch(() => null);
  if (!original?.matchesAuth(session) || !stable()) return new Response(null, { status: 403 });
  const lease = await authority.capture({ sessionHash: session.session_hash, fingerprint: original.fingerprint }).catch(() => null);
  if (!lease) return new Response(null, { status: 403 });
  let socket: WebSocket | undefined, transferred = false;
  try {
    if (!stable() || lease.account !== original.account || lease.expiresAt !== original.expiresAt ||
        !await authority.current(lease.id) || !stable()) return new Response(null, { status: 403 });
    const response = await operator.fetch("http://service/attempt" + url.search, { headers: {
      upgrade: "websocket", connection: "Upgrade", origin: deployment.origin,
      "sec-websocket-key": key, "sec-websocket-version": "13",
      "x-pirate-local-karaoke-ingress": ingress, "x-pirate-local-karaoke-account": lease.account,
      "x-pirate-local-karaoke-lease": lease.id, "x-pirate-local-karaoke-expires": String(lease.expiresAt),
    } });
    if (response.status !== 101) return response;
    socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    if (!socket || !await authority.current(lease.id) || !stable()) return new Response(null, { status: 403 });
    transferred = true;
    return response;
  } catch {
    return new Response(null, { status: 403 });
  } finally {
    if (!transferred) {
      try { socket?.close(4401, "session ended"); } catch { /* Held socket cannot authorize work. */ }
      await authority.release(lease.id).catch(() => undefined);
    }
  }
}
