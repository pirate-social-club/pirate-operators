import { test } from "node:test";
import assert from "node:assert/strict";
import { actorKey, type WebAccount } from "../packages/telegram/contracts.ts";
import type { PendingConnection } from "../packages/telegram/link-contracts.ts";
import { randomToken, sha256 } from "../packages/telegram/security.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import { TelegramSqlJournal } from "../services/telegram-store.ts";
import { account, actor, linkFixture } from "./telegram-fixture.ts";
import { barrier } from "./telegram-repair1-fixture.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";

const second: WebAccount = {
  ...account,
  accountId: "account-B",
  wallet: "0x" + "2".repeat(40),
  sessionId: "session-B",
};
const senderKey = `publication-user:${actorKey(actor)}`;
const requestA = (id: string) => ({
  operationId: "pending_account_A_unlink_001",
  expectedGrantId: id,
});

async function fixture(t: import("node:test").TestContext) {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    original = await f.complete(flow, await f.verify(flow));
  const current = f.grants.accounts.current;
  f.grants.accounts.current = async (community, id, wallet) => {
    if (
      community === second.communityId &&
      id === second.accountId &&
      wallet === second.wallet
    )
      return second;
    return current(community, id, wallet);
  };
  const managed = managedFixture(f.grants);
  await managed.publication.ready();
  return { ...f, ...managed, original };
}

test("pending sender A fences a retained reference for account B across retry and SQLite restart", async (t) => {
  const f = await fixture(t),
    reference = await f.linking.pending(actor),
    browser = randomToken();
  const referenceKey = `pending:${await sha256(reference)}`;
  f.offline(true);
  await assert.rejects(
    f.publication.unlink(actor, account.accountId, requestA(f.original.id)),
  );
  const operationA = f.store.get<string>(senderKey)!;
  const fenceA = f.grants.linkFence(actor, account.accountId),
    fenceB = f.grants.linkFence(actor, second.accountId);
  let secondReads = 0;
  const current = f.grants.accounts.current;
  f.grants.accounts.current = async (...args) => {
    if (args[1] === second.accountId) secondReads++;
    return current(...args);
  };
  await assert.rejects(
    f.linking.create(reference, second, browser),
    /publication_pending/,
  );
  assert.throws(
    () => f.grants.commit(actor, second, "forbidden_successor_grant", fenceB),
    /publication_pending/,
  );
  const grants = new TelegramGrants(
    new TelegramSqlJournal(f.storage),
    f.grants.accounts,
    f.now,
  );
  const linking = new TelegramLinking(
    grants,
    f.brokerPort,
    f.linking.clientId,
    f.linking.returnUrl,
  );
  const publication = f.create(undefined, grants);
  await assert.rejects(
    linking.create(reference, second, browser),
    /publication_pending/,
  );
  assert.equal(
    secondReads,
    0,
    "known sender pending state is checked before external account reads",
  );
  assert.equal(f.store.get<PendingConnection>(referenceKey)?.consumedBy, null);
  assert.equal(f.store.get(senderKey), operationA);
  assert.deepEqual(grants.linkFence(actor, account.accountId), fenceA);
  assert.deepEqual(grants.linkFence(actor, second.accountId), fenceB);
  assert.equal(grants.read(actor)?.id, f.original.id);
  assert.notEqual(grants.read(actor)?.revokedAt, null);
  assert.equal(grants.forAccount(actor, second.accountId), null);
  f.offline(false);
  f.advance(2000);
  await publication.recover();
  assert.deepEqual(
    await publication.unlink(actor, account.accountId, requestA(f.original.id)),
    { unlinked: true },
  );
  assert.equal(f.store.get(senderKey), undefined);
  const prospective = await linking.create(reference, second, browser);
  assert.deepEqual(prospective.fence, fenceB);
  assert.equal(
    grants.read(actor)?.id,
    f.original.id,
    "reference consumption alone grants no successor authority",
  );
  const flow = await f.begin(actor, second),
    returned = await f.verify(flow);
  const successor = await linking.complete(
    flow.transaction.id,
    returned.searchParams.get("state")!,
    returned.searchParams.get("code")!,
    second,
    flow.browser,
  );
  assert.equal(successor.accountId, second.accountId);
  assert.notEqual(successor.id, f.original.id);
  f.offline(true);
  await assert.rejects(
    publication.unlink(actor, second.accountId, {
      operationId: "successor_account_B_unlink_001",
      expectedGrantId: successor.id,
    }),
  );
  const operationB = f.store.get<string>(senderKey)!;
  assert.notEqual(operationB, operationA);
  assert.deepEqual(
    await publication.unlink(actor, account.accountId, requestA(f.original.id)),
    { unlinked: true },
  );
  assert.equal(f.store.get(senderKey), operationB);
  f.offline(false);
  f.advance(2000);
  await publication.recover();
  assert.equal(f.store.get(senderKey), undefined);
  assert.equal(f.store.entries("publication-corrupt:", 1).length, 0);
});

