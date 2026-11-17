import type { Address, Hex } from "viem";
import { accountSession, authenticatedWrite, type AccountSession, type AuthContext } from "../packages/community/accounts.ts";
import { bytes32, CommunityError, insist } from "../packages/community/common.ts";
import { equalTokens } from "../packages/community/token-comparison.ts";
import type { DanceFence, SqlValue } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";

export interface DancePrivateActor {
  readonly accountId: string;
  readonly wallet: Address;
  readonly bindingId: string;
  readonly authorId: Hex;
}
interface Envelope {
  request: Request;
  authRequest: Request;
  liveContext: AuthContext;
  context: Readonly<AuthContext>;
  signature: string;
}
interface Snapshot extends AccountSession {
  session_rowid: number;
  account_rowid: number;
  account_created_at: number;
  binding_rowid: number;
  binding_created_at: number;
  namespace: string;
  network: number;
  community_id: string;
  community_origin: string;
}
const authKeys = ["session_hash", "account_id", "binding_id", "author_id", "wallet", "csrf_token", "expires_at"] as const;
const factKeys = [...authKeys, "session_rowid", "account_rowid", "account_created_at", "binding_rowid",
  "binding_created_at", "namespace", "network", "community_id", "community_origin"] as const;
const signature = (request: Request) => JSON.stringify([request.url, request.method, [...request.headers]]);
const lost = () => new CommunityError("dance_private_session_changed", 409);

function stable(e: Envelope) {
  insist(signature(e.request) === e.signature && e.liveContext.communityId === e.context.communityId &&
    e.liveContext.origin === e.context.origin, "dance_private_session_changed", 409);
}
async function authenticate(e: Envelope, db: D1Database) {
  const write = e.authRequest.method !== "GET" && e.authRequest.method !== "HEAD";
  const current = await (write ? authenticatedWrite(e.authRequest, db, e.context)
    : accountSession(e.authRequest, db, e.context));
  stable(e);
  // Existing plain-cookie GETs remain possible. A supplied CSRF or expected
  // account is a captured-client guard, never a replacement for the cookie.
  const csrf = e.authRequest.headers.get("x-csrf-token");
  insist(csrf === null || equalTokens(csrf, current.csrf_token), "csrf_required", 403);
  const account = e.authRequest.headers.get("x-dance-account");
  insist(account === null || account === current.account_id, "dance_private_session_changed", 409);
  insist(Number.isSafeInteger(current.expires_at) && Date.now() < current.expires_at, "session_required", 401);
  return current;
}
async function snapshot(e: Envelope, db: D1Database, original: AccountSession) {
  const row = await db.prepare(`SELECT s.rowid session_rowid,s.session_hash,s.account_id,s.binding_id,
      s.csrf_token,s.expires_at,s.community_id,s.community_origin,a.rowid account_rowid,
      a.author_id,a.created_at account_created_at,c.rowid binding_rowid,c.created_at binding_created_at,
      c.namespace,c.network,c.subject wallet
    FROM community_sessions s JOIN community_accounts a ON a.account_id=s.account_id
    JOIN credential_bindings c ON c.binding_id=s.binding_id AND c.account_id=s.account_id
    JOIN application_identity i ON i.id=1 AND i.community_id=s.community_id AND i.community_origin=s.community_origin
    WHERE s.session_hash=? AND s.community_id=? AND s.community_origin=?
      AND s.expires_at>${DANCE_DB_NOW} AND c.namespace='moss' AND c.network=6343`)
    .bind(original.session_hash, e.context.communityId, e.context.origin).first<Snapshot>();
  stable(e);
  insist(row && authKeys.every(key => row[key] === original[key]), "dance_private_session_changed", 409);
  for (const key of ["session_rowid", "account_rowid", "binding_rowid"] as const)
    insist(Number.isSafeInteger(row[key]) && row[key] > 0, "dance_private_session_changed", 409);
  for (const key of ["account_created_at", "binding_created_at"] as const)
    insist(Number.isSafeInteger(row[key]) && row[key] >= 0, "dance_private_session_changed", 409);
  bytes32(row.author_id);
  insist(/^0x[0-9a-f]{40}$/.test(row.wallet) && BigInt(row.wallet) !== 0n,
    "dance_private_session_changed", 409);
  return row;
}
function freezeFence(sql: string, values: SqlValue[]): DanceFence {
  Object.freeze(values); return Object.freeze({ sql, values });
}
function acceptingFences(s: Snapshot, context: Readonly<AuthContext>): readonly DanceFence[] {
  return Object.freeze([
    freezeFence("EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)",
      [context.communityId, context.origin]),
    freezeFence(`EXISTS(SELECT 1 FROM community_sessions WHERE rowid=? AND session_hash=? AND account_id=?
      AND binding_id=? AND csrf_token=? AND expires_at=? AND expires_at>${DANCE_DB_NOW}
      AND community_id=? AND community_origin=?)`,
      [s.session_rowid, s.session_hash, s.account_id, s.binding_id, s.csrf_token, s.expires_at, context.communityId, context.origin]),
    freezeFence("EXISTS(SELECT 1 FROM community_accounts WHERE rowid=? AND account_id=? AND author_id=? AND created_at=?)",
      [s.account_rowid, s.account_id, s.author_id, s.account_created_at]),
    freezeFence("EXISTS(SELECT 1 FROM credential_bindings WHERE rowid=? AND binding_id=? AND account_id=? AND namespace='moss' AND network=6343 AND subject=? AND created_at=?)",
      [s.binding_rowid, s.binding_id, s.account_id, s.wallet, s.binding_created_at]),
  ]);
}

