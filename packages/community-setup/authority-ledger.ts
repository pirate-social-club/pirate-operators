import type { Hex } from "viem";
import { check, digest } from "../protocol/index.ts";
import { validateScope, type BotScope } from "../telegram/contracts.ts";
import type { ResultsTarget } from "../../services/learning-contract.ts";
import {
  INVALID_AUTHORITY_ORIGINAL_QUERY,
  AUTHORITY_ORIGINAL_PAGE_QUERY,
  validateAuthorityOriginal,
  validateAuthorityOriginalAccount,
  type RetainedAuthorityOriginal,
} from "./authority-originals.ts";

export class CommunityAuthorityPending extends Error {
  readonly status = 503;
  readonly retryable = true;
  constructor() {
    super("community_authority_pending");
  }
}
export function authorityReady(value: unknown): asserts value {
  if (!value) throw new CommunityAuthorityPending();
}
export interface AuthorityAction {
  target: ResultsTarget;
  /** Authenticated explicit application action, separate from revocationId.
   * The shared Origin/CSRF/session boundary must supply these trusted fields. */
  actionId: string;
  accountId: string;
  wallet: string;
  scope: BotScope;
  expectedRevision: string;
  expectedGrantId: string | null;
  kind: "off" | "on" | "observed" | "legacy_off";
  atMs: number;
  cutoffS: number;
  revocationNonce: string;
  /** Exact accepted original revoke identity/outcome, never a replacement tx. */
  originalRevocationId: string | null;
}
export interface AuthorityOperation {
  operation_id: string;
  account_id: string;
  action_id: string;
  request_json: string;
  epoch: number;
  cursor: string | null;
  sealed: number;
  complete: number;
  transition_id: string | null;
  updated_at: number;
  dirty_version: number | null;
  original_revision: number | null;
}
export interface AuthorityPage {
  cursor: string | null;
  next: string | null;
  authorizationIds: Hex[];
  exhausted: boolean;
}
/** Matches the Telegram actor's proposed structural methods. Still held for
 * its independent source repairs; never import a peer worktree at runtime. */
export interface AuthorityTransitionPort {
  beginAuthorityTransition(
    scope: BotScope,
    accountId: string,
    request: { operationId: string; expectedGrantId: string | null },
  ): Promise<string>;
  appendAuthorizations(id: string, page: AuthorityPage): void | Promise<void>;
  finishAuthorityTransition(id: string): Promise<void>;
}
export interface AuthorityPorts {
  target: ResultsTarget;
  transitions: AuthorityTransitionPort;
  /** Historical selection must NOT retire an unaffected current grant. */
  authorizationsOnly: AuthorityTransitionPort;
  /** Pre-arm durable earliest wake before SQL staging/remote work. Startup
   * and scheduled drain MUST also scan the durable SQL outbox/dirty records. */
  wake(): Promise<void>;
  closeLocal(accountId: string): Promise<void>;
}
export async function readAuthorityState(db: D1Database, accountId: string) {
  try {
    const row = await db
      .prepare(
        `SELECT h.revision,h.permission_revision,h.pending_operation,
      EXISTS(SELECT 1 FROM learning_authority_dirty d WHERE d.account_id=?1) AS dirty,
      (SELECT public_results_withdrawn_at FROM learning_settings WHERE account_id=?1) AS withdrawn,
      h.processed_withdrawn_at FROM (SELECT ?1 AS account_id) a
      LEFT JOIN learning_authority_heads h ON h.account_id=a.account_id`,
      )
      .bind(accountId)
      .first<{
        revision: number | null;
        permission_revision: number | null;
        pending_operation: string | null;
        dirty: number;
        withdrawn: number | null;
        processed_withdrawn_at: number | null;
      }>();
    return {
      revision: String(row?.revision ?? 0),
      permissionRevision: String(row?.permission_revision ?? 0),
      pending:
        !row ||
        !!row.pending_operation ||
        !!row.dirty ||
        (row.withdrawn !== null && row.processed_withdrawn_at === null),
    };
  } catch {
    throw new CommunityAuthorityPending();
  } // Missing migration is a hold, not denial.
}
export async function captureAuthority(db: D1Database, accountId: string) {
  const state = await readAuthorityState(db, accountId);
  authorityReady(!state.pending);
  return state.revision;
}
export async function compareAuthority(
  db: D1Database,
  accountId: string,
  revision: string,
) {
  const state = await readAuthorityState(db, accountId);
  authorityReady(!state.pending && state.revision === revision);
}
export async function authorityOriginalDenied(
  db: D1Database,
  accountId: string,
  authorizationId: string,
) {
  const row = await db
    .prepare(
      `SELECT 1 FROM learning_authority_members m JOIN learning_authority_operations o ON o.operation_id=m.operation_id
    WHERE o.account_id=? AND o.complete=1 AND o.sealed=1 AND m.authorization_id=? LIMIT 1`,
    )
    .bind(accountId, authorizationId)
    .first();
  return !!row;
}
/** Selected-profile relay guard: pending never changes a row to refused. */
export async function fenceAuthorityRelay(
  db: D1Database,
  accountId: string,
  authorizationId: string,
) {
  await captureAuthority(db, accountId);
  if (await authorityOriginalDenied(db, accountId, authorizationId))
    throw new CommunityAuthorityPending();
}
export const authorityOperation = (db: D1Database, id: string) =>
  db
    .prepare("SELECT * FROM learning_authority_operations WHERE operation_id=?")
    .bind(id)
    .first<AuthorityOperation>();

