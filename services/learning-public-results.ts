// V4 account settings: turning public results off and on. Both are explicit
// settings actions, never exercise prompts. Turning off relays the learner's
// signed Revocation and stops relaying their sign-ins. The operator applies
// that Revocation to the learner's V3 Study and Karaoke results not yet sent
// too: they stay private, and turning on never resumes them. Turning on
// clears the withdrawal; the learner's next normal sign-in is then relayed.
// A withdrawal made outside the application is noticed when the operator
// refuses new work; it then closes the account's open Study lessons in the
// community as turning off does. The operator stops that learner's V3
// results not yet sent by reading the withdrawal from the V4 contract.
import { isAddress, type Address } from "viem";
import type { SignInV4 } from "../packages/community/accounts.ts";
import { insist, object } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import {
  liveAccountAuthorization,
  publicResults,
  signInV4,
} from "./learning-sign-in.ts";
import { call } from "./service-call.ts";
import type { StudyEnv } from "./study-community.ts";

interface Learner {
  account_id: string;
  wallet: string;
}

/** Records a withdrawal; the latest withdrawal time is kept after turning on. */
async function recordWithdrawal(
  db: D1Database,
  accountId: string,
  atMs: number,
) {
  await db
    .prepare(
      `INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES(?1,?2,?2)
      ON CONFLICT(account_id) DO UPDATE SET
        public_results_withdrawn_at=COALESCE(public_results_withdrawn_at,excluded.public_results_withdrawn_at),
        last_withdrawn_at=MAX(COALESCE(last_withdrawn_at,0),excluded.last_withdrawn_at)`,
    )
    .bind(accountId, atMs)
    .run();
}

/**
 * A normal login never restores permission withdrawn directly on chain.
 * An unavailable or malformed observation allows only the plain login. The
 * recorded withdrawal survives later logins; only the settings turn-on clears
 * it. A previously observed withdrawal does not undo an explicit turn-on.
 */
export async function publicationSignInAtLogin(
  env: { KARAOKE_OPERATOR?: Fetcher },
  db: D1Database,
  address: unknown,
  v4: SignInV4 | undefined,
  endLessons: (learner: Learner) => Promise<unknown> = async () => undefined,
  waitMs = 2000,
): Promise<SignInV4 | undefined> {
  if (!v4) return undefined;
  insist(typeof address === "string" && isAddress(address), "invalid_wallet");
  const wallet = address.toLowerCase();
  const account = await db
    .prepare(
      `SELECT b.account_id,s.public_results_withdrawn_at AS withdrawn,s.acknowledged_revocation_nonce AS acknowledged
      FROM credential_bindings b LEFT JOIN learning_settings s ON s.account_id=b.account_id
      WHERE b.namespace='moss' AND b.network=6343 AND b.subject=?`,
    )
    .bind(wallet)
    .first<{
      account_id: string;
      withdrawn: number | null;
      acknowledged: string | null;
    }>();
  if (account?.withdrawn != null || !env.KARAOKE_OPERATOR) return undefined;
  const observed = await loginWithdrawal(env, wallet, waitMs);
  if (observed === undefined || observed.pending) return undefined;
  if (
    observed.nonce === "0" ||
    (account?.acknowledged != null &&
      BigInt(account.acknowledged) >= BigInt(observed.nonce))
  ) {
    if (!account) return v4;
    const current = await db
      .prepare(
        "SELECT public_results_withdrawn_at AS withdrawn FROM learning_settings WHERE account_id=?",
      )
      .bind(account.account_id)
      .first<{ withdrawn: number | null }>();
    return current?.withdrawn == null ? v4 : undefined;
  }
  if (account) {
    const noted = await db
      .prepare(
        `INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at) VALUES(?1,?2,?2)
      ON CONFLICT(account_id) DO UPDATE SET public_results_withdrawn_at=excluded.public_results_withdrawn_at,
        last_withdrawn_at=MAX(COALESCE(last_withdrawn_at,0),excluded.last_withdrawn_at)
      WHERE acknowledged_revocation_nonce IS NULL
        OR length(acknowledged_revocation_nonce)<length(?3)
        OR (length(acknowledged_revocation_nonce)=length(?3) AND acknowledged_revocation_nonce<?3)`,
      )
      .bind(account.account_id, observed.atMs, observed.nonce)
      .run();
    if (!noted.meta.changes) {
      // Turn-on may have acknowledged this withdrawal while the read was
      // pending. Never overwrite that newer choice or close its lessons.
      const current = await db
        .prepare(
          "SELECT public_results_withdrawn_at AS withdrawn,acknowledged_revocation_nonce AS acknowledged FROM learning_settings WHERE account_id=?",
        )
        .bind(account.account_id)
        .first<{ withdrawn: number | null; acknowledged: string | null }>();
      return current?.withdrawn === null &&
        current.acknowledged != null &&
        BigInt(current.acknowledged) >= BigInt(observed.nonce)
        ? v4
        : undefined;
    }
    await endLessons({ account_id: account.account_id, wallet });
  }
  return undefined;
}

/** Milliseconds of the latest chain withdrawal, or no usable observation. */
async function loginWithdrawal(
  env: { KARAOKE_OPERATOR?: Fetcher },
  wallet: string,
  waitMs = 2000,
): Promise<{ atMs: number; nonce: string; pending: boolean } | undefined> {
  const live = await liveAccountAuthorization(env, wallet, waitMs);
  return live
    ? {
        atMs: live.revokedAt * 1000,
        nonce: live.revocationNonce,
        pending: live.pendingWithdrawal,
      }
    : undefined;
}

