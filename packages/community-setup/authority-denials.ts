import { check, digest } from "../protocol/index.ts";
import {
  telegramStudyDenial,
  type TelegramStudyDenial,
} from "../study/telegram-publication.ts";
import {
  authorityOperation,
  authorityReady,
  assertAuthorityOriginalsUnchanged,
  type AuthorityAction,
  type AuthorityTransitionPort,
} from "./authority-ledger.ts";

/** Selective historical withdrawal bridge. Unlike the held Telegram managed
 * transition, it never retires a current grant or writes a grant-wide denial.
 * The caller supplies the existing REQUIRED issuer-signed operator bridge. */
export function authorityDenialTransition(options: {
  db: D1Database;
  target: AuthorityAction["target"];
  wake(): Promise<void>;
  deny(
    value: TelegramStudyDenial,
  ): Promise<{ recorded: true; denialHash: string }>;
}): AuthorityTransitionPort {
  const { db } = options;
  return {
    async beginAuthorityTransition(scope, accountId, request) {
      await options.wake();
      const op = await authorityOperation(db, request.operationId);
      authorityReady(op);
      await assertAuthorityOriginalsUnchanged(db, op);
      const action = JSON.parse(op.request_json) as AuthorityAction;
      check(
        digest(action.target) === digest(options.target),
        "authority_target_changed",
      );
      check(
        action.kind === "observed" &&
          digest(action.scope) === digest(scope) &&
          op.account_id === accountId &&
          action.expectedGrantId === request.expectedGrantId,
        "authority_transition_changed",
      );
      return op.operation_id;
    },
    async appendAuthorizations(id, page) {
      const op = await authorityOperation(db, id);
      authorityReady(op);
      await assertAuthorityOriginalsUnchanged(db, op);
      const action = JSON.parse(op.request_json) as AuthorityAction;
      check(
        digest(action.target) === digest(options.target),
        "authority_target_changed",
      );
      check(
        action.kind === "observed" && page.authorizationIds.length <= 50,
        "authority_transition_changed",
      );
      const frozen = await db
        .prepare(
          "SELECT page_json FROM learning_authority_pages WHERE operation_id=? AND page_id=?",
        )
        .bind(id, digest(page.cursor))
        .first<{ page_json: string }>();
      check(
        frozen?.page_json === JSON.stringify(page),
        "authority_transition_changed",
      );
      for (const authorizationId of page.authorizationIds) {
        const denial = telegramStudyDenial({
            schema: "pirate.study.telegram-publication-denial/1",
            communityId: action.scope.communityId,
            kind: "authorization",
            authorizationId,
          }),
          hash = digest(denial);
        const child = await db
          .prepare(
            "SELECT acknowledgment FROM learning_authority_members WHERE operation_id=? AND authorization_id=?",
          )
          .bind(id, authorizationId)
          .first<{ acknowledgment: string | null }>();
        authorityReady(child);
        if (child.acknowledgment) {
          check(child.acknowledgment === hash, "authority_denial_changed");
          continue;
        }
        await options.wake();
        await assertAuthorityOriginalsUnchanged(db, op);
        const receipt = await options.deny(denial);
        check(
          receipt.recorded === true && receipt.denialHash === hash,
          "authority_denial_ack_invalid",
        );
        await db
          .prepare(
            "UPDATE learning_authority_members SET acknowledgment=? WHERE operation_id=? AND authorization_id=? AND acknowledgment IS NULL",
          )
          .bind(hash, id, authorizationId)
          .run();
      }
    },
    async finishAuthorityTransition(id) {
      const op = await authorityOperation(db, id);
      authorityReady(op?.sealed);
      await assertAuthorityOriginalsUnchanged(db, op);
      check(
        digest((JSON.parse(op.request_json) as AuthorityAction).target) ===
          digest(options.target),
        "authority_target_changed",
      );
      const pending = await db
        .prepare(
          "SELECT 1 FROM learning_authority_members WHERE operation_id=? AND acknowledgment IS NULL LIMIT 1",
        )
        .bind(id)
        .first();
      authorityReady(!pending);
    },
  };
}
