// UNAPPLIED proposal. Request-owned current D1 session authority, never stored.
import {
  accountSession,
  authenticatedWrite,
  type AccountSession,
  type AuthContext,
} from "../packages/community/accounts.ts";
import { CommunityError, insist } from "../packages/community/common.ts";
import type { KaraokeLearner, KaraokePorts } from "./karaoke-community.ts";

/** This object is created only by the authenticated community HTTP caller.
 * Its methods always re-read the original cookie; there is no allow callback,
 * client boolean, serialized capability or fallback for absent authority. */
export class KaraokeRequestSession {
  private readonly request: Request;
  private readonly db: D1Database;
  private readonly original: Readonly<AccountSession>;
  private readonly context: Readonly<AuthContext>;
  constructor(
    request: Request,
    db: D1Database,
    context: AuthContext,
    captured: AccountSession,
  ) {
    insist(
      request.method === "GET" || request.method === "POST",
      "karaoke_request_session_required",
      409,
    );
    // Body parsing has already happened for POST. Preserve actual auth headers
    // and URL/method independently of later caller mutations, without a body.
    this.request = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
    });
    this.db = db;
    this.original = Object.freeze({ ...captured });
    this.context = Object.freeze({ ...context });
    insist(
      this.request.headers.get("x-study-account")?.toLowerCase() ===
        captured.wallet.toLowerCase(),
      "karaoke_session_changed",
      409,
    );
  }

  private validate(current: AccountSession, learner: KaraokeLearner) {
    const original = this.original,
      now = Date.now();
    insist(
      Number.isSafeInteger(current.expires_at) &&
        Number.isSafeInteger(original.expires_at) &&
        now < original.expires_at &&
        now < current.expires_at &&
        current.session_hash === original.session_hash &&
        current.account_id === original.account_id &&
        current.binding_id === original.binding_id &&
        current.author_id === original.author_id &&
        current.wallet.toLowerCase() === original.wallet.toLowerCase() &&
        current.csrf_token === original.csrf_token &&
        current.expires_at === original.expires_at &&
        learner.account_id === original.account_id &&
        learner.wallet.toLowerCase() === original.wallet.toLowerCase() &&
        this.request.headers.get("x-study-account")?.toLowerCase() ===
          current.wallet.toLowerCase(),
      "karaoke_session_changed",
      409,
    );
  }

  private async current(learner: KaraokeLearner) {
    let current: AccountSession;
    try {
      // These are the actual cookie/session producer's readers. POST also
      // preserves original Origin, same-site and CSRF checks on every reread.
      current =
        this.request.method === "POST"
          ? await authenticatedWrite(this.request, this.db, this.context)
          : await accountSession(this.request, this.db, this.context);
    } catch (error) {
      // A late session loss is NOT pre-handler refusal evidence. In particular
      // do not return session_required401/csrf_required403 after reservation:
      // the existing client allows deliberate create retry for those codes.
      throw new CommunityError(
        error instanceof CommunityError
          ? "karaoke_session_changed"
          : "karaoke_session_uncertain",
        error instanceof CommunityError ? 409 : 503,
      );
    }
    // The real reader samples time before its D1 await. Sample again here so
    // expiry during the query is denied at the exact millisecond boundary.
    this.validate(current, learner);
    return current;
  }

  async check(learner: KaraokeLearner): Promise<void> {
    const current = await this.current(learner);
    this.validate(current, learner);
  }

  /** Final HTTP serialization: no awaited operation between live validation
   * and building the actual private JSON Response. The final successful row
   * observation is the allowed linearization point, not network delivery.
   * A proof already serialized/delivered is still a bearer proof; this method
   * does not claim to revoke it when logout commits afterwards. */
  async expose(
    learner: KaraokeLearner,
    serialize: () => Response,
  ): Promise<Response> {
    const current = await this.current(learner);
    this.validate(current, learner);
    const response = serialize();
    insist(
      response instanceof Response,
      "karaoke_session_serializer_required",
      503,
    );
    return response;
  }
}

export interface KaraokeRequestPorts extends KaraokePorts {
  readonly requestSession: KaraokeRequestSession;
}
export function withKaraokeRequestSession(
  ports: KaraokePorts,
  request: Request,
  context: AuthContext,
  captured: AccountSession,
): KaraokeRequestPorts {
  return {
    ...ports,
    requestSession: new KaraokeRequestSession(
      request,
      ports.db,
      context,
      captured,
    ),
  };
}

/** Base ports remain usable by historical direct V2/V3 fixtures. Scoped V4
 * admission/recovery MUST have the real request-owned capability. Missing or
 * structural lookalike/always-allow objects are rejected, never substituted. */
export function requireKaraokeRequestSession(
  ports: KaraokePorts,
): KaraokeRequestSession {
  const candidate = (ports as KaraokeRequestPorts).requestSession;
  insist(
    candidate instanceof KaraokeRequestSession,
    "karaoke_request_session_required",
    409,
  );
  return candidate;
}