function operatorFor(env: StudyEnv, config: CommunityConfig) {
  insist(
    env.KARAOKE_SERVICE_MODE === "internal" &&
      env.KARAOKE_OPERATOR &&
      signInV4(env, config),
    "public_results_unavailable",
    409,
  );
  return env.KARAOKE_OPERATOR!;
}

/**
 * "Turn off public results". Without a signature this returns the typed
 * Revocation to sign; with one it relays it and records the withdrawal once
 * the operator holds the signed transaction.
 */
export async function turnOffPublicResults(
  env: StudyEnv,
  db: D1Database,
  config: CommunityConfig,
  learner: Learner,
  value: Record<string, unknown>,
  now: number,
  /** Closes the account's open Study lessons once the withdrawal holds. */
  endLessons: () => Promise<unknown> = async () => undefined,
) {
  const operator = operatorFor(env, config);
  if (value.signature === undefined)
    return call(operator, "/authorization/revoke", { learner: learner.wallet });
  const message = object(value.message);
  insist(
    String(message.learner).toLowerCase() === learner.wallet.toLowerCase(),
    "wrong_learner",
    409,
  );
  const relayed = await call<{ state: string }>(
    operator,
    "/authorization/revoke",
    {
      learner: learner.wallet,
      nonce: String(message.nonce),
      signature: value.signature,
    },
  );
  // A pending transaction is the operator's to finish; the withdrawal holds now.
  if (relayed.state === "success" || relayed.state === "pending") {
    await recordWithdrawal(db, learner.account_id, now);
    // As the policy says: an open Study lesson closes at once. A retry of
    // this request repeats it; the closure is idempotent.
    await endLessons();
  }
  return {
    state: relayed.state,
    publicResults: await publicResults(db, learner.account_id, true),
  };
}

/** "Turn on public results": the learner's next normal sign-in is relayed. */
export async function turnOnPublicResults(
  env: StudyEnv,
  db: D1Database,
  config: CommunityConfig,
  learner: Learner,
) {
  operatorFor(env, config);
  // A relayed withdrawal may mine after the application's recorded time.
  // Explicit turn-on acknowledges its exact chain nonce before clearing the flag,
  // so the next login does not mistake that same withdrawal for a new one.
  const observed = await loginWithdrawal(env, learner.wallet);
  insist(
    observed !== undefined && !observed.pending,
    "public_results_unavailable",
    503,
  );
  await db
    .prepare(
      `INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at,acknowledged_revocation_nonce) VALUES(?1,NULL,?2,?3)
      ON CONFLICT(account_id) DO UPDATE SET public_results_withdrawn_at=NULL,
        last_withdrawn_at=MAX(COALESCE(last_withdrawn_at,0),excluded.last_withdrawn_at),
        acknowledged_revocation_nonce=CASE WHEN acknowledged_revocation_nonce IS NULL
          OR length(acknowledged_revocation_nonce)<length(excluded.acknowledged_revocation_nonce)
          OR (length(acknowledged_revocation_nonce)=length(excluded.acknowledged_revocation_nonce)
            AND acknowledged_revocation_nonce<excluded.acknowledged_revocation_nonce)
        THEN excluded.acknowledged_revocation_nonce ELSE acknowledged_revocation_nonce END`,
    )
    .bind(learner.account_id, observed.atMs, observed.nonce)
    .run();
  return { publicResults: await publicResults(db, learner.account_id, true) };
}

/**
 * After the operator refuses new work because permission is not in force,
 * a withdrawal made outside the application (directly on chain) is recorded,
 * so the session shows "off" and settings offers turning it back on. It is
 * recorded only when the chain shows a revocation and no sign-in the account
 * still counts was issued after it. While that holds, `endLessons` closes the
 * account's open Study lessons in this community, V3 and V4, as turning off
 * does; it is idempotent, so a repeated notice repeats it harmlessly.
 * Nothing is relayed here.
 */
export async function noteChainWithdrawal(
  env: { KARAOKE_OPERATOR?: Fetcher },
  db: D1Database,
  learner: Learner,
  endLessons: () => Promise<unknown> = async () => undefined,
) {
  if (!env.KARAOKE_OPERATOR) return false;
  const response = await env.KARAOKE_OPERATOR.fetch(
    `http://service/authorization/${learner.wallet as Address}`,
  );
  if (!response.ok) return false;
  const live = (await response.json()) as {
    since?: unknown;
    revokedAt?: unknown;
  };
  const revokedAt = Number(live.revokedAt);
  if (live.since !== 0 || !Number.isSafeInteger(revokedAt) || revokedAt <= 0)
    return false;
  const later = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM learning_authorizations WHERE account_id=?1
        AND state IN ('pending','recorded') AND issued_at>?2) AS later,
        (SELECT public_results_withdrawn_at FROM learning_settings WHERE account_id=?1) AS withdrawn`,
    )
    .bind(learner.account_id, revokedAt)
    .first<{ later: number; withdrawn: number | null }>();
  if (!later || later.later) return false;
  const recorded = later.withdrawn === null;
  if (recorded)
    await recordWithdrawal(db, learner.account_id, revokedAt * 1000);
  await endLessons();
  return recorded;
}

/** Runs `work`; on a known refusal for missing permission, notes a chain withdrawal first. */
export async function noticingWithdrawal<T>(
  env: { KARAOKE_OPERATOR?: Fetcher },
  db: D1Database,
  learner: Learner,
  refusal: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.message === refusal)
      await noteChainWithdrawal(env, db, learner).catch(() => false);
    throw error;
  }
}
