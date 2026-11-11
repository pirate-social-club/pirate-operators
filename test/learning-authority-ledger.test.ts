import { accounts } from "../harness/runtime.ts";
import {
  signInMessageV4,
  signInIdV4,
  type SignInV4Context,
} from "../packages/protocol/learning-results-v4.ts";
import {
  AUTHORITY_ORIGINAL_PAGE_QUERY,
  INVALID_AUTHORITY_ORIGINAL_QUERY,
  validateAuthorityOriginalAccount,
} from "../packages/community-setup/authority-originals.ts";
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
  freezeAuthorityPage,
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
import {
  noteChainWithdrawal,
  closeWithdrawnStudyLessons,
} from "../services/learning-public-results.ts";
import {
  practiceAuthorization,
  connectedPracticeAuthorization,
} from "../services/learning-sign-in.ts";
import {
  withdrawalFixture,
  MemoryD1,
  wallet,
} from "./learning-public-results-memory-fixture.ts";

async function fixture() {
  const f = await withdrawalFixture();
  const selected = signInV4(f.env, f.ports.config)!;
  const context: SignInV4Context = {
    origin: f.ports.config.app.origin,
    chainId: selected.chainId,
    contract: selected.contract,
    communityId: selected.communityId,
    publicationPolicy: selected.publicationPolicy,
  };
  const original = async (
    index: number,
    issuedAt = 100,
    overrides: Partial<SignInV4Context> = {},
    signer = accounts[5],
  ) => {
    const ctx = { ...context, ...overrides },
      args = {
        learner: signer.address,
        nonce: digest("original-" + index),
        issuedAt: BigInt(issuedAt),
      };
    const message = signInMessageV4(ctx, args),
      id = signInIdV4(ctx, args),
      signature = await signer.signMessage({ message });
    return {
      id,
      message,
      signature,
      compact: JSON.stringify({ ...args, issuedAt: String(args.issuedAt) }),
      policy: ctx.publicationPolicy,
      issuedAt,
    };
  };
  // Replace the old syntactic-only seed with the exact signed V4 original and
  // keep its Study binding consistent. Fixed existing fixture key only.
  const initial = await original(-1, f.now / 1000 - 2);
  await f.db
    .prepare(
      "UPDATE learning_authorizations SET authorization_id=?,sign_in_json=?,message=?,signature=?,policy_hash=? WHERE account_id='a'",
    )
    .bind(
      initial.id,
      initial.compact,
      initial.message,
      initial.signature,
      initial.policy,
    )
    .run();
  const publication = (await f.publication())!,
    binding = JSON.parse(publication.binding_json);
  binding.authorization.id = initial.id;
  binding.offer.authorizationId = initial.id;
  binding.offerHash = digest(binding.offer);
  await f.db
    .prepare(
      "UPDATE study_publications SET binding_json=? WHERE account_id='a'",
    )
    .bind(JSON.stringify(binding))
    .run();
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
    const row = await original(index, issuedAt);
    await f.db
      .prepare(
        `INSERT INTO learning_authorizations(authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
      VALUES(?,'a',?,?,?,?,?,4,?,'recorded',0,0)`,
      )
      .bind(
        row.id,
        wallet,
        row.compact,
        row.message,
        row.signature,
        row.policy,
        row.issuedAt,
      )
      .run();
    return row.id;
  };
  return {
    ...f,
    ports,
    action,
    add,
    original,
    lost: () => {
      lost = true;
    },
    wakes: () => wakes,
  };
}
/** Recovery now includes durable bounded validation passes; no fixed call
 * count is a substitute for a completed operation. Keep a finite drain bound. */
