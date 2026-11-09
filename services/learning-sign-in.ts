// The application's half of V4: a community sign-in is the learner's
// publication authorization. The sign-in is stored at login (accounts.ts);
// here it is relayed to the operator, which records it on chain, and the
// row is closed as recorded or refused. Relay is lazy: only the learner's
// first Study or Karaoke start without a recorded authorization requests it,
// so signing in without practising sends no sponsored transaction. The thirty-day relay window, the
// contract's RELAY_WINDOW and the community session, is a hard limit: after
// it the learner simply signs in again.
import type { Address, Hex } from "viem";
import type { SignInV4 } from "../packages/community/accounts.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { learningV4Disclosure } from "./learning-policy-v4.ts";
import { call } from "./service-call.ts";
import type { StudyEnv } from "./study-community.ts";

export const SIGN_IN_RELAY_WINDOW_S = 30 * 86400;
export type PublicResults = "on" | "pending" | "off" | "unavailable";

/** V4 sign-in only when the application's V4 contract is the directory's learning records. */
export function signInV4(
  env: StudyEnv,
  config: CommunityConfig,
): SignInV4 | undefined {
  const contract = env.STUDY_RESULTS_V4_CONTRACT,
    chainId = Number(env.KARAOKE_PAYMENT_CHAIN_ID || 6343);
  if (
    !contract ||
    !/^0x[0-9a-fA-F]{40}$/.test(contract) ||
    /^0x0+$/.test(contract) ||
    contract.toLowerCase() !== config.learningRecords.toLowerCase() ||
    (chainId !== 6343 && chainId !== 31337)
  )
    return undefined;
  return {
    chainId,
    contract: contract.toLowerCase() as Address,
    communityId: config.communityId,
    publicationPolicy: learningV4Disclosure.publicityPolicy,
    policyVersion: learningV4Disclosure.version,
  };
}

/** The application's V4 contract is the directory's learning records. */
export const v4LearningRecords = (
  env: Pick<StudyEnv, "STUDY_RESULTS_V4_CONTRACT">,
  config: CommunityConfig,
) =>
  !!env.STUDY_RESULTS_V4_CONTRACT &&
  env.STUDY_RESULTS_V4_CONTRACT.toLowerCase() ===
    config.learningRecords.toLowerCase();

/**
 * Sign-ins count only when issued after the account's last withdrawal.
 * `issued_at` is seconds; withdrawal times are milliseconds.
 */
const sinceWithdrawal = (alias: string) =>
  `${alias}.issued_at*1000>COALESCE((SELECT last_withdrawn_at FROM learning_settings WHERE account_id=?1),-1)`;

export async function publicResults(
  db: D1Database,
  accountId: string,
  available: boolean,
): Promise<PublicResults> {
  if (!available) return "unavailable";
  const row = await db
    .prepare(
      `SELECT
        (SELECT public_results_withdrawn_at FROM learning_settings WHERE account_id=?1) AS withdrawn,
        EXISTS(SELECT 1 FROM learning_authorizations a WHERE a.account_id=?1 AND a.state='recorded' AND ${sinceWithdrawal("a")}) AS recorded,
        EXISTS(SELECT 1 FROM learning_authorizations a WHERE a.account_id=?1 AND a.state='pending' AND ${sinceWithdrawal("a")}) AS pending`,
    )
    .bind(accountId)
    .first<{ withdrawn: number | null; recorded: number; pending: number }>();
  if (!row || row.withdrawn !== null) return "off";
  return row.recorded ? "on" : row.pending ? "pending" : "off";
}

/**
 * The account's most recent recorded sign-in authorization issued at or before
 * `atS` and after its last withdrawal, the choice a new V4 Study lesson or
 * Karaoke run makes. Without one, `pending` says whether such a sign-in is
 * still being recorded, which is worth a short retry.
 */