/** Request-owned plain private authority. No public consent, V4/V5 permission,
 * installation, source selection, nonce, wallet approval or publication work.
 * Call check() after each await and consume ALL fences in the accepting D1
 * batch. check() observes a live SQL read; fences close the read-to-write gap.
 * An observed identity/header loss permanently invalidates this instance. */
export class DancePrivateRequestSession {
  private readonly envelope: Envelope;
  private readonly db: D1Database;
  private readonly original: Readonly<AccountSession>;
  private readonly facts: Readonly<Snapshot>;
  private readonly capturedActor: Readonly<DancePrivateActor>;
  private readonly predicates: readonly DanceFence[];
  private invalid = false;

  private constructor(e: Envelope, db: D1Database, original: AccountSession, facts: Snapshot) {
    this.envelope = e; this.db = db;
    this.original = Object.freeze({ ...original }); this.facts = Object.freeze({ ...facts });
    this.capturedActor = Object.freeze({ accountId: facts.account_id, wallet: facts.wallet,
      bindingId: facts.binding_id, authorId: facts.author_id });
    this.predicates = acceptingFences(facts, e.context);
  }

  static async open(request: Request, db: D1Database, context: AuthContext): Promise<DancePrivateRequestSession> {
    insist(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method), "method_not_allowed", 405);
    bytes32(context.communityId);
    const origin = new URL(context.origin);
    insist(origin.protocol === "https:" && origin.origin === context.origin, "invalid_community_origin");
    const e: Envelope = { request, authRequest: new Request(request.url, {
      method: request.method, headers: new Headers(request.headers),
    }), liveContext: context, context: Object.freeze({ ...context }), signature: signature(request) };
    try {
      const original = await authenticate(e, db); stable(e);
      const facts = await snapshot(e, db, original); stable(e);
      const session = new DancePrivateRequestSession(e, db, original, facts);
      await session.check(); return session;
    } catch (error) { stable(e); throw error; }
  }

  private active() {
    try {
      if (this.invalid) throw lost();
      stable(this.envelope);
      insist(Date.now() < this.original.expires_at, "dance_private_session_changed", 409);
    } catch { this.invalid = true; throw lost(); }
  }
  get actor(): Readonly<DancePrivateActor> { this.active(); return this.capturedActor; }
  get fences(): readonly DanceFence[] { this.active(); return this.predicates; }

  async check(): Promise<void> {
    this.active();
    try {
      const current = await authenticate(this.envelope, this.db); this.active();
      insist(authKeys.every(key => current[key] === this.original[key]), "dance_private_session_changed", 409);
      const facts = await snapshot(this.envelope, this.db, this.original); this.active();
      insist(factKeys.every(key => facts[key] === this.facts[key]), "dance_private_session_changed", 409);
    } catch (error) {
      this.active();
      if (error instanceof CommunityError) { this.invalid = true; throw lost(); }
      throw new CommunityError("dance_private_session_uncertain", 503);
    }
  }
}