async function drainAuthority(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
) {
  for (let step = 0; step < 30; step++) {
    const op = await progressAuthorityAction(f.db, id, { ...f.ports });
    if (op.complete) return;
  }
  assert.fail("authority recovery did not finish within bounded fixture drain");
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
    await drainAuthority(f, op.operation_id);
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
        .get((await f.original(44)).id)!.n,
      0,
    );
    await progressAuthorityAction(f.db, op.operation_id, f.ports);
    await f.add(45);
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT authority_epoch FROM learning_authorizations WHERE authorization_id=?",
        )
        .get((await f.original(45)).id)!.authority_epoch,
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
        beginAuthorityTransition: async (...args) => {
          const id = await f.ports.transitions.beginAuthorityTransition(
            ...args,
          );
          await new Promise<string>((done) => {
            resolve = done;
          });
          return id;
        },
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
        "UPDATE learning_authorizations SET subject='bad' WHERE account_id='a'",
      )
      .run();
    await assert.rejects(
      progressAuthorityAction(f.db, op.operation_id, f.ports),
      CommunityAuthorityPending,
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

test("turn-on cannot mutate settings or complete across a newer dirty-version Off", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<{
      revocationNonce: string;
      pendingWithdrawal: boolean;
    }>();
  try {
    const off = await beginAuthorityAction(f.db, f.action(), f.ports);
    await progressAuthorityAction(f.db, off.operation_id, f.ports);
    const on = await beginAuthorityAction(
      f.db,
      f.action("on", "2", "delayed-on"),
      f.ports,
    );
    const before = f.memory.sqlite
      .prepare("SELECT * FROM learning_settings WHERE account_id='a'")
      .get()!;
    const waiting = progressAuthorityAction(f.db, on.operation_id, {
      ...f.ports,
      observeTurnOn: async () => {
        entered.resolve();
        return release.promise;
      },
    });
    await entered.promise;
    await f.db
      .prepare(
        "UPDATE learning_settings SET public_results_withdrawn_at=?1,last_withdrawn_at=?1 WHERE account_id='a'",
      )
      .bind(f.now + 5000)
      .run();
    const dirty = f.memory.sqlite
      .prepare(
        "SELECT version FROM learning_authority_dirty WHERE account_id='a'",
      )
      .get()!.version;
    release.resolve({ revocationNonce: "2", pendingWithdrawal: false });
    await assert.rejects(waiting, CommunityAuthorityPending);
    const settings = f.memory.sqlite
      .prepare("SELECT * FROM learning_settings WHERE account_id='a'")
      .get()!;
    assert.equal(settings.public_results_withdrawn_at, f.now + 5000);
    assert.equal(settings.last_withdrawn_at, f.now + 5000);
    assert.equal(
      settings.acknowledged_revocation_nonce,
      before.acknowledged_revocation_nonce,
    );
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT complete FROM learning_authority_operations WHERE operation_id=?",
        )
        .get(on.operation_id)!.complete,
      0,
    );
    const head = f.memory.sqlite
      .prepare(
        "SELECT revision,pending_operation FROM learning_authority_heads WHERE account_id='a'",
      )
      .get()!;
    assert.equal(head.pending_operation, on.operation_id);
    assert.equal(head.revision, on.epoch);
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT version FROM learning_authority_dirty WHERE account_id='a'",
        )
        .get()!.version,
      dirty,
    );
  } finally {
    release.resolve({ revocationNonce: "2", pendingWithdrawal: false });
    f.close();
  }
});
for (const fault of [
  "id",
  "issued_at",
  "compact",
  "target",
  "community",
  "learner",
] as const)
  test(`retained original ${fault} mismatch cannot freeze or issue any permanent authorization denial`, async () => {
    const f = await fixture();
    try {
      await f.db.prepare("DELETE FROM learning_authorizations").run();
      const id = await f.add(1, 100);
      if (fault === "id") {
        const later = await f.original(9, 600);
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET authorization_id=? WHERE authorization_id=?",
          )
          .bind(later.id, id)
          .run();
      }
      if (fault === "issued_at")
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET issued_at=50 WHERE authorization_id=?",
          )
          .bind(id)
          .run();
      if (fault === "compact")
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET sign_in_json=json_set(sign_in_json,'$.issuedAt','50') WHERE authorization_id=?",
          )
          .bind(id)
          .run();
      if (fault === "learner")
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET subject=? WHERE authorization_id=?",
          )
          .bind(accounts[4].address.toLowerCase(), id)
          .run();
      if (fault === "target" || fault === "community") {
        const row = await f.original(
          1,
          100,
          fault === "target"
            ? { contract: accounts[4].address.toLowerCase() as `0x${string}` }
            : { communityId: digest("other-community") },
        );
        await f.db
          .prepare(
            "UPDATE learning_authorizations SET authorization_id=?,message=?,sign_in_json=?,signature=? WHERE authorization_id=?",
          )
          .bind(row.id, row.message, row.compact, row.signature, id)
          .run();
      }
      // Stage AFTER corruption so only full identity validation can catch these
      // syntactically valid originals; this is not just a revision-fence test.
      const op = await beginAuthorityAction(
        f.db,
        f.action("observed"),
        f.ports,
      );
      await assert.rejects(
        progressAuthorityAction(f.db, op.operation_id, f.ports),
        CommunityAuthorityPending,
      );
      assert.equal(
        f.memory.sqlite.prepare("SELECT count(*) n FROM denials").get()!.n,
        0,
      );
      assert.equal(
        f.memory.sqlite
          .prepare("SELECT count(*) n FROM learning_authority_members")
          .get()!.n,
        0,
      );
      assert.equal(
        f.memory.sqlite
          .prepare("SELECT count(*) n FROM learning_authority_pages")
          .get()!.n,
        0,
      );
      assert.equal((await readAuthorityState(f.db, "a")).pending, true);
    } finally {
      f.close();
    }
  });
