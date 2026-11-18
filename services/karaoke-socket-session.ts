import type { Env } from "./runtime.ts";

export interface PrivateKaraokeLease {
  id: string;
  account: string;
  expiresAt: number;
}

export function readPrivateKaraokeLease(headers: Headers): PrivateKaraokeLease | undefined {
  const id = headers.get("x-pirate-local-karaoke-lease") ?? "";
  const account = (headers.get("x-pirate-local-karaoke-account") ?? "").toLowerCase();
  const expires = headers.get("x-pirate-local-karaoke-expires") ?? "";
  const expiresAt = Number(expires);
  if (/^[0-9a-f]{64}$/.test(id) && /^0x[0-9a-f]{40}$/.test(account) &&
      /^[1-9][0-9]{0,15}$/.test(expires) && Number.isSafeInteger(expiresAt))
    return { id, account, expiresAt };
}

export async function privateKaraokeLeaseCurrent(
  env: Env, lease: PrivateKaraokeLease | undefined,
) {
  if (!lease || !env.KARAOKE_LOCAL_SESSION_GATE ||
      !/^[0-9a-f]{64}$/.test(lease.id) ||
      !Number.isSafeInteger(lease.expiresAt) || Date.now() >= lease.expiresAt)
    return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const current = await Promise.race([
      env.KARAOKE_LOCAL_SESSION_GATE.fetch(
        "http://local-karaoke-session/check/" + lease.id, { signal: controller.signal },
      ).then(response => response.status === 204),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
    return current && Date.now() < lease.expiresAt;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function sendPrivateKaraokeSocket(
  env: Env, ws: WebSocket, lease: PrivateKaraokeLease | undefined,
  currentGeneration: () => boolean, payload: string,
) {
  if (!currentGeneration()) return false;
  if (!await privateKaraokeLeaseCurrent(env, lease)) {
    try { ws.close(4401, "session ended"); } catch {}
    return false;
  }
  if (!currentGeneration() || ws.readyState !== 1) return false;
  try { ws.send(payload); return true; } catch { return false; }
}