/** Indexed invalid guard plus an O(1) immutable-original revision fence. State,
 * receipt and retry updates do not change this revision. Identity mutations
 * behind a completed cursor retain the operation as an unresolved hold. */
export async function assertAuthorityOriginalsUnchanged(
  db: D1Database,
  op: AuthorityOperation,
) {
  const invalid = await db
    .prepare(INVALID_AUTHORITY_ORIGINAL_QUERY)
    .bind(op.account_id)
    .first();
  authorityReady(!invalid);
  const unchanged = await db
    .prepare(
      `SELECT 1 FROM learning_authority_operations o
    JOIN learning_authority_heads h ON h.account_id=o.account_id
    LEFT JOIN learning_authority_original_heads r ON r.account_id=o.account_id
    WHERE o.operation_id=?1 AND o.epoch=?2 AND h.pending_operation=?1 AND h.revision=?2
      AND o.original_revision=COALESCE(r.revision,0)`,
    )
    .bind(op.operation_id, op.epoch)
    .first();
  authorityReady(unchanged);
}

/** Stage before mutations/discovery. Exact retries retain their predecessor
 * and result, including a prior terminal reverted revoke. New explicit actions
 * require a new authenticated action identity AND the current predecessor. */
export async function beginAuthorityAction(
  db: D1Database,
  action: AuthorityAction,
  ports: AuthorityPorts,
) {
  validateScope(action.scope);
  check(
    action.target.version === 4 &&
      [31337, 6343].includes(action.target.chainId) &&
      /^0x[0-9a-f]{40}$/.test(action.target.contract) &&
      BigInt(action.target.contract) > 0n &&
      digest(ports.target) === digest(action.target) &&
      ["off", "on", "observed", "legacy_off"].includes(action.kind) &&
      Number.isSafeInteger(action.cutoffS * 1000) &&
      BigInt(action.revocationNonce) < 1n << 64n,
    "authority_action_invalid",
  );
  check(
    /^[a-zA-Z0-9_:-]{1,128}$/.test(action.actionId) &&
      /^0x[0-9a-f]{40}$/.test(action.wallet) &&
      /^(0|[1-9][0-9]{0,14})$/.test(action.expectedRevision) &&
      /^(0|[1-9][0-9]{0,19})$/.test(action.revocationNonce) &&
      Number.isSafeInteger(action.atMs) &&
      Number.isSafeInteger(action.cutoffS) &&
      action.atMs >= 0 &&
      action.cutoffS >= 0,
    "authority_action_invalid",
  );
  const id = digest(action),
    existing = await db
      .prepare(
        "SELECT * FROM learning_authority_operations WHERE account_id=? AND action_id=?",
      )
      .bind(action.accountId, action.actionId)
      .first<AuthorityOperation>();
  if (existing) {
    check(existing.operation_id === id, "authority_action_changed");
    return existing;
  }
  await ports.wake();
  // A historical observation cannot undo a newer acknowledged on choice or
  // retire a sign-in issued after its canonical cutoff.
  const observationFence =
    action.kind === "observed"
      ? `AND NOT EXISTS(SELECT 1 FROM learning_settings s WHERE s.account_id=?1 AND s.acknowledged_revocation_nonce IS NOT NULL
    AND (length(s.acknowledged_revocation_nonce)>length(?5) OR (length(s.acknowledged_revocation_nonce)=length(?5) AND s.acknowledged_revocation_nonce>=?5)))
    AND NOT EXISTS(SELECT 1 FROM learning_authorizations a WHERE a.account_id=?1 AND a.state IN ('pending','recorded') AND a.issued_at>?6)`
      : "";
  const epoch = Number(action.expectedRevision) + 1;
  await db.batch([
    db
      .prepare(
        "INSERT INTO learning_authority_heads(account_id) VALUES(?) ON CONFLICT DO NOTHING",
      )
      .bind(action.accountId),
    db
      .prepare(
        `INSERT INTO learning_authority_operations(operation_id,account_id,action_id,request_json,epoch,updated_at)
      SELECT ?2,?1,?3,?4,?5,?6 FROM learning_authority_heads h WHERE h.account_id=?1
      AND h.revision=?8 AND h.pending_operation IS NULL
      AND EXISTS(SELECT 1 FROM credential_bindings b WHERE b.account_id=?1 AND b.namespace='moss' AND b.network=6343 AND b.subject=?9)
      AND EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=?10)
      ON CONFLICT DO NOTHING`,
      )
      .bind(
        action.accountId,
        id,
        action.actionId,
        JSON.stringify(action),
        epoch,
        action.atMs,
        action.revocationNonce,
        Number(action.expectedRevision),
        action.wallet,
        action.scope.communityId,
      ),
    db
      .prepare(
        `UPDATE learning_authority_heads SET revision=?3,pending_operation=?2 WHERE account_id=?1 AND revision=?4 AND pending_operation IS NULL
      AND EXISTS(SELECT 1 FROM learning_authority_operations WHERE operation_id=?2 AND epoch=?3)`,
      )
      .bind(action.accountId, id, epoch, Number(action.expectedRevision)),
    db
      .prepare(
        `INSERT INTO learning_authority_dirty(account_id,updated_at)
      SELECT ?1,?3 WHERE EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?1 AND pending_operation=?2 AND revision=?4)
      ON CONFLICT(account_id) DO UPDATE SET updated_at=excluded.updated_at,version=version+1`,
      )
      .bind(action.accountId, id, action.atMs, epoch),
    // Local closure always precedes a callback that can await reconciliation.
    ...(action.kind === "on"
      ? []
      : [
          db
            .prepare(
              `INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at)
      SELECT ?1,?3,?3 WHERE EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?1 AND pending_operation=?2 AND revision=?4) ${observationFence}
      ON CONFLICT(account_id) DO UPDATE SET public_results_withdrawn_at=COALESCE(public_results_withdrawn_at,excluded.public_results_withdrawn_at),
      last_withdrawn_at=MAX(COALESCE(last_withdrawn_at,0),excluded.last_withdrawn_at)`,
            )
            .bind(
              action.accountId,
              id,
              action.kind === "observed" ? action.cutoffS * 1000 : action.atMs,
              epoch,
              ...(action.kind === "observed"
                ? [action.revocationNonce, action.cutoffS]
                : []),
            ),
        ]),
    db
      .prepare(
        `UPDATE learning_authority_operations SET dirty_version=(SELECT version FROM learning_authority_dirty WHERE account_id=?1),
        original_revision=COALESCE((SELECT revision FROM learning_authority_original_heads WHERE account_id=?1),0)
      WHERE operation_id=?2 AND EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?1 AND revision=?3 AND pending_operation=?2)`,
      )
      .bind(action.accountId, id, epoch),
  ]);
  const staged = await authorityOperation(db, id);
  authorityReady(staged);
  await ports.closeLocal(action.accountId);
  return staged;
}

