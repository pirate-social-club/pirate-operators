// Prepared native SQLite/D1 + actual Telegram journal/bridge fixture. UNRUN.
// A retained59908a state is explicitly reconstructed, never admitted as a new
// current selection. Fixed public fixture accounts only; no new key/provider.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  signInMessageV4,
  signInIdV4,
} from "../packages/protocol/learning-results-v4.ts";
import { signInV4 } from "../services/learning-sign-in.ts";
import { closeWithdrawnStudyLessons } from "../services/learning-public-results.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramManagedPublication } from "../services/telegram-managed-publication.ts";
import { telegramAccountPort } from "../services/telegram-accounts.ts";
import { authorityDenialTransition } from "../packages/community-setup/authority-denials.ts";
import { denyManagedStudyPublication } from "../services/study-operator-client.ts";
import {
  beginAuthorityAction,
  readAuthorityState,
  type AuthorityAction,
  type AuthorityPage,
} from "../packages/community-setup/authority-ledger.ts";
import {
  progressAuthorityAction,
  type AuthorityRecoveryPorts,
} from "../packages/community-setup/authority-recovery.ts";
import { validateManagedAuthorityDelivery } from "../packages/community-setup/authority-validation.ts";
import { journalFixture } from "./telegram-fixture.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";
import {
  withdrawalFixture,
  wallet,
} from "./learning-public-results-memory-fixture.ts";

