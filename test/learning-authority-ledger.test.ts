import { loginChallenge, loginVerify } from "../packages/community/accounts.ts";
import { signInV4 } from "../services/learning-sign-in.ts";
// UNRUN. Real SQL migrations/atomic batches with explicit bridge fixtures.
// This does not qualify the held Telegram actor or an actual Worker scheduler.
import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../packages/protocol/index.ts";
import { AUTHORITY_LEDGER_SCHEMA } from "../packages/community-setup/authority-schema.ts";
import { authorityDenialTransition } from "../packages/community-setup/authority-denials.ts";
import {
  beginAuthorityAction,
  captureAuthority,
  compareAuthority,
  readAuthorityState,
  CommunityAuthorityPending,
  type AuthorityAction,
  type AuthorityTransitionPort,
} from "../packages/community-setup/authority-ledger.ts";
import {
  progressAuthorityAction,
  type AuthorityRecoveryPorts,
} from "../packages/community-setup/authority-recovery.ts";
import { closeWithdrawnStudyLessons } from "../services/learning-public-results.ts";
import {
  practiceAuthorization,
  connectedPracticeAuthorization,
} from "../services/learning-sign-in.ts";
import {
  withdrawalFixture,
  wallet,
} from "./learning-public-results-memory-fixture.ts";