test("invalid guard and 50-row keyset pages use their actual SQL indexes through restart", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("DELETE FROM learning_authorizations").run();
    for (let i = 0; i < 123; i++) await f.add(i, 100);
    const op = await beginAuthorityAction(f.db, f.action("observed"), f.ports);
    const invalid = f.memory.sqlite
      .prepare("EXPLAIN QUERY PLAN " + INVALID_AUTHORITY_ORIGINAL_QUERY)
      .all("a");
    assert.ok(
      invalid.some(
        (row) =>
          String(row.detail).includes("SEARCH learning_authorizations ") &&
          String(row.detail).includes(
            "learning_authorizations_invalid_original",
          ),
      ),
      JSON.stringify(invalid),
    );
    const selection = f.memory.sqlite
      .prepare("EXPLAIN QUERY PLAN " + AUTHORITY_ORIGINAL_PAGE_QUERY)
      .all("a", op.epoch, "");
    assert.ok(
      selection.some((row) =>
        String(row.detail).includes("learning_authorizations_discovery"),
      ),
      JSON.stringify(selection),
    );
    assert.ok(
      !selection.some((row) => String(row.detail).includes("TEMP B-TREE")),
      JSON.stringify(selection),
    );
    await progressAuthorityAction(f.db, op.operation_id, f.ports);
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_members")
        .get()!.n,
      50,
    );
    // Recreate services over the same native SQLite state, not a Map snapshot.
    await progressAuthorityAction(f.db, op.operation_id, { ...f.ports });
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_members")
        .get()!.n,
      100,
    );
    await drainAuthority(f, op.operation_id);
    assert.equal(
      f.memory.sqlite.prepare("SELECT count(*) n FROM denials").get()!.n,
      123,
    );
    assert.equal((await readAuthorityState(f.db, "a")).pending, false);
  } finally {
    f.close();
  }
});
for (const syntax of [true, false])
  test(`late original mutation behind the frozen cursor holds after restart (syntax=${syntax})`, async () => {
    const f = await fixture();
    try {
      await f.db.prepare("DELETE FROM learning_authorizations").run();
      for (let i = 0; i < 75; i++) await f.add(i, 100);
      const op = await beginAuthorityAction(
        f.db,
        f.action("observed"),
        f.ports,
      );
      await progressAuthorityAction(f.db, op.operation_id, f.ports);
      const seen = f.memory.sqlite
        .prepare(
          "SELECT authorization_id FROM learning_authority_members WHERE operation_id=? ORDER BY authorization_id LIMIT 1",
        )
        .get(op.operation_id)!.authorization_id as string;
      const cursor = f.memory.sqlite
        .prepare(
          "SELECT cursor FROM learning_authority_operations WHERE operation_id=?",
        )
        .get(op.operation_id)!.cursor;
      await f.db
        .prepare(
          syntax
            ? "UPDATE learning_authorizations SET subject='bad' WHERE authorization_id=?"
            : "UPDATE learning_authorizations SET issued_at=issued_at+1 WHERE authorization_id=?",
        )
        .bind(seen)
        .run();
      await assert.rejects(
        progressAuthorityAction(f.db, op.operation_id, { ...f.ports }),
        CommunityAuthorityPending,
      );
      assert.equal(
        f.memory.sqlite
          .prepare(
            "SELECT cursor FROM learning_authority_operations WHERE operation_id=?",
          )
          .get(op.operation_id)!.cursor,
        cursor,
      );
      assert.equal(
        f.memory.sqlite.prepare("SELECT count(*) n FROM denials").get()!.n,
        50,
      );
      assert.equal(
        f.memory.sqlite
          .prepare(
            "SELECT complete FROM learning_authority_operations WHERE operation_id=?",
          )
          .get(op.operation_id)!.complete,
        0,
      );
    } finally {
      f.close();
    }
  });

