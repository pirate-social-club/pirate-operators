import type { Address, Hex } from "viem";
import {
  accountSession,
  authenticatedWrite,
  type AccountSession,
  type AuthContext,
} from "../packages/community/accounts.ts";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  consentAddress,
  consentDigest,
} from "../packages/protocol/publication-consent.ts";
import { exact, record, same, source } from "./publication-command-contract.ts";
import type { CommandRow } from "./publication-command-store.ts";
import {
  publicationSelectionHash,
  publicationSelectionSource,
  type PublicationAppRelease,
  type PublicationReleaseCatalog,
} from "./publication-app-selection.ts";

export interface PublicationOriginalCapture {
  schema: "pirate.publication-app-original/1";
  accountId: string;
  bindingId: string;
  authorId: Hex;
  learner: Address;
  origin: string;
  releaseSelectionSha256: Hex;
  sourceCommandId: Hex | null;
}
/** Real request-owned session incarnation. Secrets remain only in memory.
 * Re-read the actual request after every wait and immediately before exposure. */
export class PublicationRequestSession {
  private readonly request: Request;
  readonly db: D1Database;
  readonly context: Readonly<AuthContext>;
  readonly original: Readonly<AccountSession>;
  private constructor(
    request: Request,
    db: D1Database,
    context: Readonly<AuthContext>,
    original: Readonly<AccountSession>,
  ) {
    this.request = request;
    this.db = db;
    this.context = context;
    this.original = original;
  }
  static async open(request: Request, db: D1Database, context: AuthContext) {
    check(
      request.method === "GET" || request.method === "POST",
      "publication_method_invalid",
    );
    const capturedContext = Object.freeze({ ...context });
    const copy = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
    });
    const cookies =
      copy.headers
        .get("cookie")
        ?.split(";")
        .map((c) => c.trim())
        .filter((c) => c.startsWith("__Host-community_session=")) ?? [];
    check(
      cookies.length === 1 &&
        /^__Host-community_session=[a-f0-9]{64}(?![\s\S])/.test(cookies[0]!),
      "publication_session_required",
    );
    const original = await (copy.method === "POST"
      ? authenticatedWrite(copy, db, capturedContext)
      : accountSession(copy, db, capturedContext));
    const expected = copy.headers.get("x-study-account");
    check(
      expected === null ||
        expected.toLowerCase() === original.wallet.toLowerCase(),
      "publication_session_account_changed",
    );
    const result = new PublicationRequestSession(
      copy,
      db,
      capturedContext,
      Object.freeze({ ...original }),
    );
    await result.check();
    return result;
  }
  async check() {
    const s = await (this.request.method === "POST"
        ? authenticatedWrite(this.request, this.db, this.context)
        : accountSession(this.request, this.db, this.context)),
      o = this.original;
    check(
      s.session_hash === o.session_hash &&
        s.account_id === o.account_id &&
        s.binding_id === o.binding_id &&
        s.author_id === o.author_id &&
        s.wallet.toLowerCase() === o.wallet.toLowerCase() &&
        s.csrf_token === o.csrf_token &&
        s.expires_at === o.expires_at &&
        Number.isSafeInteger(s.expires_at) &&
        Date.now() < s.expires_at,
      "publication_session_changed",
    );
  }
  capture(
    release: PublicationAppRelease,
    sourceCommandId: Hex | null = null,
  ): PublicationOriginalCapture {
    check(
      this.request.method === "POST" &&
        release.source.communityId === this.context.communityId &&
        release.configuration.app.origin === this.context.origin,
      "publication_request_context_changed",
    );
    const o = this.original;
    return {
      schema: "pirate.publication-app-original/1",
      accountId: o.account_id,
      bindingId: o.binding_id,
      authorId: consentDigest(o.author_id),
      learner: consentAddress(o.wallet.toLowerCase()),
      origin: this.context.origin,
      releaseSelectionSha256: publicationSelectionHash(release),
      sourceCommandId,
    };
  }
  assertOriginal(c: PublicationOriginalCapture) {
    const o = this.original;
    check(
      c.accountId === o.account_id &&
        c.bindingId === o.binding_id &&
        c.authorId === o.author_id &&
        c.learner === o.wallet.toLowerCase(),
      "publication_original_learner_changed",
    );
  }
  /** Actual auth rows and DB clock in the same mutation, never a durable
   * cookie/CSRF capability or an asynchronous allow callback. */
  mutationFence(input: {
    db: D1Database;
    accountId: string;
    communityId: Hex;
  }) {
    check(
      this.request.method === "POST",
      "publication_request_context_changed",
    );
    return this.observationFence(input);
  }
  /** Completes an already signed, canonically recorded original during an
   * authenticated observation. GET never authorizes new wallet consent. */
  observationFence(input: {
    db: D1Database;
    accountId: string;
    communityId: Hex;
  }) {
    const o = this.original;
    check(
      input.db === this.db &&
        input.accountId === o.account_id &&
        input.communityId === this.context.communityId,
      "publication_request_context_changed",
    );
    return {
      sql: `EXISTS(SELECT 1 FROM community_sessions s
      JOIN community_accounts a ON a.account_id=s.account_id
      JOIN credential_bindings b ON b.binding_id=s.binding_id AND b.account_id=s.account_id
      WHERE s.session_hash=? AND s.account_id=? AND s.binding_id=? AND s.community_id=?
      AND s.community_origin=? AND s.csrf_token=? AND s.expires_at=?
      AND s.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND a.author_id=? AND lower(b.subject)=?)`,
      values: [
        o.session_hash,
        o.account_id,
        o.binding_id,
        this.context.communityId,
        this.context.origin,
        o.csrf_token,
        o.expires_at,
        o.author_id,
        o.wallet.toLowerCase(),
      ],
    };
  }
  async expose(body: unknown, status = 200) {
    const bytes = canonical(body);
    await this.check();
    // No await after the final concrete session read and expiry check.
    check(Date.now() < this.original.expires_at, "publication_session_changed");
    return new Response(bytes, {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
}
export function publicationOriginal(
  row: CommandRow,
  catalog: PublicationReleaseCatalog,
) {
  check(
    digest(JSON.parse(row.request_json)) === row.request_hash,
    "publication_original_changed",
  );
  const request = record(JSON.parse(row.request_json)),
    c = record(request.capture);
  exact(c, [
    "schema",
    "accountId",
    "bindingId",
    "authorId",
    "learner",
    "origin",
    "releaseSelectionSha256",
    "sourceCommandId",
  ]);
  check(
    c.schema === "pirate.publication-app-original/1" &&
      c.accountId === row.account_id &&
      typeof c.bindingId === "string" &&
      /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(c.bindingId) &&
      typeof c.origin === "string" &&
      new URL(c.origin).origin === c.origin,
    "publication_original_invalid",
  );
  consentAddress(c.learner);
  consentDigest(c.authorId);
  consentDigest(c.releaseSelectionSha256);
  if (c.sourceCommandId !== null) consentDigest(c.sourceCommandId);
  check(
    row.action === "withdraw"
      ? c.sourceCommandId !== null
      : c.sourceCommandId === null,
    "publication_original_source_reference_invalid",
  );
  const original = c as unknown as PublicationOriginalCapture;
  const release = catalog.get(original.releaseSelectionSha256),
    s = source(request.source);
  check(
    same(s, publicationSelectionSource(release)) &&
      s.communityId === row.community_id &&
      original.origin === release.configuration.app.origin &&
      request.accountId === row.account_id &&
      request.requestId === row.request_id &&
      request.action === row.action &&
      request.purpose === row.purpose,
    "publication_original_changed",
  );
  return { capture: original, release, source: s };
}