async function fixture() {
  const f = await withdrawalFixture();
  f.memory.sqlite.exec(AUTHORITY_LEDGER_SCHEMA);
  f.memory.sqlite.exec(
    "CREATE TABLE remote_pages(id TEXT,page TEXT,hash TEXT,PRIMARY KEY(id,page));CREATE TABLE remote_operations(id TEXT PRIMARY KEY,sealed INTEGER DEFAULT 0);CREATE TABLE denials(hash TEXT PRIMARY KEY)",
  );
  let lost = false,
    wakes = 0;
  const transitions: AuthorityTransitionPort = {
    async beginAuthorityTransition(_scope, _account, request) {
      f.memory.sqlite
        .prepare(
          "INSERT INTO remote_operations(id) VALUES(?) ON CONFLICT DO NOTHING",
        )
        .run(request.operationId);
      return request.operationId;
    },
    async appendAuthorizations(id, page) {
      const key = JSON.stringify(page.cursor),
        hash = digest(page),
        old = f.memory.sqlite
          .prepare("SELECT hash FROM remote_pages WHERE id=? AND page=?")
          .get(id, key);
      if (old) assert.equal(old.hash, hash);
      else
        f.memory.sqlite
          .prepare("INSERT INTO remote_pages VALUES(?,?,?)")
          .run(id, key, hash);
      if (page.exhausted)
        f.memory.sqlite
          .prepare("UPDATE remote_operations SET sealed=1 WHERE id=?")
          .run(id);
      if (lost) {
        lost = false;
        throw Error("lost_append_ack");
      }
    },
    async finishAuthorityTransition(id) {
      assert.equal(
        f.memory.sqlite
          .prepare("SELECT sealed FROM remote_operations WHERE id=?")
          .get(id)?.sealed,
        1,
      );
    },
  };
  const wake = async () => {
    wakes++;
  };
  const originalTarget = {
    chainId: 6343,
    version: 4,
    contract: f.ports.config.learningRecords,
  } as const;
  const selective = authorityDenialTransition({
    target: originalTarget,
    db: f.db,
    wake,
    deny: async (denial) => {
      const hash = digest(denial);
      f.memory.sqlite
        .prepare("INSERT INTO denials VALUES(?) ON CONFLICT DO NOTHING")
        .run(hash);
      return { recorded: true, denialHash: hash };
    },
  });
  const ports: AuthorityRecoveryPorts = {
    target: originalTarget,
    usingTarget: (target) => {
      assert.deepEqual(target, originalTarget);
      return ports;
    },
    transitions,
    authorizationsOnly: selective,
    wake,
    closeLocal: (account) => closeWithdrawnStudyLessons(f.db, account, f.now),
    observeTurnOn: async () => ({
      revocationNonce: "1",
      pendingWithdrawal: false,
    }),
    legacyAction: async () => null,
  };
  const action = (
    kind: AuthorityAction["kind"] = "off",
    revision = "0",
    actionId = "explicit-action",
  ): AuthorityAction => ({
    target: originalTarget,
    kind,
    actionId,
    accountId: "a",
    wallet,
    scope: { communityId: f.owner.communityId, botId: "123", generation: 1 },
    expectedRevision: revision,
    expectedGrantId: "original-grant",
    atMs: f.now,
    cutoffS: 110,
    revocationNonce: "1",
    originalRevocationId: digest("retained-terminal-revert"),
  });
  const add = async (index: number, issuedAt = 100) => {
    await f.db
      .prepare(
        `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
  VALUES(?,'a',?,'{}','','0x',?,4,?,'recorded',0,0)`,
      )
      .bind(digest("original-" + index), wallet, digest("policy"), issuedAt)
      .run();
  };
  return {
    ...f,
    ports,
    action,
    add,
    lost: () => {
      lost = true;
    },
    wakes: () => wakes,
  };
}
test("several SQL pages retain all original IDs without publication rows and exact lost-ack retry survives service recreation", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("DELETE FROM learning_authorizations").run();
    for (let i = 0; i < 123; i++) await f.add(i);
    const op = await beginAuthorityAction(f.db, f.action(), f.ports);
    f.lost();
    await assert.rejects(
      progressAuthorityAction(f.db, op.operation_id, f.ports),
      /lost_append_ack/,
    );
    assert.equal((await readAuthorityState(f.db, "a")).pending, true);
    for (let i = 0; i < 4; i++)
      await progressAuthorityAction(f.db, op.operation_id, { ...f.ports });
    assert.equal((await readAuthorityState(f.db, "a")).pending, false);
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_members")
        .get()!.n,
      123,
    );
    assert.equal(
      f.memory.sqlite.prepare("SELECT count(*) n FROM remote_pages").get()!.n,
      3,
    );
    assert.ok(f.wakes() > 0);
  } finally {
    f.close();
  }
});
test("historical withdrawal denies only affected originals, preserving later authority and current grant", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("DELETE FROM learning_authorizations").run();
    await f.add(1, 100);
    await f.add(2, 200);
    const op = await beginAuthorityAction(f.db, f.action("observed"), f.ports);
    await progressAuthorityAction(f.db, op.operation_id, f.ports);
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_members")
        .get()!.n,
      1,
    );
    assert.equal(
      f.memory.sqlite.prepare("SELECT count(*) n FROM remote_operations").get()!
        .n,
      0,
      "grant-retiring Telegram transition was not used",
    );
    assert.equal(
      f.memory.sqlite.prepare("SELECT count(*) n FROM denials").get()!.n,
      1,
    );
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT public_results_withdrawn_at n FROM learning_settings WHERE account_id='a'",
        )
        .get()?.n ?? null,
      null,
    );
    assert.equal(
      f.store.state(await f.store.row(f.owner, f.row.lesson_id)).status,
      "active",
    );
  } finally {
    f.close();
  }
});
test("authenticated repeated off/on with the same terminal reverted revoke uses a distinct epoch/action, never a new original tx", async () => {
  const f = await fixture();
  try {
    const first = await beginAuthorityAction(f.db, f.action(), f.ports);
    await progressAuthorityAction(f.db, first.operation_id, f.ports);
    const on = await beginAuthorityAction(
      f.db,
      f.action("on", "2", "turn-on"),
      f.ports,
    );
    await progressAuthorityAction(f.db, on.operation_id, f.ports);
    await f.add(2, 300);
    const second = await beginAuthorityAction(
      f.db,
      f.action("off", "4", "fresh-off"),
      f.ports,
    );
    await progressAuthorityAction(f.db, second.operation_id, f.ports);
    assert.notEqual(second.operation_id, first.operation_id);
    assert.equal(
      JSON.parse(second.request_json).originalRevocationId,
      JSON.parse(first.request_json).originalRevocationId,
    );
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT count(*) n FROM learning_authority_members WHERE operation_id=?",
        )
        .get(second.operation_id)!.n,
      2,
    );
    const before = await readAuthorityState(f.db, "a");
    await beginAuthorityAction(f.db, f.action(), f.ports);
    assert.deepEqual(
      await readAuthorityState(f.db, "a"),
      before,
      "old replay cannot restage or clear newer choice",
    );
  } finally {
    f.close();
  }
});
test("login insertion is fenced during pending epoch and accepted inserts capture the new revision", async () => {
  const f = await fixture();
  try {
    const captured = await captureAuthority(f.db, "a"),
      op = await beginAuthorityAction(f.db, f.action(), f.ports);
    await assert.rejects(
      compareAuthority(f.db, "a", captured),
      CommunityAuthorityPending,
    );
    await f.add(44);
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT count(*) n FROM learning_authorizations WHERE authorization_id=?",
        )
        .get(digest("original-44"))!.n,
      0,
    );
    await progressAuthorityAction(f.db, op.operation_id, f.ports);
    await f.add(45);
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT authority_epoch FROM learning_authorizations WHERE authorization_id=?",
        )
        .get(digest("original-45"))!.authority_epoch,
      2,
    );
  } finally {
    f.close();
  }
});
test("local closure precedes never-resolving bridge and legacy off markers immediately hold authority", async () => {
  const f = await fixture();
  let resolve!: (id: string) => void;
  try {
    await f.withdraw();
    assert.equal((await readAuthorityState(f.db, "a")).pending, true);
    const op = await beginAuthorityAction(
      f.db,
      f.action("legacy_off"),
      f.ports,
    );
    const hold = progressAuthorityAction(f.db, op.operation_id, {
      ...f.ports,
      transitions: {
        ...f.ports.transitions,
        beginAuthorityTransition: () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      },
    });
    while (!resolve) await Promise.resolve();
    assert.equal(
      f.store.state(await f.store.row(f.owner, f.row.lesson_id)).status,
      "abandoned",
    );
    assert.equal(
      (await f.attempts.get(f.owner, f.take.attemptId)).state,
      "uncertain",
    );
    resolve(op.operation_id);
    await hold;
  } finally {
    f.close();
  }
});
test("stale finish cannot clear a newer epoch after delayed bridge reconciliation", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    const op = await beginAuthorityAction(f.db, f.action(), f.ports);
    const waiting = progressAuthorityAction(f.db, op.operation_id, {
      ...f.ports,
      transitions: {
        ...f.ports.transitions,
        finishAuthorityTransition: () =>
          new Promise<void>((done) => {
            release = done;
          }),
      },
    });
    while (!release) await Promise.resolve();
    await f.db
      .prepare(
        "UPDATE learning_authority_heads SET revision=9,pending_operation='newer-operation' WHERE account_id='a'",
      )
      .run();
    release();
    await assert.rejects(waiting, CommunityAuthorityPending);
    const head = f.memory.sqlite
      .prepare(
        "SELECT revision,pending_operation FROM learning_authority_heads WHERE account_id='a'",
      )
      .get()!;
    assert.equal(head.revision, 9);
    assert.equal(head.pending_operation, "newer-operation");
  } finally {
    release?.();
    f.close();
  }
});
test("malformed original behind a retained cursor is unresolved; no discovery completion", async () => {
  const f = await fixture();
  try {
    const op = await beginAuthorityAction(f.db, f.action(), f.ports);
    // Corruption probe only; normal insert trigger is fenced during the epoch.
    await f.db
      .prepare(
        "UPDATE learning_authorizations SET authorization_id='' WHERE account_id='a'",
      )
      .run();
    await assert.rejects(
      progressAuthorityAction(f.db, op.operation_id, f.ports),
      /authority_discovery_unresolved/,
    );
    assert.equal((await readAuthorityState(f.db, "a")).pending, true);
  } finally {
    f.close();
  }
});
test("pendingWithdrawal stays retryable in connected selection; ordinary website behavior is retained", async () => {
  const f = await fixture();
  try {
    f.env.KARAOKE_OPERATOR = {
      fetch: async () =>
        Response.json({
          since: 1,
          revokedAt: 0,
          revocationNonce: "0",
          pendingWithdrawal: true,
        }),
    } as unknown as Fetcher;
    assert.deepEqual(
      await practiceAuthorization(
        f.env,
        f.db,
        "a",
        wallet,
        f.now / 1000,
        f.now,
      ),
      { id: null, pending: false },
    );
    const context = {
      communityId: f.owner.communityId,
      botId: "123",
      generation: 1,
      startedAtMs: f.now,
    };
    const resolve = async () => ({
      version: 1 as const,
      ...context,
      accountId: "a",
      wallet,
      linkedAtMs: f.now - 1000,
      revokedAtMs: null,
    });
    await assert.rejects(
      connectedPracticeAuthorization(f.env, f.db, context, resolve, f.now),
      CommunityAuthorityPending,
    );
  } finally {
    f.close();
  }
});

