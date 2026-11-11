import { check, digest } from "../protocol/index.ts";
import {
  authorityOperation,
  authorityReady,
  beginAuthorityAction,
  freezeAuthorityPage,
  type AuthorityAction,
  type AuthorityPorts,
} from "./authority-ledger.ts";

export interface AuthorityRecoveryPorts extends AuthorityPorts {
  /** Required registry lookup of the retained original target. */
  usingTarget(target: AuthorityAction["target"]): AuthorityRecoveryPorts;
  /** Trusted current chain read for explicit on. Not browser-provided facts. */
  observeTurnOn(
    action: AuthorityAction,
  ): Promise<{ revocationNonce: string; pendingWithdrawal: boolean }>;
  /** Resolve the original community scope/grant predecessor. No newest-sign-in
   * selection or invented account-disable/reassociation API is permitted. */
  legacyAction(accountId: string): Promise<AuthorityAction | null>;
}
export async function progressAuthorityAction(
  db: D1Database,
  id: string,
  ports: AuthorityRecoveryPorts,
) {
  await ports.wake();
  let op = await authorityOperation(db, id);
  authorityReady(op);
  if (op.complete) return op;
  const action = JSON.parse(op.request_json) as AuthorityAction;
  check(
    digest(ports.target) === digest(action.target),
    "authority_target_changed",
  );
  const bridge =
    action.kind === "observed" ? ports.authorizationsOnly : ports.transitions;
  // Canonical local lesson/attempt/private outbox closure always runs BEFORE
  // any callback that can wait on Telegram/operator reconciliation.
  await ports.closeLocal(op.account_id);
  if (!op.transition_id) {
    const transition = await bridge.beginAuthorityTransition(
      action.scope,
      action.accountId,
      { operationId: id, expectedGrantId: action.expectedGrantId },
    );
    await db
      .prepare(
        `UPDATE learning_authority_operations SET transition_id=?2 WHERE operation_id=?1 AND transition_id IS NULL
      AND EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?3 AND revision=?4 AND pending_operation=?1)`,
      )
      .bind(id, transition, op.account_id, op.epoch)
      .run();
    op = await authorityOperation(db, id);
    authorityReady(op?.transition_id === transition);
  }
  if (!op.sealed) {
    const page = await freezeAuthorityPage(db, op);
    await bridge.appendAuthorizations(op.transition_id!, page);
    // Lost acknowledgement retries the identical captured page and originals.
    await db.batch([
      db
        .prepare(
          `UPDATE learning_authority_pages SET acknowledged=1 WHERE operation_id=?1 AND page_id=?2 AND page_json=?3
        AND EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?4 AND revision=?5 AND pending_operation=?1)`,
        )
        .bind(
          id,
          digest(page.cursor),
          JSON.stringify(page),
          op.account_id,
          op.epoch,
        ),
      db
        .prepare(
          `UPDATE learning_authority_operations SET cursor=?2,sealed=?3 WHERE operation_id=?1 AND cursor IS ?4 AND sealed=0
        AND EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?5 AND revision=?6 AND pending_operation=?1)
        AND EXISTS(SELECT 1 FROM learning_authority_pages WHERE operation_id=?1 AND page_id=?7 AND acknowledged=1)`,
        )
        .bind(
          id,
          page.next,
          Number(page.exhausted),
          page.cursor,
          op.account_id,
          op.epoch,
          digest(page.cursor),
        ),
    ]);
    op = await authorityOperation(db, id);
    authorityReady(op);
    if (!op.sealed) return op; // Bounded page per scheduler iteration.
  }
  await bridge.finishAuthorityTransition(op.transition_id!);
  const live =
    action.kind === "on" ? await ports.observeTurnOn(action) : undefined;
  authorityReady(!live?.pendingWithdrawal);
  if (live)
    check(
      /^(0|[1-9][0-9]{0,19})$/.test(live.revocationNonce) &&
        BigInt(live.revocationNonce) >= BigInt(action.revocationNonce),
      "authority_observation_changed",
    );
  const nonce = live?.revocationNonce ?? action.revocationNonce;
  const owns = `EXISTS(SELECT 1 FROM learning_authority_heads WHERE account_id=?1 AND pending_operation=?2 AND revision=?3)
    AND EXISTS(SELECT 1 FROM learning_authority_operations WHERE operation_id=?2 AND sealed=1 AND complete=0)`;
  // Exact nonce acknowledgment and epoch predicates survive every async read.
  const observedFence =
    action.kind === "observed"
      ? `AND (acknowledged_revocation_nonce IS NULL OR length(acknowledged_revocation_nonce)<length(?4)
    OR (length(acknowledged_revocation_nonce)=length(?4) AND acknowledged_revocation_nonce<?4))`
      : "";
  const settings =
    action.kind === "observed"
      ? // begin already applied the guarded public-state observation. Later valid
        // sign-ins/acknowledgments remain intact; this operation retires only its
        // captured historical originals, never the unaffected current grant.
        db
          .prepare(
            `SELECT 1 WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL AND ?3 IS NOT NULL AND ?4 IS NOT NULL`,
          )
          .bind(op.account_id, id, op.epoch, nonce)
      : action.kind === "on"
        ? db
            .prepare(
              `INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at,acknowledged_revocation_nonce)
        SELECT ?1,NULL,?5,?4 WHERE ${owns}
        ON CONFLICT(account_id) DO UPDATE SET public_results_withdrawn_at=NULL,
        last_withdrawn_at=MAX(COALESCE(last_withdrawn_at,0),excluded.last_withdrawn_at),
        acknowledged_revocation_nonce=CASE WHEN acknowledged_revocation_nonce IS NULL OR length(acknowledged_revocation_nonce)<length(?4)
          OR (length(acknowledged_revocation_nonce)=length(?4) AND acknowledged_revocation_nonce<?4) THEN ?4 ELSE acknowledged_revocation_nonce END
        WHERE ${owns}`,
            )
            .bind(op.account_id, id, op.epoch, nonce, action.atMs)
        : db
            .prepare(
              `UPDATE learning_settings SET public_results_withdrawn_at=COALESCE(public_results_withdrawn_at,?5),
        last_withdrawn_at=MAX(COALESCE(last_withdrawn_at,0),?5)
        WHERE account_id=?1 AND ${owns} ${observedFence}`,
            )
            .bind(
              op.account_id,
              id,
              op.epoch,
              nonce,
              action.kind === "observed" ? action.cutoffS * 1000 : action.atMs,
            );
  await db.batch([
    settings,
    db
      .prepare(
        `DELETE FROM learning_authority_dirty WHERE account_id=?1 AND ${owns}
      AND version=(SELECT dirty_version FROM learning_authority_operations WHERE operation_id=?2)`,
      )
      .bind(op.account_id, id, op.epoch),
    db
      .prepare(
        `UPDATE learning_authority_operations SET complete=1 WHERE operation_id=?2 AND account_id=?1 AND sealed=1 AND ${owns}`,
      )
      .bind(op.account_id, id, op.epoch),
    db
      .prepare(
        `UPDATE learning_authority_heads SET pending_operation=NULL,revision=revision+1,
      permission_revision=permission_revision+?4,
      processed_withdrawn_at=CASE WHEN NOT EXISTS(SELECT 1 FROM learning_authority_dirty WHERE account_id=?1)
        THEN (SELECT last_withdrawn_at FROM learning_settings WHERE account_id=?1) ELSE processed_withdrawn_at END
      WHERE account_id=?1 AND pending_operation=?2 AND revision=?3
      AND EXISTS(SELECT 1 FROM learning_authority_operations WHERE operation_id=?2 AND complete=1 AND sealed=1)`,
      )
      .bind(op.account_id, id, op.epoch, Number(action.kind !== "observed")),
  ]);
  const done = await authorityOperation(db, id);
  authorityReady(done?.complete);
  return done;
}