// Repair2 cases: prepared, UNRUN by this source actor.
for (const olderSeconds of [0, 10])
  test(
    `fresh observed nonce fences delayed On when timestamp advance=${-olderSeconds}`,
    { timeout: 10000 },
    async () => {
      const f = await fixture(),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<{
          revocationNonce: string;
          pendingWithdrawal: boolean;
        }>();
      try {
        await f.db.prepare("DELETE FROM learning_authorizations").run();
        await f.add(1, 100);
        const off = await beginAuthorityAction(f.db, f.action(), f.ports);
        await progressAuthorityAction(f.db, off.operation_id, f.ports);
        const on = await beginAuthorityAction(
          f.db,
          f.action("on", "2", "nonce-race-on"),
          f.ports,
        );
        const settings = () =>
          f.memory.sqlite
            .prepare("SELECT * FROM learning_settings WHERE account_id='a'")
            .get()!;
        const before = settings();
        const version = () =>
          Number(
            f.memory.sqlite
              .prepare(
                "SELECT version FROM learning_authority_dirty WHERE account_id='a'",
              )
              .get()!.version,
          );
        const captured = version();
        const waiting = progressAuthorityAction(f.db, on.operation_id, {
          ...f.ports,
          observeTurnOn: async () => {
            entered.resolve();
            return release.promise;
          },
        });
        await entered.promise;
        const observation = {
          since: 0,
          revokedAt: f.now / 1000 - olderSeconds,
          revocationNonce: "2",
          pendingWithdrawal: false,
        };
        await noteChainWithdrawal(
          {},
          f.db,
          { account_id: "a", wallet },
          undefined,
          observation,
          f.now,
        );
        assert.deepEqual(settings(), before); // No timestamp moved, but a new identity DID.
        assert.equal(version(), captured + 1);
        const accepted = f.memory.sqlite
          .prepare(
            "SELECT * FROM learning_authority_withdrawals WHERE account_id='a' AND kind='observed' AND nonce='2'",
          )
          .get()!;
        assert.equal(accepted.cutoff_ms, observation.revokedAt * 1000);
        await noteChainWithdrawal(
          {},
          f.db,
          { account_id: "a", wallet },
          undefined,
          observation,
          f.now,
        );
        assert.equal(version(), captured + 1); // Exact signal retry is idempotent.
        release.resolve({ revocationNonce: "2", pendingWithdrawal: false });
        await assert.rejects(waiting, CommunityAuthorityPending);
        assert.deepEqual(settings(), before);
        const retained = f.memory.sqlite
          .prepare(
            "SELECT complete,request_json FROM learning_authority_operations WHERE operation_id=?",
          )
          .get(on.operation_id)!;
        assert.equal(retained.complete, 0);
        assert.equal(
          JSON.parse(String(retained.request_json)).revocationNonce,
          "1",
        );
        assert.equal(
          f.memory.sqlite
            .prepare(
              "SELECT pending_operation FROM learning_authority_heads WHERE account_id='a'",
            )
            .get()!.pending_operation,
          on.operation_id,
        );
        assert.equal((await readAuthorityState(f.db, "a")).pending, true);
      } finally {
        release.resolve({ revocationNonce: "2", pendingWithdrawal: false });
        f.close();
      }
    },
  );