test("lost staging response retains exact operation/epoch; SQL page rollback retains unresolved originals", async () => {
  const f = await fixture();
  try {
    const action = f.action();
    let lost = true;
    f.memory.afterResponse = ({ kind }) => {
      if (kind === "batch" && lost) {
        lost = false;
        throw Error("lost_stage_response");
      }
    };
    await assert.rejects(
      beginAuthorityAction(f.db, action, f.ports),
      /lost_stage_response/,
    );
    f.memory.afterResponse = undefined;
    const staged = await beginAuthorityAction(f.db, action, f.ports);
    assert.equal(staged.epoch, 1);
    f.memory.sqlite.exec(
      "CREATE TRIGGER injected_member_failure BEFORE INSERT ON learning_authority_members BEGIN SELECT RAISE(ABORT,'injected_rollback');END;",
    );
    await assert.rejects(
      progressAuthorityAction(f.db, staged.operation_id, f.ports),
      /injected_rollback/,
    );
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_pages")
        .get()!.n,
      0,
    );
    assert.equal((await readAuthorityState(f.db, "a")).pending, true);
    f.memory.sqlite.exec("DROP TRIGGER injected_member_failure");
    await progressAuthorityAction(f.db, staged.operation_id, f.ports);
  } finally {
    f.close();
  }
});
test("a V4 signature verification spanning off/on cannot use an ahead-clock challenge from the old epoch", async () => {
  const f = await fixture();
  try {
    const config = await f.dependencies.configuration(),
      v4 = signInV4(f.env, config),
      context = { communityId: f.owner.communityId, origin: config.app.origin },
      time = f.now + 120000;
    const challenge = await loginChallenge(f.db, context, wallet, time, v4);
    const off = await beginAuthorityAction(f.db, f.action(), f.ports);
    await progressAuthorityAction(f.db, off.operation_id, f.ports);
    const on = await beginAuthorityAction(
      f.db,
      f.action("on", "2", "new-on"),
      f.ports,
    );
    await progressAuthorityAction(f.db, on.operation_id, f.ports);
    await loginVerify(
      f.db,
      context,
      challenge.id,
      "0x11",
      async () => true,
      time,
    );
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT count(*) n FROM learning_authorizations WHERE state='pending'",
        )
        .get()!.n,
      0,
    );
    const fresh = await loginChallenge(f.db, context, wallet, time + 1000, v4);
    await loginVerify(
      f.db,
      context,
      fresh.id,
      "0x11",
      async () => true,
      time + 1000,
    );
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT count(*) n FROM learning_authorizations WHERE state='pending'",
        )
        .get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});
test("a newer behind-cursor off marker remains pending after an older sealed action finishes", async () => {
  const f = await fixture();
  try {
    const op = await beginAuthorityAction(f.db, f.action(), f.ports);
    await f.db
      .prepare(
        "UPDATE learning_settings SET last_withdrawn_at=last_withdrawn_at+1000 WHERE account_id='a'",
      )
      .run();
    await progressAuthorityAction(f.db, op.operation_id, f.ports);
    assert.equal((await readAuthorityState(f.db, "a")).pending, true);
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_dirty")
        .get()!.n,
      1,
    );
  } finally {
    f.close();
  }
});
