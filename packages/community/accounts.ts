import { createSiweMessage } from "viem/siwe";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  cookie,
  bytes32,
  hashText,
  insist,
  publicId,
  requestOrigin,
  token,
} from "./common.ts";
import { equalTokens } from "./token-comparison.ts";
import {
  resultsV4Domain,
  signInIdV4,
  signInTypes,
  type SignIn,
} from "../protocol/learning-results-v4.ts";

export interface AccountSession {
  session_hash: string;
  account_id: string;
  binding_id: string;
  author_id: Hex;
  wallet: Address;
  csrf_token: string;
  expires_at: number;
}
export interface AuthContext {
  communityId: Hex;
  origin: string;
}
export async function ensureCommunityIdentity(
  db: D1Database,
  context: AuthContext,
) {
  bytes32(context.communityId);
  const url = new URL(context.origin);
  insist(
    url.protocol === "https:" && url.origin === context.origin,
    "invalid_community_origin",
  );
  await db
    .prepare(
      "INSERT INTO application_identity(id,community_id,community_origin) VALUES(1,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(context.communityId, context.origin)
    .run();
  const saved = await db
    .prepare(
      "SELECT community_id,community_origin FROM application_identity WHERE id=1",
    )
    .first<{ community_id: string; community_origin: string }>();
  insist(
    saved?.community_id === context.communityId &&
      saved.community_origin === context.origin,
    "database_community_mismatch",
    503,
  );
}
/** The V4 results contract a sign-in authorizes, when the community uses it. */
export interface SignInV4 {
  chainId: number;
  contract: Address;
  communityId: Hex;
  publicationPolicy: Hex;
  policyVersion: number;
}
/** SignIn as the wallet receives it: integers are decimal strings. */
export interface SignInMessage {
  learner: Address;
  communityId: Hex;
  origin: string;
  publicationPolicy: Hex;
  nonce: Hex;
  issuedAt: string;
  expiresAt: string;
}
export interface SignInTypedData {
  domain: ReturnType<typeof resultsV4Domain>;
  types: typeof signInTypes;
  primaryType: "SignIn";
  message: SignInMessage;
}
/** What a verifier checks: the SIWE text, or the V4 SignIn typed data. */
export type LoginProof =
  | string
  | {
      domain: ReturnType<typeof resultsV4Domain>;
      types: typeof signInTypes;
      primaryType: "SignIn";
      message: SignIn;
    };
export type VerifyLogin = (
  address: Address,
  proof: LoginProof,
  signature: Hex,
) => Promise<boolean>;
export const signInFromMessage = (m: SignInMessage): SignIn => ({
  learner: m.learner,
  communityId: m.communityId,
  origin: m.origin,
  publicationPolicy: m.publicationPolicy,
  nonce: m.nonce,
  issuedAt: BigInt(m.issuedAt),
  expiresAt: BigInt(m.expiresAt),
});

export interface SiweChallenge {
  id: string;
  message: string;
}
export interface SignInChallenge {
  id: string;
  kind: "sign-in-v4";
  typedData: SignInTypedData;
}
/** Without a V4 configuration the challenge is exactly the SIWE message. */
export async function loginChallenge(
  db: D1Database,
  context: AuthContext,
  address: unknown,
  time?: number,
): Promise<SiweChallenge>;
export async function loginChallenge(
  db: D1Database,
  context: AuthContext,
  address: unknown,
  time: number,
  signInV4: SignInV4 | undefined,
): Promise<SiweChallenge | SignInChallenge>;
export async function loginChallenge(
  db: D1Database,
  context: AuthContext,
  address: unknown,
  time = Date.now(),
  signInV4?: SignInV4,
): Promise<SiweChallenge | SignInChallenge> {
  await ensureCommunityIdentity(db, context);
  const origin = context.origin;
  insist(typeof address === "string" && isAddress(address), "invalid_wallet");
  const subject = address.toLowerCase();
  const id = token();
  if (signInV4) {
    insist(
      signInV4.communityId === context.communityId &&
        isAddress(signInV4.contract) &&
        bytes32(signInV4.publicationPolicy) &&
        (signInV4.chainId === 6343 || signInV4.chainId === 31337) &&
        Number.isSafeInteger(signInV4.policyVersion) &&
        signInV4.policyVersion > 0,
      "sign_in_unavailable",
      503,
    );
    const issuedAt = Math.floor(time / 1000);
    const typedData: SignInTypedData = {
      domain: resultsV4Domain(signInV4.chainId, getAddress(signInV4.contract)),
      types: signInTypes,
      primaryType: "SignIn",
      message: {
        learner: getAddress(address),
        communityId: context.communityId,
        origin,
        publicationPolicy: signInV4.publicationPolicy,
        nonce: publicId(),
        issuedAt: String(issuedAt),
        expiresAt: String(issuedAt + 300),
      },
    };
    await db
      .prepare(
        "INSERT INTO login_challenges(challenge_id,community_id,community_origin,subject,message,expires_at,kind,policy_version) VALUES(?,?,?,?,?,?,'sign-in-v4',?)",
      )
      .bind(
        id,
        context.communityId,
        origin,
        subject,
        JSON.stringify(typedData),
        time + 300_000,
        signInV4.policyVersion,
      )
      .run();
    return { id, kind: "sign-in-v4" as const, typedData };
  }
  const message = createSiweMessage({
    address: address as Address,
    chainId: 6343,
    domain: new URL(origin).host,
    uri: origin,
    version: "1",
    nonce: token(),
    issuedAt: new Date(time),
    expirationTime: new Date(time + 300_000),
    statement:
      "Sign in to this community. This does not join, create a creator wallet or authorize spending.",
  });
  await db
    .prepare(
      "INSERT INTO login_challenges(challenge_id,community_id,community_origin,subject,message,expires_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(id, context.communityId, origin, subject, message, time + 300_000)
    .run();
  return { id, message };
}

/** The stored V4 challenge, checked against this community before any verifier sees it. */
function signInChallenge(context: AuthContext, subject: string, text: string) {
  const typed = JSON.parse(text) as SignInTypedData;
  const message = signInFromMessage(typed.message);
  insist(
    typed.primaryType === "SignIn" &&
      message.learner.toLowerCase() === subject &&
      message.communityId === context.communityId &&
      message.origin === context.origin,
    "invalid_login",
  );
  return {
    typed,
    message,
    id: signInIdV4(
      typed.domain.chainId,
      typed.domain.verifyingContract,
      message,
    ),
  };
}

export async function loginVerify(
  db: D1Database,
  context: AuthContext,
  id: string,
  signature: string,
  verify: VerifyLogin,
  time = Date.now(),
) {
  insist(
    /^[a-f0-9]{64}$/.test(id) &&
      /^0x[0-9a-f]+$/i.test(signature) &&
      signature.length <= 32768,
    "invalid_login",
  );
  // Every column: a community without the V4 migration has no kind or
  // policy_version, and each of its challenges is SIWE.
  const row = await db
    .prepare(
      "SELECT * FROM login_challenges WHERE challenge_id=? AND community_id=? AND community_origin=?",
    )
    .bind(id, context.communityId, context.origin)
    .first<{
      subject: Address;
      message: string;
      expires_at: number;
      consumed: number;
      kind?: "siwe" | "sign-in-v4";
      policy_version?: number | null;
    }>();
  insist(
    row && !row.consumed && row.expires_at > time,
    "expired_or_replayed_challenge",
    401,
  );
  const c = { ...row, kind: row.kind ?? "siwe" };
  insist(c.kind === "siwe" || c.kind === "sign-in-v4", "invalid_login");
  // A SIWE challenge never carries an authorization; only typed V4 data does.
  const signIn =
    c.kind === "sign-in-v4"
      ? signInChallenge(context, c.subject, c.message)
      : undefined;
  insist(
    await verify(
      c.subject,
      signIn
        ? {
            domain: signIn.typed.domain,
            types: signInTypes,
            primaryType: "SignIn",
            message: signIn.message,
          }
        : c.message,
      signature as Hex,
    ),
    "invalid_login_signature",
    401,
  );
  time = Math.max(time, Date.now());
  const accountId = crypto.randomUUID(),
    bindingId = crypto.randomUUID();
  const sessionToken = token(),
    sessionHash = hashText(sessionToken),
    csrf = token();
  const open =
    "EXISTS(SELECT 1 FROM login_challenges WHERE challenge_id=? AND consumed=0 AND expires_at>?)";
  const statements = [
    db
      .prepare(
        `INSERT INTO community_accounts(account_id,author_id,created_at)
      SELECT ?,?,? WHERE ${open} AND NOT EXISTS(
        SELECT 1 FROM credential_bindings WHERE namespace='moss' AND network=6343 AND subject=?)`,
      )
      .bind(accountId, publicId(), time, id, time, c.subject),
    db
      .prepare(
        `INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at)
      SELECT ?,account_id,'moss',6343,?,? FROM community_accounts WHERE account_id=? AND ${open}
      ON CONFLICT(namespace,network,subject) DO NOTHING`,
      )
      .bind(bindingId, c.subject, time, accountId, id, time),
    db
      .prepare(
        `INSERT INTO community_sessions(session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at)
      SELECT ?,?,?,account_id,binding_id,?,? FROM credential_bindings
      WHERE namespace='moss' AND network=6343 AND subject=? AND ${open}`,
      )
      .bind(
        sessionHash,
        context.communityId,
        context.origin,
        csrf,
        time + 30 * 86400_000,
        c.subject,
        id,
        time,
      ),
  ];
  // The account's sign-ins that count: issued after its last withdrawal
  // (issued_at is seconds, withdrawal times milliseconds).
  const counted = (alias: string) =>
    `${alias}.issued_at*1000>COALESCE((SELECT s.last_withdrawn_at FROM learning_settings s WHERE s.account_id=b.account_id),-1)`;
  const issuedAt = signIn ? Number(signIn.message.issuedAt) : 0;
  if (signIn)
    // Pending sign-in, in the same batch as the session; it is relayed only
    // when the learner first practises. A withdrawn account stores nothing,
    // nor does one with a sign-in recorded on chain since its last
    // withdrawal, nor one whose pending relay was already requested. A
    // sign-in issued at or before the last withdrawal is never stored, and
    // an older challenge completed late never displaces a newer pending one.
    statements.push(
      db
        .prepare(
          `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,signature,policy_hash,policy_version,issued_at,state,tx_hash,created_at,updated_at)
      SELECT ?1,b.account_id,b.subject,?2,?3,?4,?5,?6,'pending',NULL,?7,?7 FROM credential_bindings b
      WHERE b.namespace='moss' AND b.network=6343 AND b.subject=?8
      AND EXISTS(SELECT 1 FROM login_challenges WHERE challenge_id=?9 AND consumed=0 AND expires_at>?7 AND kind='sign-in-v4')
      AND ?6*1000>COALESCE((SELECT s.last_withdrawn_at FROM learning_settings s WHERE s.account_id=b.account_id),-1)
      AND NOT EXISTS(SELECT 1 FROM learning_settings s WHERE s.account_id=b.account_id AND s.public_results_withdrawn_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM learning_authorizations r WHERE r.account_id=b.account_id AND r.state='recorded' AND ${counted("r")})
      AND NOT EXISTS(SELECT 1 FROM learning_authorizations r WHERE r.account_id=b.account_id AND r.state='pending'
        AND (r.relay_requested_at IS NOT NULL OR r.issued_at>?6) AND ${counted("r")})`,
        )
        .bind(
          signIn.id,
          JSON.stringify(signIn.typed.message),
          signature.toLowerCase(),
          signIn.message.publicationPolicy,
          c.policy_version ?? null,
          issuedAt,
          time,
          c.subject,
          id,
        ),
      // At most one pending sign-in per account: the new one replaces any
      // older one whose relay was never requested. It runs only when the new
      // row was stored, so a refused older sign-in removes nothing.
      db
        .prepare(
          `DELETE FROM learning_authorizations WHERE state='pending' AND relay_requested_at IS NULL
      AND authorization_id<>?1 AND issued_at<=?2
      AND account_id=(SELECT account_id FROM learning_authorizations WHERE authorization_id=?1 AND state='pending')`,
        )
        .bind(signIn.id, issuedAt),
    );
  statements.push(
    db
      .prepare(
        "UPDATE login_challenges SET consumed=1 WHERE challenge_id=? AND consumed=0 AND expires_at>?",
      )
      .bind(id, time),
  );
  const result = await db.batch(statements);
  insist(
    result[2]!.meta.changes === 1 && result.at(-1)!.meta.changes === 1,
    "expired_or_replayed_challenge",
    401,
  );
  return {
    cookie: cookie(sessionToken),
    csrf,
    ...(signIn && result[3]!.meta.changes === 1
      ? { authorizationId: signIn.id }
      : {}),
  };
}

export async function accountSession(
  request: Request,
  db: D1Database,
  context: AuthContext,
  time = Date.now(),
): Promise<AccountSession> {
  insist(new URL(request.url).origin === context.origin, "wrong_host", 403);
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("__Host-community_session="))
    ?.slice(25);
  insist(value && /^[a-f0-9]{64}$/.test(value), "session_required", 401);
  const s = await db
    .prepare(
      `SELECT s.session_hash,s.account_id,s.binding_id,s.csrf_token,s.expires_at,
      a.author_id,c.subject AS wallet FROM community_sessions s
      JOIN community_accounts a ON a.account_id=s.account_id
      JOIN credential_bindings c ON c.binding_id=s.binding_id AND c.account_id=s.account_id
      WHERE s.session_hash=? AND s.expires_at>? AND s.community_id=? AND s.community_origin=?`,
    )
    .bind(hashText(value), time, context.communityId, context.origin)
    .first<AccountSession>();
  insist(s, "session_required", 401);
  return s;
}
export async function authenticatedWrite(
  request: Request,
  db: D1Database,
  context: AuthContext,
) {
  requestOrigin(request, context.origin);
  const s = await accountSession(request, db, context);
  insist(
    equalTokens(request.headers.get("x-csrf-token") ?? "", s.csrf_token),
    "csrf_required",
    403,
  );
  return s;
}
