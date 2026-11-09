// V4 account settings: turning public results off and on. Both are explicit
// settings actions, never exercise prompts. Turning off relays the learner's
// signed Revocation and stops relaying their sign-ins. Turning on clears the
// withdrawal; the learner's next normal sign-in is then relayed. A withdrawal
// made outside the application is noticed when the operator refuses new work.
import type { Address } from "viem";
import { insist, object } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { publicResults, signInV4 } from "./learning-sign-in.ts";
import { call } from "./service-call.ts";
import type { StudyEnv } from "./study-community.ts";

interface Learner {
  account_id: string;
  wallet: string;
}

/** Records a withdrawal; the latest withdrawal time is kept after turning on. */
async function recordWithdrawal(db: D1Database, accountId: string, atMs: number) {
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
  if (relayed.state === "success" || relayed.state === "pending")
    await recordWithdrawal(db, learner.account_id, now);
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
  await db
    .prepare(
      "UPDATE learning_settings SET public_results_withdrawn_at=NULL WHERE account_id=?",
    )
    .bind(learner.account_id)
    .run();
  return { publicResults: await publicResults(db, learner.account_id, true) };
}

/**
 * After the operator refuses new work because permission is not in force,
 * a withdrawal made outside the application (directly on chain) is recorded,
 * so the session shows "off" and settings offers turning it back on. It is
 * recorded only when the chain shows a revocation and no sign-in the account
 * still counts was issued after it. Nothing is relayed here.
 */
export async function noteChainWithdrawal(
  env: { KARAOKE_OPERATOR?: Fetcher },
  db: D1Database,
  learner: Learner,
) {
  if (!env.KARAOKE_OPERATOR) return false;
  const response = await env.KARAOKE_OPERATOR.fetch(
    `http://service/authorization/${learner.wallet as Address}`,
  );
  if (!response.ok) return false;
  const live = (await response.json()) as { since?: unknown; revokedAt?: unknown };
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
  if (!later || later.later || later.withdrawn !== null) return false;
  await recordWithdrawal(db, learner.account_id, revokedAt * 1000);
  return true;
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