export async function recordedAuthorization(
  db: D1Database,
  accountId: string,
  subject: string,
  atS: number,
): Promise<{ id: Hex } | { id: null; pending: boolean }> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT a.authorization_id FROM learning_authorizations a
          WHERE a.account_id=?1 AND a.subject=?2 AND a.state='recorded' AND a.issued_at<=?3 AND ${sinceWithdrawal("a")}
          ORDER BY a.issued_at DESC,a.authorization_id DESC LIMIT 1) AS recorded,
        EXISTS(SELECT 1 FROM learning_authorizations a WHERE a.account_id=?1 AND a.state='pending' AND ${sinceWithdrawal("a")}) AS pending`,
    )
    .bind(accountId, subject.toLowerCase(), atS)
    .first<{ recorded: string | null; pending: number }>();
  if (row?.recorded) return { id: row.recorded as Hex };
  return { id: null, pending: !!row?.pending };
}

interface PendingRow {
  authorization_id: Hex;
  sign_in_json: string;
  signature: Hex;
  issued_at: number;
  withdrawn: number | null;
  last_withdrawn: number | null;
}
interface OperatorReceipt {
  id: Hex;
  state: "pending" | "success" | "reverted";
  txHash: Hex | null;
}
/**
 * The contract's and operator's final answers; anything else is retried.
 * `sign_in_not_yet_valid` (this application's clock ahead of the latest
 * block) is deliberately absent: such a sign-in stays pending and is retried.
 */
const refusals = new Set([
  "stale_sign_in",
  "revoked_sign_in",
  "invalid_sign_in",
  "invalid_consent",
  "wrong_community",
  "consent_refused_by_account",
  "account_activation_not_approved",
  "authorization_not_learners",
]);
const pendingRows = `SELECT a.authorization_id,a.sign_in_json,a.signature,a.issued_at,
  s.public_results_withdrawn_at AS withdrawn,s.last_withdrawn_at AS last_withdrawn
  FROM learning_authorizations a LEFT JOIN learning_settings s ON s.account_id=a.account_id
  WHERE a.state='pending'`;

async function close(
  db: D1Database,
  id: Hex,
  state: "recorded" | "refused",
  txHash: Hex | null,
  now: number,
) {
  await db
    .prepare(
      "UPDATE learning_authorizations SET state=?,tx_hash=?,updated_at=? WHERE authorization_id=? AND state='pending'",
    )
    .bind(state, txHash, now, id)
    .run();
}

async function relay(env: StudyEnv, db: D1Database, row: PendingRow, now: number) {
  // A withdrawal stops relaying, and a sign-in made at or before the last
  // withdrawal is never relayed, even after public results are turned on.
  if (
    row.withdrawn !== null ||
    (row.last_withdrawn !== null && row.issued_at * 1000 <= row.last_withdrawn)
  )
    return close(db, row.authorization_id, "refused", null, now);
  const expired = now > (row.issued_at + SIGN_IN_RELAY_WINDOW_S) * 1000;
  let receipt: OperatorReceipt;
  try {
    if (!env.KARAOKE_OPERATOR) throw new Error("operator_unavailable");
    receipt = await call<OperatorReceipt>(env.KARAOKE_OPERATOR, "/authorization", {
      signIn: JSON.parse(row.sign_in_json),
      signature: row.signature,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (refusals.has(code) || expired)
      await close(db, row.authorization_id, "refused", null, now);
    return;
  }
  if (receipt.id !== row.authorization_id) {
    // A different contract or domain recorded another digest: never this sign-in.
    if (expired) await close(db, row.authorization_id, "refused", null, now);
    return;
  }
  if (receipt.state === "success")
    return close(db, row.authorization_id, "recorded", receipt.txHash, now);
  if (receipt.state === "reverted" || expired)
    return close(db, row.authorization_id, "refused", receipt.txHash, now);
}

/** Relays one pending sign-in; failures are left for the scheduled retry. */
export async function relaySignIn(
  env: StudyEnv,
  db: D1Database,
  authorizationId: Hex,
  now = Date.now(),
) {
  const row = await db
    .prepare(`${pendingRows} AND a.authorization_id=?`)
    .bind(authorizationId)
    .first<PendingRow>();
  if (row) await relay(env, db, row, now);
}

/**
 * Scheduled and bounded: the oldest requested relays first. A sign-in whose
 * relay no Study or Karaoke start requested is never relayed here.
 */
export async function relayPendingSignIns(
  env: StudyEnv,
  db: D1Database,
  now = Date.now(),
  limit = 10,
) {
  const rows = await db
    .prepare(
      `${pendingRows} AND a.relay_requested_at IS NOT NULL ORDER BY a.relay_requested_at,a.created_at LIMIT ?`,
    )
    .bind(limit)
    .all<PendingRow>();
  for (const row of rows.results) await relay(env, db, row, now);
  return rows.results.length;
}

/**
 * The learner is starting Study or Karaoke work with no recorded
 * authorization: the account's pending sign-in (at most one) is marked as
 * requested, which also keeps a later sign-in from replacing it, and relayed
 * now. A slow operator is bounded; the start answers pending and the client's
 * bounded retry, or the scheduled job, finishes it.
 */
export async function requestSignInRelay(
  env: Pick<StudyEnv, "KARAOKE_OPERATOR">,
  db: D1Database,
  accountId: string,
  now: number,
  waitMs = 10_000,
) {
  await db
    .prepare(
      `UPDATE learning_authorizations AS a SET relay_requested_at=?2,updated_at=?2
      WHERE a.account_id=?1 AND a.state='pending' AND a.relay_requested_at IS NULL AND ${sinceWithdrawal("a")}`,
    )
    .bind(accountId, now)
    .run();
  const rows = await db
    .prepare(
      `${pendingRows} AND a.account_id=? AND a.relay_requested_at IS NOT NULL ORDER BY a.issued_at LIMIT 2`,
    )
    .bind(accountId)
    .all<PendingRow>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (async () => {
      for (const row of rows.results)
        await relay(env as StudyEnv, db, row, now).catch(() => undefined);
    })(),
    new Promise((resolve) => (timer = setTimeout(resolve, waitMs))),
  ]);
  clearTimeout(timer);
}

/**
 * The authorization a new V4 Study lesson or Karaoke run binds: the recorded
 * one, or, on the learner's first start without one, the pending sign-in
 * relayed inline. `pending` remains a retryable refusal.
 */
export async function practiceAuthorization(
  env: Pick<StudyEnv, "KARAOKE_OPERATOR">,
  db: D1Database,
  accountId: string,
  subject: string,
  atS: number,
  now: number,
) {
  const chosen = await recordedAuthorization(db, accountId, subject, atS);
  if (chosen.id || !chosen.pending) return chosen;
  await requestSignInRelay(env, db, accountId, now);
  return recordedAuthorization(db, accountId, subject, atS);
}
