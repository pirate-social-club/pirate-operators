import { randomToken } from "../shared.ts";
import { insist } from "./store.ts";

const APPROVAL_WINDOW_MS = 300_000;
interface Preparation {
  submission_id: string;
  phase: string;
  token: string;
  expires: number;
  user_signature: string | null;
}

/** An unsigned preparation may expire; persisted signed submissions never lose their lock by time. */
export async function acquireOperatorLock(
  db: D1Database,
  holder: string,
  time = Date.now(),
) {
  await db.batch([
    db
      .prepare(
        `DELETE FROM operator_lock WHERE id=1 AND EXISTS(
      SELECT 1 FROM signature_preparations p WHERE p.submission_id=operator_lock.holder
      AND p.phase IN ('building','prepared','expired') AND p.expires<=?
      AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.id=p.submission_id))`,
      )
      .bind(time),
    db
      .prepare(
        `UPDATE signature_preparations SET phase='expired' WHERE expires<=?
      AND phase IN ('building','prepared') AND NOT EXISTS(
        SELECT 1 FROM submissions s WHERE s.id=signature_preparations.submission_id)`,
      )
      .bind(time),
    db
      .prepare(
        "INSERT INTO operator_lock(id,holder) VALUES(1,?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(holder),
  ]);
  const lock = await db
    .prepare("SELECT holder FROM operator_lock WHERE id=1")
    .first<{ holder: string }>();
  insist(lock?.holder === holder, "operator_busy_reconciling_transaction", 409);
}

export async function beginSignaturePreparation(
  db: D1Database,
  signatureId: string,
  submissionId: string,
  time = Date.now(),
) {
  await acquireOperatorLock(db, submissionId, time);
  const token = randomToken();
  const row = await db
    .prepare(
      `INSERT INTO signature_preparations(signature_id,submission_id,phase,token,expires)
    SELECT ?,?,'building',?,? WHERE NOT EXISTS(SELECT 1 FROM submissions WHERE id=?)
    ON CONFLICT(signature_id) DO UPDATE SET phase='building',token=excluded.token,expires=excluded.expires,user_signature=NULL
    WHERE signature_preparations.phase IN ('prepared','expired') AND NOT EXISTS(SELECT 1 FROM submissions WHERE id=excluded.submission_id)`,
    )
    .bind(
      signatureId,
      submissionId,
      token,
      time + APPROVAL_WINDOW_MS,
      submissionId,
    )
    .run();
  insist(row.meta.changes === 1, "signature_preparation_busy_retry", 409);
  return { token, expires: time + APPROVAL_WINDOW_MS };
}

export async function saveSignaturePreparation(
  db: D1Database,
  id: string,
  token: string,
  bytes: string,
  time = Date.now(),
) {
  const updated = await db.batch([
    db
      .prepare(
        `UPDATE signatures SET transaction_bytes=? WHERE id=? AND EXISTS(
      SELECT 1 FROM signature_preparations p JOIN operator_lock l ON l.id=1 AND l.holder=p.submission_id
      WHERE p.signature_id=signatures.id AND p.token=? AND p.phase='building' AND p.expires>?)
      AND NOT EXISTS(SELECT 1 FROM submissions s JOIN signature_preparations p ON s.id=p.submission_id WHERE p.signature_id=signatures.id)`,
      )
      .bind(bytes, id, token, time),
    db
      .prepare(
        `UPDATE signature_preparations SET phase='prepared' WHERE signature_id=? AND token=? AND phase='building' AND expires>?
      AND EXISTS(SELECT 1 FROM operator_lock l WHERE l.id=1 AND l.holder=signature_preparations.submission_id)
      AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.id=signature_preparations.submission_id)
      AND EXISTS(SELECT 1 FROM signatures s WHERE s.id=signature_preparations.signature_id AND s.transaction_bytes=?)`,
      )
      .bind(id, token, time, bytes),
  ]);
  insist(
    updated[0]!.meta.changes === 1 && updated[1]!.meta.changes === 1,
    "signature_preparation_expired_retry",
    409,
  );
}

export async function claimSignaturePreparation(
  db: D1Database,
  id: string,
  bytes: string,
  userSignature: string,
  time = Date.now(),
) {
  insist(
    userSignature.length > 0 && userSignature.length <= 4096,
    "invalid_signature",
  );
  const token = randomToken();
  const claimed = await db
    .prepare(
      `UPDATE signature_preparations SET phase='submitting',token=?,user_signature=?
    WHERE signature_id=? AND phase='prepared' AND expires>? AND EXISTS(
      SELECT 1 FROM signatures s WHERE s.id=signature_preparations.signature_id AND s.transaction_bytes=?)
    AND EXISTS(SELECT 1 FROM operator_lock l WHERE l.id=1 AND l.holder=signature_preparations.submission_id)`,
    )
    .bind(token, userSignature, id, time, bytes)
    .run();
  insist(
    claimed.meta.changes === 1,
    "signature_preparation_expired_or_busy_retry",
    409,
  );
  return token;
}

export async function capturedSignaturePreparation(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT * FROM signature_preparations WHERE signature_id=? AND phase='submitting' AND user_signature IS NOT NULL",
    )
    .bind(id)
    .first<Preparation>();
}

/** The prepare/reopen entrypoint must also resume approval saved before submit(). */
export async function resumeSignatureSubmission(
  db: D1Database,
  signatureId: string,
  submissionId: string,
  execute: () => Promise<unknown>,
) {
  const submitted = await db
    .prepare("SELECT id FROM submissions WHERE id=?")
    .bind(submissionId)
    .first();
  if (!submitted && !(await capturedSignaturePreparation(db, signatureId)))
    return false;
  await execute();
  return true;
}

export async function releaseUnsubmittedPreparation(
  db: D1Database,
  id: string,
  token: string,
) {
  const p = await db
    .prepare(
      "SELECT * FROM signature_preparations WHERE signature_id=? AND token=? AND phase IN ('building','prepared','expired')",
    )
    .bind(id, token)
    .first<Preparation>();
  if (!p) return;
  await db.batch([
    db
      .prepare(
        `DELETE FROM operator_lock WHERE id=1 AND holder=? AND NOT EXISTS(SELECT 1 FROM submissions WHERE id=?)
      AND EXISTS(SELECT 1 FROM signature_preparations WHERE signature_id=? AND token=?)`,
      )
      .bind(p.submission_id, p.submission_id, id, token),
    db
      .prepare(
        "UPDATE signature_preparations SET phase='expired' WHERE signature_id=? AND token=? AND NOT EXISTS(SELECT 1 FROM submissions WHERE id=?)",
      )
      .bind(id, token, p.submission_id),
  ]);
}