test("link creation rechecks sender pending state after an awaited account read", async (t) => {
  const f = await fixture(t),
    reference = await f.linking.pending(actor),
    browser = randomToken();
  const gate = barrier(),
    current = f.grants.accounts.current;
  f.grants.accounts.current = async (...args) => {
    if (args[1] === second.accountId) await gate.pause();
    return current(...args);
  };
  const creating = f.linking.create(reference, second, browser);
  await gate.waiting;
  try {
    f.offline(true);
    await assert.rejects(
      f.publication.unlink(actor, account.accountId, requestA(f.original.id)),
    );
  } finally {
    gate.release();
  }
  await assert.rejects(creating, /publication_pending/);
  assert.equal(
    f.store.get<PendingConnection>(`pending:${await sha256(reference)}`)
      ?.consumedBy,
    null,
  );
  assert.equal(
    f.store.entries("link:").length,
    1,
    "only the original completed link exists",
  );
  assert.equal(f.grants.forAccount(actor, second.accountId), null);
});

test("sender invalidation during redeem preserves the original transaction through retry and restart", async (t) => {
  const f = await fixture(t),
    flow = await f.begin(actor, second),
    returned = await f.verify(flow);
  const gate = barrier(),
    redeem = f.brokerPort.redeem;
  f.brokerPort.redeem = async (input) => {
    const result = await redeem(input);
    await gate.pause();
    return result;
  };
  const completing = f.linking.complete(
    flow.transaction.id,
    returned.searchParams.get("state")!,
    returned.searchParams.get("code")!,
    second,
    flow.browser,
  );
  await gate.waiting;
  try {
    f.offline(true);
    await assert.rejects(
      f.publication.unlink(actor, account.accountId, requestA(f.original.id)),
    );
  } finally {
    gate.release();
  }
  await assert.rejects(completing, /publication_pending/);
  const originalTransaction = f.store.get(`link:${flow.transaction.id}`);
  const grants = new TelegramGrants(
    new TelegramSqlJournal(f.storage),
    f.grants.accounts,
    f.now,
  );
  const linking = new TelegramLinking(
    grants,
    f.brokerPort,
    f.linking.clientId,
    f.linking.returnUrl,
  );
  const args = [
    flow.transaction.id,
    returned.searchParams.get("state")!,
    returned.searchParams.get("code")!,
    second,
    flow.browser,
  ] as const;
  await assert.rejects(linking.complete(...args), /publication_pending/);
  assert.deepEqual(
    f.store.get(`link:${flow.transaction.id}`),
    originalTransaction,
  );
  assert.equal(grants.forAccount(actor, second.accountId), null);
  f.offline(false);
  f.advance(2000);
  await f.create(undefined, grants).recover();
  await assert.rejects(linking.complete(...args), /link_revoked/);
  assert.deepEqual(
    f.store.get(`link:${flow.transaction.id}`),
    originalTransaction,
  );
});

test("a different operation cannot overwrite a retained sender fence or retire its successor", async (t) => {
  const f = await fixture(t);
  f.offline(true);
  await assert.rejects(
    f.publication.unlink(actor, account.accountId, requestA(f.original.id)),
  );
  const operationA = f.store.get(senderKey),
    row = `grant:${actor.communityId}:${actor.botId}:${actor.userId}`;
  // Recreate a successor left by the reviewed bug to exercise the independent
  // overwrite guard even though the repaired commit path now refuses it.
  const successor = {
    ...f.original,
    ...second,
    id: "retained_successor_B",
    revokedAt: null,
  };
  f.store.set(row, successor);
  f.store.set(
    `account-grant:${actor.communityId}:${actor.botId}:${second.accountId}`,
    row,
  );
  const before = f.grants.linkFence(actor, second.accountId);
  await assert.rejects(
    f.publication.unlink(actor, second.accountId, {
      operationId: "forbidden_account_B_unlink_001",
      expectedGrantId: successor.id,
    }),
    /publication_pending/,
  );
  assert.equal(f.store.get(senderKey), operationA);
  assert.deepEqual(f.grants.read(actor), successor);
  assert.deepEqual(f.grants.linkFence(actor, second.accountId), before);
  assert.equal(
    f.store.get(
      `publication-account:${actor.communityId}:${actor.botId}:${second.accountId}`,
    ),
    undefined,
  );
  f.offline(false);
  f.advance(2000);
  await f.publication.recover();
  assert.deepEqual(
    await f.publication.unlink(
      actor,
      account.accountId,
      requestA(f.original.id),
    ),
    { unlinked: true },
  );
  assert.deepEqual(f.grants.read(actor), successor);
  assert.equal(f.store.get(senderKey), undefined);
  assert.equal(f.store.entries("publication-corrupt:", 1).length, 0);
});