/** Dirty rows include pre-migration off markers and every later off writer,
 * including behind a completed cursor. Fair SQL ordering is persisted before
 * remote calls. Unresolved rows remain durable, never catch-and-advanced away. */
export async function recoverCommunityAuthority(
  db: D1Database,
  ports: AuthorityRecoveryPorts,
  limit = 10,
) {
  check(
    Number.isSafeInteger(limit) && limit > 0 && limit <= 50,
    "authority_scan_invalid",
  );
  await ports.wake();
  const dirty = await db
    .prepare(
      "SELECT account_id FROM learning_authority_dirty ORDER BY updated_at,account_id LIMIT ?",
    )
    .bind(limit)
    .all<{ account_id: string }>();
  for (const row of dirty.results) {
    await db
      .prepare(
        "UPDATE learning_authority_dirty SET updated_at=(SELECT COALESCE(MAX(updated_at),0)+1 FROM learning_authority_dirty) WHERE account_id=?",
      )
      .bind(row.account_id)
      .run();
    try {
      const head = await db
        .prepare(
          "SELECT pending_operation FROM learning_authority_heads WHERE account_id=?",
        )
        .bind(row.account_id)
        .first<{ pending_operation: string | null }>();
      if (!head?.pending_operation) {
        const action = await ports.legacyAction(row.account_id);
        authorityReady(action);
        await beginAuthorityAction(
          db,
          action,
          ports.usingTarget(action.target),
        );
      }
    } catch (error) {
      await db
        .prepare(
          "UPDATE learning_authority_dirty SET error=? WHERE account_id=?",
        )
        .bind(String(error), row.account_id)
        .run();
    }
  }
  const rows = await db
    .prepare(
      "SELECT operation_id FROM learning_authority_operations WHERE complete=0 ORDER BY updated_at,operation_id LIMIT ?",
    )
    .bind(limit)
    .all<{ operation_id: string }>();
  for (const row of rows.results) {
    await db
      .prepare(
        "UPDATE learning_authority_operations SET updated_at=(SELECT COALESCE(MAX(updated_at),0)+1 FROM learning_authority_operations) WHERE operation_id=?",
      )
      .bind(row.operation_id)
      .run();
    try {
      const op = await authorityOperation(db, row.operation_id);
      authorityReady(op);
      const action = JSON.parse(op.request_json) as AuthorityAction;
      await progressAuthorityAction(
        db,
        row.operation_id,
        ports.usingTarget(action.target),
      );
    } catch (error) {
      await db
        .prepare(
          "UPDATE learning_authority_operations SET error=? WHERE operation_id=? AND complete=0",
        )
        .bind(String(error), row.operation_id)
        .run();
    }
  }
}
