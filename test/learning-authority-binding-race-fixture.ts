// Repair4 PREPARED/UNRUN. Empty sealed membership with a captured grant, real
// DB validator/managed bridge/signing and explicit mocked operator receipts.
// Reuses fixed fixture accounts and the existing verified-actor test boundary;
// no new key, provider, schema or runtime selection is created.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { digest } from "../packages/protocol/index.ts";
import { signInV4 } from "../services/learning-sign-in.ts";
import { closeWithdrawnStudyLessons } from "../services/learning-public-results.ts";
import { telegramAccountPort } from "../services/telegram-accounts.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramManagedPublication } from "../services/telegram-managed-publication.ts";
import { authorityDenialTransition } from "../packages/community-setup/authority-denials.ts";
import { denyManagedStudyPublication } from "../services/study-operator-client.ts";
import {
  beginAuthorityAction,
  readAuthorityState,
  type AuthorityAction,
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

export async function bindingRaceFixture() {
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
    f.memory.sqlite.exec(
      await readFile(
        new URL(
          "../apps/community-wizard/infra/migrations/0018_learning_authority.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const accounts = telegramAccountPort({
      db: f.db,
      assertAccountEnabled: async () => undefined,
      authorityState: (id) => readAuthorityState(f.db, id),
    });
    const grants = new TelegramGrants(journal.store, accounts, () => clock);
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
    const actor = { ...scope, userId: "456", chatId: "456" };
    grants.start(actor);
    const identity = await accounts.current(scope.communityId, "a", wallet);
    const grant = grants.commit(
      actor,
      identity,
      "binding_race_captured_grant_001",
      grants.linkFence(actor, identity.accountId),
    );
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
        deny: async (denial, beforeSend) => {
          const receipt = await denyManagedStudyPublication(
            model.ports,
            denial,
            beforeSend,
          );
          return { ...receipt, recorded: true as const };
        },
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
      accountId: identity.accountId,
      wallet: identity.wallet,
      actionId: "retained-empty-member-off",
      expectedRevision: "0",
      expectedGrantId: grant.id,
      kind: "off",
      atMs: f.now,
      cutoffS: 110,
      revocationNonce: "1",
      originalRevocationId: digest("retained-original-proof"),
    };
    const op = await beginAuthorityAction(f.db, action, ports);
    const transitionId = await publication.beginAuthorityTransition(
      scope,
      action.accountId,
      { operationId: op.operation_id, expectedGrantId: grant.id },
    );
    const page = {
      cursor: null,
      next: null,
      authorizationIds: [],
      exhausted: true,
    };
    publication.appendAuthorizations(transitionId, page);
    await f.db.batch([
      f.db
        .prepare("INSERT INTO learning_authority_pages VALUES(?,?,?,1)")
        .bind(op.operation_id, digest(null), JSON.stringify(page)),
      f.db
        .prepare(
          "UPDATE learning_authority_operations SET transition_id=?,sealed=1,cursor=NULL WHERE operation_id=?",
        )
        .bind(transitionId, op.operation_id),
    ]);
    const snapshot = () => ({
      request: f.memory.sqlite
        .prepare(
          "SELECT request_json,epoch,transition_id,cursor,sealed,complete FROM learning_authority_operations WHERE operation_id=?",
        )
        .get(op.operation_id),
      head: f.memory.sqlite
        .prepare(
          "SELECT revision,pending_operation FROM learning_authority_heads WHERE account_id=?",
        )
        .get(action.accountId),
      members: f.memory.sqlite
        .prepare(
          "SELECT * FROM learning_authority_members WHERE operation_id=?",
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
      grants,
      grant,
      model,
      publication,
      recreate,
      ports,
      action,
      op,
      transitionId,
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

type Fixture = Pick<
  Awaited<ReturnType<typeof bindingRaceFixture>>,
  | "db"
  | "memory"
  | "action"
  | "op"
  | "journal"
  | "model"
  | "snapshot"
  | "advance"
  | "resume"
>;
export const walletRead = (kind: string, sql: string) =>
  kind === "all" &&
  sql.includes("SELECT account_id FROM credential_bindings") &&
  sql.includes("learning_authority_credential_subject");
export const revision = (f: Fixture) =>
  Number(
    f.memory.sqlite
      .prepare(
        "SELECT COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=?),0) AS revision",
      )
      .get(f.action.accountId)!.revision,
  );
export const validation = (f: Fixture) =>
  f.memory.sqlite
    .prepare("SELECT * FROM learning_authority_validation WHERE operation_id=?")
    .get(f.op.operation_id);
export async function reassign(f: Fixture, back = false) {
  await f.db
    .prepare(
      "UPDATE credential_bindings SET account_id='b' WHERE binding_id='binding'",
    )
    .run();
  if (back)
    await f.db
      .prepare(
        "UPDATE credential_bindings SET account_id='a' WHERE binding_id='binding'",
      )
      .run();
}
export function noFetchOrAck(
  f: Fixture,
  before: ReturnType<Fixture["snapshot"]>,
) {
  const after = f.snapshot();
  assert.deepEqual(after.request, before.request);
  assert.deepEqual(after.head, before.head);
  assert.deepEqual(after.members, before.members);
  assert.deepEqual(after.children, before.children);
  assert.equal(after.remote!.acknowledged, before.remote!.acknowledged);
  assert.equal(after.remote!.complete, false);
  assert.equal(f.model.requests.length, 0);
  assert.equal(f.model.denials.size, 0);
}
export async function drain(f: Fixture) {
  for (let step = 0; step < 20; step++) {
    f.advance();
    try {
      if ((await f.resume()).complete) return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("status" in error) ||
        error.status !== 503
      )
        throw error;
    }
  }
  assert.fail("stable recovery did not finish within bounded drain");
}
export async function seedPolicy1(f: Fixture, complete = 1, cursor = "") {
  await f.db
    .prepare(
      `INSERT INTO learning_authority_validation(operation_id,policy,original_revision,credential_revision,member_revision,generation,cursor,complete)
 SELECT operation_id,1,original_revision,COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=?2),0),member_revision,7,?3,?4
 FROM learning_authority_operations WHERE operation_id=?1`,
    )
    .bind(f.op.operation_id, f.action.accountId, cursor, complete)
    .run();
}
