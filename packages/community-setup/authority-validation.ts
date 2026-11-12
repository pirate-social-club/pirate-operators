import type { Hex } from "viem";
import { digest } from "../protocol/index.ts";
import type { BotScope } from "../telegram/contracts.ts";
import type { TelegramStudyDenial } from "../study/telegram-publication.ts";
import {
  authorityReady,
  CommunityAuthorityPending,
  assertAuthorityOriginalsUnchanged,
  type AuthorityAction,
  type AuthorityOperation,
} from "./authority-ledger.ts";
import {
  validateAuthorityOriginal,
  validateAuthorityOriginalAccount,
  type RetainedAuthorityOriginal,
} from "./authority-originals.ts";

/** Policy2 requires the wallet lookup to be witnessed by a prior revision
 * capture. Policy1 completions/cursors cannot establish that provenance. */
export const AUTHORITY_VALIDATION_POLICY = 2;
const policy = AUTHORITY_VALIDATION_POLICY;
interface Validation {
  operation_id: string;
  policy: number;
  original_revision: number;
  credential_revision: number;
  member_revision: number;
  generation: number;
  cursor: string;
  complete: number;
}
// Credential authority is independent of timestamps and original-row revision.
const current = `EXISTS(SELECT 1 FROM learning_authority_operations o
 JOIN learning_authority_heads h ON h.account_id=o.account_id
 WHERE o.operation_id=v.operation_id AND o.complete=0 AND h.pending_operation=o.operation_id AND h.revision=o.epoch
 AND o.original_revision=v.original_revision AND o.member_revision=v.member_revision
 AND v.credential_revision=COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=o.account_id),0))`;
async function requireValidationAtRevision(
  db: D1Database,
  op: AuthorityOperation,
  credentialRevision?: number,
) {
  await assertAuthorityOriginalsUnchanged(db, op);
  authorityReady(
    await db
      .prepare(
        `SELECT 1 FROM learning_authority_validation v WHERE v.operation_id=? AND v.policy=? AND v.complete=1 AND (?3 IS NULL OR v.credential_revision=?3) AND ${current}`,
      )
      .bind(op.operation_id, policy, credentialRevision ?? null)
      .first(),
  );
}
/** The public readiness check accepts only the repaired policy's completed
 * provenance. Delivery additionally pins the revision captured by that call. */