/** Freeze a bounded original page BEFORE calling the bridge. Selection is
 * epoch-bound, all retained authorization states, no D1 publication assumption.
 * Historical observed withdrawals preserve legitimate post-cutoff originals. */
export async function freezeAuthorityPage(
  db: D1Database,
  op: AuthorityOperation,
) {
  await assertAuthorityOriginalsUnchanged(db, op);
  const pageId = digest(op.cursor),
    prior = await db
      .prepare(
        "SELECT page_json FROM learning_authority_pages WHERE operation_id=? AND page_id=?",
      )
      .bind(op.operation_id, pageId)
      .first<{ page_json: string }>();
  if (prior) {
    const page = JSON.parse(prior.page_json) as AuthorityPage;
    authorityReady(page.authorizationIds.length <= 50);
    try {
      for (const id of page.authorizationIds) {
        const row = await db
          .prepare(
            "SELECT account_id,subject FROM learning_authorizations WHERE authorization_id=? AND account_id=?",
          )
          .bind(id, op.account_id)
          .first<{ account_id: string; subject: string }>();
        authorityReady(row);
        await validateAuthorityOriginalAccount(db, row);
      }
    } catch {
      throw new CommunityAuthorityPending();
    }
    await assertAuthorityOriginalsUnchanged(db, op);
    return page;
  }
  const action = JSON.parse(op.request_json) as AuthorityAction;
  const rows = await db
    .prepare(AUTHORITY_ORIGINAL_PAGE_QUERY)
    .bind(op.account_id, op.epoch, op.cursor ?? "")
    .all<RetainedAuthorityOriginal>();
  const identity = await db
    .prepare(
      "SELECT community_id,community_origin FROM application_identity WHERE id=1",
    )
    .first<{ community_id: string; community_origin: string }>();
  authorityReady(identity);
  try {
    for (const row of rows.results) {
      validateAuthorityOriginal(row, action, identity);
      await validateAuthorityOriginalAccount(db, row);
    }
  } catch {
    throw new CommunityAuthorityPending();
  }
  const page: AuthorityPage = {
    cursor: op.cursor,
    next: rows.results.at(-1)?.authorization_id ?? op.cursor,
    authorizationIds: rows.results
      .filter(
        (row) => action.kind !== "observed" || row.issued_at <= action.cutoffS,
      )
      .map((row) => row.authorization_id),
    exhausted: rows.results.length < 50,
  };
  const owns = `EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?1 AND pending_operation=?2 AND revision=?3)
     AND EXISTS(SELECT 1 FROM learning_authority_operations o WHERE o.operation_id=?2 AND o.original_revision=COALESCE((SELECT revision FROM learning_authority_original_heads WHERE account_id=?1),0))`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO learning_authority_pages(operation_id,page_id,page_json) SELECT ?2,?4,?5 WHERE ${owns}
      AND EXISTS(SELECT 1 FROM learning_authority_operations WHERE operation_id=?2 AND cursor IS ?6 AND sealed=0) ON CONFLICT DO NOTHING`,
      )
      .bind(
        op.account_id,
        op.operation_id,
        op.epoch,
        pageId,
        JSON.stringify(page),
        op.cursor,
      ),
    ...page.authorizationIds.map((id) =>
      db
        .prepare(
          `INSERT INTO learning_authority_members(operation_id,authorization_id) SELECT ?2,?4 WHERE ${owns} ON CONFLICT DO NOTHING`,
        )
        .bind(op.account_id, op.operation_id, op.epoch, id),
    ),
  ]);
  const saved = await db
    .prepare(
      "SELECT page_json FROM learning_authority_pages WHERE operation_id=? AND page_id=?",
    )
    .bind(op.operation_id, pageId)
    .first<{ page_json: string }>();
  await assertAuthorityOriginalsUnchanged(db, op);
  authorityReady(saved);
  check(
    saved.page_json === JSON.stringify(page),
    "authority_discovery_changed",
  );
  return page;
}
