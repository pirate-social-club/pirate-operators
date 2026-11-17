import { randomBytes } from "node:crypto";
import { accountSession, type AuthContext } from "../packages/community/accounts.ts";
import type { PrivateKaraokeLease } from "../services/karaoke-socket-session.ts";

export function karaokeLocalSessions(db: D1Database, context: AuthContext) {
  type Entry = {
    lease: PrivateKaraokeLease;
    current(): Promise<boolean>;
    revoke(): void;
  };
  const active = new Map<string, Entry>();
  let closed = false;
  return {
    async capture(cookie: string, disconnect: () => void) {
      if (closed || active.size >= 16) return null;
      const request = new Request(context.origin + "/api/session", { headers: { cookie } });
      const original = await accountSession(request, db, context).catch(() => null);
      if (!original || Date.now() >= original.expires_at || closed || active.size >= 16)
        return null;
      const lease: PrivateKaraokeLease = {
        id: randomBytes(32).toString("hex"),
        account: original.wallet.toLowerCase(),
        expiresAt: original.expires_at,
      };
      const release = () => {
        active.delete(lease.id);
        clearTimeout(expiry);
        clearInterval(recheck);
      };
      const entry: Entry = {
        lease,
        async current() {
          if (active.get(lease.id) !== entry || Date.now() >= lease.expiresAt)
            return false;
          const row = await accountSession(request, db, context).catch(() => null);
          return !!row && active.get(lease.id) === entry &&
            Date.now() < lease.expiresAt && row.expires_at === original.expires_at &&
            row.session_hash === original.session_hash && row.account_id === original.account_id &&
            row.binding_id === original.binding_id && row.author_id === original.author_id &&
            row.wallet === original.wallet &&
            row.csrf_token === original.csrf_token;
        },
        revoke() {
          if (active.get(lease.id) !== entry) return;
          release();
          disconnect();
        },
      };
      active.set(lease.id, entry);
      const expiry = setTimeout(entry.revoke, Math.max(1, Math.min(lease.expiresAt - Date.now(), 2_147_483_647)));
      let checking = false;
      const recheck = setInterval(() => {
        if (checking) return;
        checking = true;
        void entry.current().then(ok => { if (!ok) entry.revoke(); }).finally(() => { checking = false; });
      }, 2000);
      return { ...lease, release };
    },
    async fetch(request: Request) {
      const url = new URL(request.url);
      const match = /^\/check\/([0-9a-f]{64})$/.exec(url.pathname);
      if (url.origin !== "http://local-karaoke-session" || url.search ||
          request.method !== "GET" || !match)
        return new Response(null, { status: 404 });
      const entry = active.get(match[1]!);
      if (!entry || !await entry.current()) {
        // Uncertain authority invalidates the original lease.
        entry?.revoke();
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204 });
    },
    close() {
      closed = true;
      for (const entry of active.values()) entry.revoke();
    },
  };
}