for (const binding of ["other-account", "missing"])
  test(`fully consistent signed other-wallet original with ${binding} binding cannot select or acknowledge a permanent denial`, async () => {
    const f = await fixture();
    try {
      await f.db.prepare("DELETE FROM learning_authorizations").run();
      const id = await f.add(1);
      const other = await f.original(9, 100, {}, accounts[4]);
      if (binding === "other-account")
        await f.db
          .prepare(
            "INSERT INTO credential_bindings VALUES('other-binding','b','moss',6343,?,0)",
          )
          .bind(accounts[4].address.toLowerCase())
          .run();
      await f.db
        .prepare(
          "UPDATE learning_authorizations SET authorization_id=?,subject=?,message=?,sign_in_json=?,signature=? WHERE authorization_id=?",
        )
        .bind(
          other.id,
          accounts[4].address.toLowerCase(),
          other.message,
          other.compact,
          other.signature,
          id,
        )
        .run();
      const op = await beginAuthorityAction(
        f.db,
        f.action("observed"),
        f.ports,
      );
      await assert.rejects(
        progressAuthorityAction(f.db, op.operation_id, f.ports),
        CommunityAuthorityPending,
      );
      for (const table of [
        "denials",
        "learning_authority_members",
        "learning_authority_pages",
      ])
        assert.equal(
          f.memory.sqlite.prepare("SELECT count(*) n FROM " + table).get()!.n,
          0,
        );
      assert.equal((await readAuthorityState(f.db, "a")).pending, true);
    } finally {
      f.close();
    }
  });

test("ambiguous imported credential bindings fail the bounded account lookup instead of selecting either owner", async () => {
  const memory = new MemoryD1();
  try {
    // Corrupt/imported-row fixture: no product uniqueness/check guard is changed.
    // The current canonical schema prevents duplicate subjects; this verifies
    // the required reader also rejects a legacy table containing both owners.
    memory.sqlite
      .exec(`CREATE TABLE credential_bindings(account_id TEXT,namespace TEXT,network INTEGER,subject TEXT);
   CREATE INDEX learning_authority_credential_subject ON credential_bindings(namespace,network,subject COLLATE NOCASE);`);
    memory.sqlite
      .prepare(
        "INSERT INTO credential_bindings VALUES('a','moss',6343,?),('b','moss',6343,?)",
      )
      .run(wallet, wallet);
    await assert.rejects(
      validateAuthorityOriginalAccount(memory.db, {
        account_id: "a",
        subject: wallet,
      }),
      /authority_original_account_mismatch/,
    );
  } finally {
    memory.close();
  }
});

test("a cached original page rechecks a missing account binding before retrying any permanent denial", async () => {
  const f = await fixture();
  try {
    await f.db.prepare("DELETE FROM learning_authorizations").run();
    await f.add(1, 100);
    const op = await beginAuthorityAction(f.db, f.action("observed"), f.ports);
    await freezeAuthorityPage(f.db, op);
    await f.db
      .prepare("DELETE FROM credential_bindings WHERE account_id='a'")
      .run();
    await assert.rejects(
      progressAuthorityAction(f.db, op.operation_id, f.ports),
      CommunityAuthorityPending,
    );
    assert.equal(
      f.memory.sqlite.prepare("SELECT count(*) n FROM denials").get()!.n,
      0,
    );
    assert.equal(
      f.memory.sqlite
        .prepare(
          "SELECT count(*) n FROM learning_authority_members WHERE acknowledgment IS NOT NULL",
        )
        .get()!.n,
      0,
    );
    assert.equal((await readAuthorityState(f.db, "a")).pending, true);
  } finally {
    f.close();
  }
});

test("accepted-identity journal failure rolls back settings and dirty version in the same actual SQL batch", async () => {
  const f = await fixture();
  try {
    const settings = () =>
      f.memory.sqlite
        .prepare("SELECT * FROM learning_settings WHERE account_id='a'")
        .get();
    const before = settings();
    f.memory.sqlite.exec(
      "CREATE TRIGGER injected_identity_failure BEFORE INSERT ON learning_authority_withdrawals BEGIN SELECT RAISE(ABORT,'injected_identity_failure'); END;",
    );
    await assert.rejects(
      noteChainWithdrawal(
        {},
        f.db,
        { account_id: "a", wallet },
        undefined,
        {
          since: 0,
          revokedAt: f.now / 1000,
          revocationNonce: "2",
          pendingWithdrawal: false,
        },
        f.now,
      ),
      /injected_identity_failure/,
    );
    assert.deepEqual(settings(), before);
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_dirty")
        .get()!.n,
      0,
    );
    assert.equal(
      f.memory.sqlite
        .prepare("SELECT count(*) n FROM learning_authority_withdrawals")
        .get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});
