// Version 4: the learner's community sign-in, a standard EIP-4361 (SIWE)
// message, is the standing publication permission. The contract rebuilds the
// exact text on chain. Result, outcome and event shapes are V3's.
import { getAddress, hashMessage, parseAbi, type Address, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { resultStruct, songStruct } from "./learning-results.ts";

/**
 * The sign-in Statement: draft wording for the workspace_owner's approval.
 * LearningResultsV4.SIGN_IN_STATEMENT is the same text, and a test asserts
 * the two are equal.
 */
export const SIGN_IN_STATEMENT_V4 =
  "Sign in to this community and let it publish your Karaoke and Study results under its terms, version 4, until you turn them off in settings. This does not join, create a creator wallet or authorize spending.";
/**
 * Not Before equals Issued At, so a wallet whose clock is behind the server
 * refuses to sign. The challenge's issuedAt is therefore backdated by at most
 * this, and never to or before the account's last withdrawal.
 */
export const SIGN_IN_BACKDATE_S = 60;

/** What fixes the sign-in text besides the learner, nonce and time. */
export interface SignInV4Context {
  origin: string;
  chainId: number;
  contract: Address;
  communityId: Hex;
  publicationPolicy: Hex;
}
/** The compact arguments of LearningResultsV4.authorize. */
export interface SignIn {
  learner: Address;
  nonce: Hex;
  issuedAt: bigint;
}
export const resultsV4Domain = (chainId: number, verifyingContract: Address) => ({
  name: "Pirate Learning Results",
  version: "4",
  chainId,
  verifyingContract,
});

/**
 * The origin rule of the contract's constructor: `https://`, a lowercase host
 * of `[a-z0-9.-]` labels with no empty label and none starting or ending with
 * `-`, containing a dot or equal to `localhost`, and an optional port with no
 * leading zero, at most 65535 and not 443. No path, query or trailing slash.
 */
function constructorOriginRule(origin: string): boolean {
  const m = /^https:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(origin);
  if (!m) return false;
  const host = m[1]!,
    port = m[2];
  if (
    host.split(".").some((l) => l === "" || l.startsWith("-") || l.endsWith("-")) ||
    (!host.includes(".") && host !== "localhost")
  )
    return false;
  return port === undefined || (Number(port) <= 65535 && port !== "443");
}

/**
 * Whether a V4 community may be released with this origin: the constructor's
 * rule above, and signInMessageV4 must build a text for it. The constructor
 * also accepts some origins the builder refuses (a one-letter or numeric top
 * label, a label over 63 characters, an IPv4 form that URL rewrites, invalid
 * punycode). communityOrigin is immutable, so a contract deployed with one of
 * those could never sign anyone in; this check refuses them before release.
 */
export function canonicalOriginV4(origin: string): boolean {
  if (!constructorOriginRule(origin)) return false;
  const one = (bytes: number) => `0x${"00".repeat(bytes - 1)}01` as Hex;
  try {
    signInMessageV4(
      {
        origin,
        chainId: 6343,
        contract: one(20) as Address,
        communityId: one(32),
        publicationPolicy: one(32),
      },
      { learner: one(20) as Address, nonce: one(32), issuedAt: 1n },
    );
    return true;
  } catch {
    return false;
  }
}

const hex64 = /^0x[0-9a-f]{64}$/;
const iso = (seconds: bigint) => {
  if (seconds < 0n || seconds >= 253402300800n) throw new Error("invalid_sign_in");
  return new Date(Number(seconds) * 1000);
};
const resourcesOf = (ctx: SignInV4Context) => [
  `${ctx.origin}/learning/v4/terms`,
  `${ctx.origin}/learning/v4/privacy`,
  `urn:pirate:publication-policy:4:${ctx.publicationPolicy}`,
  `urn:pirate:community:${ctx.communityId}`,
  `eip155:${ctx.chainId}:${ctx.contract}`,
];

/**
 * The exact text the learner signs and the contract's signInMessage renders:
 * viem createSiweMessage with a fixed field set. Hex is lowercase except the
 * EIP-55 learner; Issued At and Not Before are both issuedAt; there is no
 * Expiration Time or Request ID.
 */
export function signInMessageV4(ctx: SignInV4Context, s: SignIn): string {
  if (
    !constructorOriginRule(ctx.origin) ||
    new URL(ctx.origin).origin !== ctx.origin ||
    !Number.isSafeInteger(ctx.chainId) ||
    ctx.chainId <= 0 ||
    !/^0x[0-9a-f]{40}$/.test(ctx.contract) ||
    !hex64.test(ctx.communityId) ||
    !hex64.test(ctx.publicationPolicy) ||
    !hex64.test(s.nonce) ||
    BigInt(s.nonce) === 0n ||
    typeof s.issuedAt !== "bigint"
  )
    throw new Error("invalid_sign_in");
  const time = iso(s.issuedAt);
  return createSiweMessage({
    domain: new URL(ctx.origin).host,
    address: getAddress(s.learner),
    statement: SIGN_IN_STATEMENT_V4,
    uri: ctx.origin,
    version: "1",
    chainId: ctx.chainId,
    nonce: s.nonce.slice(2),
    issuedAt: time,
    notBefore: time,
    resources: resourcesOf(ctx),
  });
}
/** The EIP-191 hash of the text: the contract's signInDigest and the authorization id. */
export const signInIdV4 = (ctx: SignInV4Context, s: SignIn) =>
  hashMessage(signInMessageV4(ctx, s));

/**
 * Recovers the context and sign-in from a text, only when signInMessageV4
 * rebuilds it byte for byte; anything else is undefined.
 */
export function readSignInMessageV4(
  text: string,
): { context: SignInV4Context; signIn: SignIn } | undefined {
  try {
    const m = parseSiweMessage(text);
    const r = m.resources ?? [];
    const policy = /^urn:pirate:publication-policy:4:(0x[0-9a-f]{64})$/.exec(r[2] ?? ""),
      community = /^urn:pirate:community:(0x[0-9a-f]{64})$/.exec(r[3] ?? ""),
      contract = /^eip155:([1-9][0-9]*):(0x[0-9a-f]{40})$/.exec(r[4] ?? "");
    if (!m.address || !m.uri || !m.nonce || !m.issuedAt || !policy || !community || !contract)
      return undefined;
    const context: SignInV4Context = {
      origin: m.uri,
      chainId: Number(contract[1]),
      contract: contract[2] as Address,
      communityId: community[1] as Hex,
      publicationPolicy: policy[1] as Hex,
    };
    const ms = m.issuedAt.getTime();
    if (!Number.isSafeInteger(ms) || ms % 1000 !== 0) return undefined;
    const signIn: SignIn = {
      learner: getAddress(m.address),
      nonce: `0x${m.nonce}` as Hex,
      issuedAt: BigInt(ms / 1000),
    };
    return signInMessageV4(context, signIn) === text ? { context, signIn } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The challenge's issuedAt in seconds: up to SIGN_IN_BACKDATE_S before now,
 * never after now, and never backdated into the SIGN_IN_BACKDATE_S after the
 * last withdrawal the application recorded (milliseconds). That margin covers
 * a revoke mined, or a chain clock running, later than the application's
 * own record of the withdrawal: a sign-in made just after turning public
 * results back on is issued at the current second, as before the backdate.
 */
export const signInIssuedAtV4 = (nowMs: number, lastWithdrawnAtMs?: number | null) => {
  const now = Math.floor(nowMs / 1000);
  const floor =
    lastWithdrawnAtMs == null
      ? -Infinity
      : Math.floor(lastWithdrawnAtMs / 1000) + 1 + SIGN_IN_BACKDATE_S;
  return Math.min(now, Math.max(now - SIGN_IN_BACKDATE_S, floor));
};

export const signInStruct =
  "struct SignIn { address learner; bytes32 nonce; uint64 issuedAt; }";
export const resultsV4Abi = parseAbi([
  signInStruct,
  songStruct,
  resultStruct,
  "function VERSION() view returns (uint8)",
  "function RELAY_WINDOW() view returns (uint64)",
  "function activatePolicy(uint8 activity,bytes32 policy,string uri,uint64 period)",
  "function policyFor(uint8 activity,uint64 period) view returns (bytes32)",
  "function setGrader(address grader,uint8 activity,bool allowed)",
  "function authorize(SignIn a,bytes signature)",
  "function signInDigest(SignIn a) view returns (bytes32)",
  "function signInMessage(SignIn a) view returns (string)",
  "function communityOrigin() view returns (string)",
  "function SIGN_IN_STATEMENT() view returns (string)",
  "function revoke(address learner,uint64 nonce,bytes signature)",
  "function revocationDigest(address learner,uint64 nonce) view returns (bytes32)",
  "function publish(Result r,bytes outcomes)",
  "function correct(Result previous,bytes oldOutcomes,bytes outcomes,uint8 status)",
  "function invalidate(Result previous,bytes outcomes,bytes32 reason)",
  "function commitmentOf(Result r,bytes outcomes) pure returns (bytes32)",
  "function nextNonce(address learner) view returns (uint64)",
  "function authorizedSince(address learner) view returns (uint64)",
  "function revokedAt(address learner) view returns (uint64)",
  "function authorizationLearner(bytes32 id) view returns (address)",
  "function authorizationIssuedAt(bytes32 id) view returns (uint64)",
  "function publicityPolicy() view returns (bytes32)",
  "function communityId() view returns (bytes32)",
  "function commitments(bytes32 sessionId) view returns (bytes32)",
  "event Authorized(address indexed learner,bytes32 indexed authorizationId,string origin,uint64 issuedAt,uint64 authorizedSince)",
  "event Revoked(address indexed learner,uint64 nonce,uint64 revokedAt)",
  "event ResultPublished(bytes32 indexed sessionId,address indexed learner,uint32 indexed revision,Result result,bytes outcomes,bytes32 commitment,address publisher)",
  "event ResultInvalidated(bytes32 indexed sessionId,uint32 indexed revision,bytes32 reason)",
  "event PolicyActivated(uint8 indexed activity,bytes32 indexed policyHash,string policyURI,uint64 effectivePeriod,uint8 clockVersion)",
  "event EligibilityChanged(address indexed learner,bool eligible,uint64 effectiveAt,bytes32 reasonCode)",
]);
