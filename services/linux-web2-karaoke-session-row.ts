import { canonical, hashText } from "../packages/community/common.ts";
import type { AccountSession, AuthContext } from "../packages/community/accounts.ts";
import type { PrivateKaraokeLease } from "./karaoke-socket-session.ts";

export interface NativeKaraokeLeaseCapture {
  sessionHash: string;
  fingerprint: string;
}
export interface NativeKaraokeLeaseStub {
  capture(selected: NativeKaraokeLeaseCapture): Promise<PrivateKaraokeLease | null>;
  current(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
}
interface NativeSessionRow extends AccountSession {
  original_digest: string;
  session_rowid: number;
  account_rowid: number;
  credential_rowid: number;
  account_created: number;
  credential_created: number;
}

/** One primary read of the exact cookie row's installed native incarnation.
 * The separate lease actor receives a hash of these facts and never the cookie
 * or CSRF value. The signed installer still owns the original application row. */
export async function nativeKaraokeSessionRow(db: D1Database, context: AuthContext, sessionHash: string) {
  if (!/^0x[a-f0-9]{64}$/.test(sessionHash)) return null;
  const row = await db.withSession("first-primary").prepare(`
    SELECT s.session_hash,s.account_id,s.binding_id,s.csrf_token,s.expires_at,a.author_id,c.subject wallet,
      n.original_digest,s.rowid session_rowid,a.rowid account_rowid,c.rowid credential_rowid,
      a.created_at account_created,c.created_at credential_created
      FROM community_sessions s
      JOIN community_accounts a ON a.account_id=s.account_id
      JOIN credential_bindings c ON c.binding_id=s.binding_id AND c.account_id=s.account_id
      JOIN application_identity i ON i.id=1 AND i.community_id=s.community_id AND i.community_origin=s.community_origin
      JOIN native_application_original n ON n.singleton=1
      JOIN native_business_bindings b ON b.kind='session' AND b.session_hash=s.session_hash AND b.record_id=s.session_hash
        AND b.account_id=s.account_id AND b.original_digest=n.original_digest
      WHERE s.session_hash=? AND s.community_id=? AND s.community_origin=? AND s.expires_at>?
        AND c.namespace='moss' AND c.network=6343`)
    .bind(sessionHash, context.communityId, context.origin, Date.now()).first<NativeSessionRow>();
  if (!row || !Number.isSafeInteger(row.expires_at) || row.expires_at <= Date.now() ||
      !/^0x[a-fA-F0-9]{40}$/.test(row.wallet)) return null;
  return {
    account: row.wallet.toLowerCase(),
    expiresAt: row.expires_at,
    fingerprint: hashText(canonical({ origin: context.origin, communityId: context.communityId, row })),
    matchesAuth(session: AccountSession) {
      return row.session_hash === session.session_hash && row.account_id === session.account_id &&
        row.binding_id === session.binding_id && row.author_id === session.author_id &&
        row.wallet === session.wallet && row.csrf_token === session.csrf_token && row.expires_at === session.expires_at;
    },
  };
}

/** Keeps passing proofs only for this process and never restores leases from
 * native application or operator disk. The retained ticket is a separate object. */
export class NativeKaraokeLeaseRegistry implements NativeKaraokeLeaseStub {
  private readonly entries = new Map<string, { selected: NativeKaraokeLeaseCapture; lease: PrivateKaraokeLease }>();
  private readonly read: (hash: string) => ReturnType<typeof nativeKaraokeSessionRow>;

  constructor(read: (hash: string) => ReturnType<typeof nativeKaraokeSessionRow>) {
    this.read = read;
  }
  async capture(value: NativeKaraokeLeaseCapture) {
    const selected = Object.freeze({ sessionHash: value.sessionHash, fingerprint: value.fingerprint });
    if (!/^0x[a-f0-9]{64}$/.test(selected.sessionHash) || !/^0x[a-f0-9]{64}$/.test(selected.fingerprint)) return null;
    const row = await this.read(selected.sessionHash);
    if (!row || row.fingerprint !== selected.fingerprint || Date.now() >= row.expiresAt) return null;
    for (const [id, entry] of this.entries) if (Date.now() >= entry.lease.expiresAt) this.entries.delete(id);
    if (this.entries.size >= 16) return null;
    let id: string;
    do id = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
    while (this.entries.has(id));
    const lease = Object.freeze({ id, account: row.account, expiresAt: row.expiresAt });
    this.entries.set(id, { selected, lease });
    return { ...lease };
  }
  async current(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const row = Date.now() < entry.lease.expiresAt ? await this.read(entry.selected.sessionHash).catch(() => null) : null;
    if (this.entries.get(id) !== entry) return false;
    if (row && row.fingerprint === entry.selected.fingerprint && row.account === entry.lease.account &&
        row.expiresAt === entry.lease.expiresAt && Date.now() < entry.lease.expiresAt) return true;
    this.entries.delete(id);
    return false;
  }
  async release(id: string) { this.entries.delete(id); }
}