export async function revalidationFixture(
  count = 1,
  bad = false,
  sealed = true,
) {
  const f = await withdrawalFixture(),
    journal = journalFixture();
  let clock = f.now;
  try {
    const selected = signInV4(f.env, f.ports.config)!;
    const target = {
      chainId: 6343,
      version: 4,
      contract: selected.contract,
    } as const;
    const scope = {
      communityId: f.owner.communityId,
      botId: "123",
      generation: 1,
    };
    await f.db.prepare("DELETE FROM learning_authorizations").run();
    await f.db
      .prepare(
        "INSERT INTO credential_bindings VALUES('binding-b','b','moss',6343,?,0)",
      )
      .bind(accounts[4].address.toLowerCase())
      .run();
    const ids: `0x${string}`[] = [];
    for (let index = 0; index < count; index++) {
      const signer = bad && index === 0 ? accounts[4] : accounts[5];
      const context = {
        origin: f.ports.config.app.origin,
        chainId: 6343,
        contract: target.contract,
        communityId: scope.communityId,
        publicationPolicy: selected.publicationPolicy,
      };
      const signIn = {
        learner: signer.address,
        nonce: digest("legacy-revalidation-" + index),
        issuedAt: 100n,
      };
      const message = signInMessageV4(context, signIn),
        id = signInIdV4(context, signIn),
        signature = await signer.signMessage({ message });
      await f.db
        .prepare(
          `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
    VALUES(?,'a',?,?,?,?,?,4,100,'recorded',0,0)`,
        )
        .bind(
          id,
          signer.address.toLowerCase(),
          JSON.stringify({ ...signIn, issuedAt: "100" }),
          message,
          signature,
          context.publicationPolicy,
        )
        .run();
      ids.push(id);
    }
    // Consume the actual proposed numbered file as one native SQLite script,
    // NEVER split trigger bodies on semicolons. This models SQL, not actual D1
    // deployment/upgrade/runner qualification, which remains a coordinator gate.
    const sql = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0018_learning_authority.sql",
        import.meta.url,
      ),
      "utf8",
    );
    f.memory.sqlite.exec(sql);
    const accountsPort = telegramAccountPort({
      db: f.db,
      assertAccountEnabled: async () => undefined,
      authorityState: (id) => readAuthorityState(f.db, id),
    });
    const grants = new TelegramGrants(journal.store, accountsPort, () => clock);
    const model = managedFixture(
      grants,
      { ...scope, enabled: true },
      {
        communityId: scope.communityId,
        chainId: 6343,
        contract: target.contract,
      },
    );
    const recreate = () =>
      TelegramManagedPublication.create({
        grants,
        registration: { ...scope, enabled: true },
        ports: model.ports,
        scheduleWork: model.scheduleWork,
        authorityValidation: (request) =>
          validateManagedAuthorityDelivery(f.db, request),
      });
    const publication = recreate();
    await publication.ready();
    const ports: AuthorityRecoveryPorts = {
      target,
      usingTarget: (named) => {
        assert.deepEqual(named, target);
        return ports;
      },
      transitions: publication,
      authorizationsOnly: authorityDenialTransition({
        db: f.db,
        target,
        wake: () => publication.arm(),
        deny: (denial, beforeSend) =>
          denyManagedStudyPublication(model.ports, denial, beforeSend),
      }),
      wake: () => publication.arm(),
      closeLocal: (id) => closeWithdrawnStudyLessons(f.db, id, clock),
      observeTurnOn: async () => ({
        revocationNonce: "1",
        pendingWithdrawal: false,
      }),
      legacyAction: async () => null,
    };
    const action: AuthorityAction = {
      target,
      scope,
      accountId: "a",
      wallet,
      actionId: "retained-original-off",
      expectedRevision: "0",
      expectedGrantId: null,
      kind: "off",
      atMs: f.now,
      cutoffS: 110,
      revocationNonce: "1",
      originalRevocationId: digest("retained-original-raw-proof"),
    };
    const op = await beginAuthorityAction(f.db, action, ports);
    const transitionId = await publication.beginAuthorityTransition(
      scope,
      "a",
      { operationId: op.operation_id, expectedGrantId: null },
    );
    await f.db
      .prepare(
        "UPDATE learning_authority_operations SET transition_id=? WHERE operation_id=?",
      )
      .bind(transitionId, op.operation_id)
      .run();
    const sorted = [...ids].sort();
    let cursor: string | null = null;
    for (let offset = 0; offset < sorted.length; offset += 50) {
      const page: AuthorityPage = {
        cursor,
        next: sorted[Math.min(offset + 50, sorted.length) - 1],
        authorizationIds: sorted.slice(offset, offset + 50),
        exhausted: sealed && offset + 50 >= sorted.length,
      };
      publication.appendAuthorizations(transitionId, page);
      await f.db.batch([
        f.db
          .prepare("INSERT INTO learning_authority_pages VALUES(?,?,?,1)")
          .bind(op.operation_id, digest(cursor), JSON.stringify(page)),
        ...page.authorizationIds.map((id) =>
          f.db
            .prepare(
              "INSERT INTO learning_authority_members(operation_id,authorization_id) VALUES(?,?)",
            )
            .bind(op.operation_id, id),
        ),
      ]);
      cursor = page.next;
    }
    await f.db
      .prepare(
        "UPDATE learning_authority_operations SET cursor=?,sealed=? WHERE operation_id=?",
      )
      .bind(cursor, Number(sealed), op.operation_id)
      .run();
    const snapshot = () => ({
      request: f.memory.sqlite
        .prepare(
          "SELECT request_json,epoch,transition_id FROM learning_authority_operations WHERE operation_id=?",
        )
        .get(op.operation_id),
      operation: f.memory.sqlite
        .prepare(
          "SELECT cursor,sealed,complete,dirty_version,original_revision,member_revision FROM learning_authority_operations WHERE operation_id=?",
        )
        .get(op.operation_id),
      head: f.memory.sqlite
        .prepare(
          "SELECT revision,pending_operation FROM learning_authority_heads WHERE account_id='a'",
        )
        .get(),
      members: f.memory.sqlite
        .prepare(
          "SELECT * FROM learning_authority_members WHERE operation_id=? ORDER BY authorization_id",
        )
        .all(op.operation_id),
      children: journal.store.entries(
        "publication-child:" + transitionId + ":",
      ),
      remote: journal.store.get<Record<string, unknown>>(
        "publication-transition:" + transitionId,
      ),
    });
    return {
      ...f,
      journal,
      model,
      publication,
      recreate,
      ports,
      op,
      ids,
      transitionId,
      action,
      snapshot,
      advance: () => {
        clock += 65000;
      },
      resume: () => progressAuthorityAction(f.db, op.operation_id, ports),
      closeAll: () => {
        f.close();
        journal.close();
      },
    };
  } catch (error) {
    f.close();
    journal.close();
    throw error;
  }
}
