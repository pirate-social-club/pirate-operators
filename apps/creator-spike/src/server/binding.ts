import { insist } from "./store.ts";

export async function bindActiveCredential(
  db: D1Database,
  account: string,
  credentialId: string,
) {
  const bound = await db
    .prepare(
      "INSERT INTO bindings(account,credential_id) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET credential_id=excluded.credential_id WHERE bindings.credential_id=excluded.credential_id",
    )
    .bind(account, credentialId)
    .run();
  insist(bound.meta.changes === 1, "creator_binding_conflict", 409);
  const saved = await db
    .prepare("SELECT credential_id FROM bindings WHERE account=?")
    .bind(account)
    .first<{ credential_id: string }>();
  insist(
    saved?.credential_id === credentialId,
    "creator_binding_conflict",
    409,
  );
}

export async function recordSignatureSubmission(
  db: D1Database,
  id: string,
  digest: string,
  signId: string,
) {
  const saved = await db
    .prepare(
      "UPDATE signatures SET status=CASE WHEN result IS NULL THEN 'signing' ELSE 'verified' END,transaction_digest=?,sign_id=? WHERE id=? AND (transaction_digest IS NULL OR transaction_digest=?) AND (sign_id IS NULL OR sign_id=?)",
    )
    .bind(digest, signId, id, digest, signId)
    .run();
  insist(saved.meta.changes === 1, "signature_submission_conflict", 409);
}