export async function requireAuthorityValidation(
  db: D1Database,
  op: AuthorityOperation,
) {
  await requireValidationAtRevision(db, op);
}
async function captureCredentialRevision(db: D1Database, accountId: string) {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=?),0) AS captured_revision`,
    )
    .bind(accountId)
    .first<{ captured_revision: number }>();
  authorityReady(
    row &&
      Number.isSafeInteger(row.captured_revision) &&
      row.captured_revision >= 0,
  );
  return row.captured_revision;
}
async function originalContext(db: D1Database) {
  const identity = await db
    .prepare(
      "SELECT community_id,community_origin FROM application_identity WHERE id=1",
    )
    .first<{ community_id: string; community_origin: string }>();
  authorityReady(identity);
  return identity;
}
async function validateMember(
  db: D1Database,
  row: RetainedAuthorityOriginal,
  op: AuthorityOperation,
  action: AuthorityAction,
  identity: Awaited<ReturnType<typeof originalContext>>,
) {
  try {
    authorityReady(
      row &&
        row.authorization_id &&
        row.account_id === op.account_id &&
        row.authority_epoch < op.epoch &&
        (action.kind !== "observed" || row.issued_at <= action.cutoffS),
    );
    validateAuthorityOriginal(row, action, identity);
    await validateAuthorityOriginalAccount(db, row);
  } catch {
    throw new CommunityAuthorityPending();
  }
}
/** At most50 frozen members per call, including already-ACKed/advanced pages.
 * Cursor/provenance survive restart. Failed or stale validation advances nothing.
 * Identity/credential/membership revisions are compared inside the durable CAS. */
async function revalidateWithCredentialWitness(
  db: D1Database,
  op: AuthorityOperation,
) {
  await assertAuthorityOriginalsUnchanged(db, op);
  const action = JSON.parse(op.request_json) as AuthorityAction;
  authorityReady(
    digest(action) === op.operation_id &&
      action.accountId === op.account_id &&
      action.actionId === op.action_id &&
      Number(action.expectedRevision) + 1 === op.epoch,
  );
  // Capture BEFORE the wallet lookup. A changed/ABA revision cannot be
  // certified by a later upsert, even when there are no frozen members.
  const credentialRevision = await captureCredentialRevision(db, op.account_id);
  // An absent revision row means counter0, never credential authority. Check
  // the captured action wallet even when retained membership is empty.
  try {
    await validateAuthorityOriginalAccount(db, {
      account_id: op.account_id,
      subject: action.wallet,
    });
  } catch {
    throw new CommunityAuthorityPending();
  }
  await db
    .prepare(
      `INSERT INTO learning_authority_validation(operation_id,policy,original_revision,credential_revision,member_revision)
 SELECT o.operation_id,?2,o.original_revision,?3,o.member_revision FROM learning_authority_operations o
 LEFT JOIN learning_authority_credentials c ON c.account_id=o.account_id
 WHERE o.operation_id=?1 AND o.complete=0 AND COALESCE(c.revision,0)=?3
 ON CONFLICT(operation_id) DO UPDATE SET policy=excluded.policy,original_revision=excluded.original_revision,
 credential_revision=excluded.credential_revision,member_revision=excluded.member_revision,
 cursor='',complete=0,generation=generation+1
 WHERE policy!=excluded.policy OR original_revision!=excluded.original_revision OR credential_revision!=excluded.credential_revision OR member_revision!=excluded.member_revision`,
    )
    .bind(op.operation_id, policy, credentialRevision)
    .run();
  const validation = await db
    .prepare("SELECT * FROM learning_authority_validation WHERE operation_id=?")
    .bind(op.operation_id)
    .first<Validation>();
  authorityReady(
    validation &&
      validation.policy === policy &&
      validation.credential_revision === credentialRevision,
  );
  if (validation.complete) {
    await requireValidationAtRevision(db, op, credentialRevision);
    return { ready: true, credentialRevision };
  }
  const rows = await db
    .prepare(
      `SELECT m.authorization_id AS member_id,a.* FROM learning_authority_members m
 LEFT JOIN learning_authorizations a ON a.authorization_id=m.authorization_id
 WHERE m.operation_id=? AND m.authorization_id>? ORDER BY m.authorization_id LIMIT 50`,
    )
    .bind(op.operation_id, validation.cursor)
    .all<RetainedAuthorityOriginal & { member_id: Hex }>();
  const identity = await originalContext(db);
  for (const row of rows.results) {
    authorityReady(row.member_id === row.authorization_id);
    await validateMember(db, row, op, action, identity);
  }
  const next = rows.results.at(-1)?.member_id ?? validation.cursor;
  const more = await db
    .prepare(
      "SELECT 1 FROM learning_authority_members WHERE operation_id=? AND authorization_id>? LIMIT 1",
    )
    .bind(op.operation_id, next)
    .first();
  const changed = await db
    .prepare(
      `UPDATE learning_authority_validation AS v SET cursor=?2,complete=?3
 WHERE operation_id=?1 AND generation=?4 AND cursor=?5 AND policy=?6 AND credential_revision=?7 AND complete=0 AND ${current}`,
    )
    .bind(
      op.operation_id,
      next,
      Number(!more),
      validation.generation,
      validation.cursor,
      policy,
      credentialRevision,
    )
    .run();
  authorityReady(changed.meta.changes === 1);
  await assertAuthorityOriginalsUnchanged(db, op);
  if (!more) await requireValidationAtRevision(db, op, credentialRevision);
  return { ready: !more, credentialRevision };
}

/** Existing recovery API: partial validation remains a durable continuation,
 * never permanent denial. The delivery path retains the private witness too. */
export async function revalidateAuthorityMembers(
  db: D1Database,
  op: AuthorityOperation,
) {
  return (await revalidateWithCredentialWitness(db, op)).ready;
}

/** Required structural port for the coordinator's managed Telegram assembly.
 * It is called after signing and immediately before every authority denial
 * fetch, and before transition completion, including independent alarm recovery. */
export interface AuthorityDeliveryRequest {
  transitionId: string;
  requestHash: string;
  scope: BotScope;
  accountId: string | null;
  target: { communityId: string; chainId: number; contract: string };
  denial?: TelegramStudyDenial;
}
export async function validateManagedAuthorityDelivery(
  db: D1Database,
  request: AuthorityDeliveryRequest,
) {
  const op = await db
    .prepare(
      "SELECT * FROM learning_authority_operations WHERE transition_id=?",
    )
    .bind(request.transitionId)
    .first<AuthorityOperation>();
  authorityReady(op && !op.complete && op.sealed);
  const action = JSON.parse(op.request_json) as AuthorityAction;
  authorityReady(
    action.kind !== "observed" &&
      digest(action) === op.operation_id &&
      request.accountId === op.account_id &&
      digest(request.scope) === digest(action.scope) &&
      request.target.communityId === action.scope.communityId &&
      request.target.chainId === action.target.chainId &&
      request.target.contract.toLowerCase() === action.target.contract &&
      request.transitionId ===
        digest([
          "authority",
          action.scope.communityId,
          action.scope.botId,
          op.account_id,
          op.operation_id,
        ]) &&
      request.requestHash ===
        digest({
          kind: "authority",
          communityId: action.scope.communityId,
          botId: action.scope.botId,
          accountId: op.account_id,
          operationId: op.operation_id,
          expectedGrantId: action.expectedGrantId,
        }),
  );
  const witness = await revalidateWithCredentialWitness(db, op);
  authorityReady(witness.ready);
  const denial = request.denial;
  if (denial) {
    authorityReady(denial.communityId === action.scope.communityId);
    if (denial.kind === "authorization") {
      const row = await db
        .prepare(
          `SELECT a.* FROM learning_authority_members m JOIN learning_authorizations a ON a.authorization_id=m.authorization_id
    WHERE m.operation_id=? AND m.authorization_id=?`,
        )
        .bind(op.operation_id, denial.authorizationId)
        .first<RetainedAuthorityOriginal>();
      authorityReady(row);
      await validateMember(db, row, op, action, await originalContext(db));
    } else
      authorityReady(
        denial.kind === "grant" &&
          denial.botId === action.scope.botId &&
          denial.grantId === action.expectedGrantId,
      );
  }
  await requireValidationAtRevision(db, op, witness.credentialRevision);
}
