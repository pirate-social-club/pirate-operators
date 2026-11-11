import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actor,
  account,
  linkFixture,
  journalFixture,
} from "./telegram-fixture.ts";
import { barrier } from "./telegram-repair1-fixture.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramSqlJournal } from "../services/telegram-store.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";

for (const unlink of [false, true])
  test(`paused completion A cannot regress completed B${unlink ? " or resurrect after unlink" : ""}`, async (t) => {
    const f = await linkFixture();
    t.after(f.dispose);
    const flow = await f.begin(),
      returned = await f.verify(flow),
      paused = barrier();
    const current = f.grants.accounts.current;
    let once = true,
      redemptions = 0;
    f.grants.accounts.current = async (...args) => {
      if (once) {
        once = false;
        await paused.pause();
      }
      return current(...args);
    };
    const redeem = f.brokerPort.redeem;
    f.brokerPort.redeem = async (input) => {
      redemptions++;
      return redeem(input);
    };
    const a = f.complete(flow, returned);
    await paused.waiting;
    const b = await f.complete(flow, returned);
    if (unlink) f.grants.unlink(actor, account.accountId);
    paused.release();
    if (unlink) await assert.rejects(a, /link_revoked|connection_required/);
    else assert.equal((await a).id, b.id);
    assert.equal(
      f.store.get<any>(`link:${flow.transaction.id}`).phase,
      "complete",
    );
    assert.equal(
      redemptions,
      1,
      "stale A must not move complete back to redeeming",
    );
    const restarted = new TelegramGrants(
      new TelegramSqlJournal(f.storage),
      f.grants.accounts,
      f.now,
    );
    if (unlink) {
      assert.notEqual(restarted.read(actor)?.revokedAt, null);
      const linking = new TelegramLinking(
        restarted,
        f.brokerPort,
        f.linking.clientId,
        f.linking.returnUrl,
      );
      await assert.rejects(
        linking.complete(
          flow.transaction.id,
          returned.searchParams.get("state")!,
          returned.searchParams.get("code")!,
          account,
          flow.browser,
        ),
        /link_revoked|connection_required/,
      );
    } else assert.equal((await restarted.assert(actor)).id, b.id);
  });

test("unlink fences a pending account transaction even when no grant has been committed", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin(),
    returned = await f.verify(flow);
  assert.equal(f.grants.unlink(actor, account.accountId), false);
  await assert.rejects(f.complete(flow, returned), /link_revoked/);
  assert.equal(f.grants.read(actor), undefined);
});

test("bot replacement invalidates 1001+ grants in constant work and restoration/restart cannot revive them", async (t) => {
  const f = journalFixture();
  t.after(f.close);
  const accounts = {
    async current(_community: string, id: string) {
      return { ...account, accountId: id };
    },
  };
  const grants = new TelegramGrants(f.store, accounts, () => 1000);
  grants.configure({ ...actor, enabled: true });
  for (let i = 0; i < 1005; i++) {
    const who = {
        ...actor,
        userId: String(10000 + i),
        chatId: String(10000 + i),
      },
      identity = { ...account, accountId: `account-${i}` };
    grants.start(who);
    grants.commit(
      who,
      identity,
      `verified-fixture-${i}`,
      grants.linkFence(who, identity.accountId),
    );
  }
  const entries = f.store.entries;
  f.store.entries = () => {
    throw new Error("replacement_must_not_enumerate");
  };
  grants.configure({ ...actor, botId: "90002", generation: 2, enabled: true });
  grants.configure({ ...actor, generation: 3, enabled: true });
  f.store.entries = entries;
  const restarted = new TelegramGrants(
    new TelegramSqlJournal(f.storage),
    accounts,
    () => 1001,
  );
  for (let i = 0; i < 1005; i++) {
    const who = {
      ...actor,
      generation: 3,
      userId: String(10000 + i),
      chatId: String(10000 + i),
    };
    restarted.start(who);
    assert.notEqual(restarted.read(who)?.revokedAt, null);
    await assert.rejects(restarted.assert(who), /connection_required/);
  }
  const who = { ...actor, generation: 3, userId: "11004", chatId: "11004" };
  restarted.commit(
    who,
    { ...account, accountId: "account-1004" },
    "new-independent-proof",
    restarted.linkFence(who, "account-1004"),
  );
  assert.equal((await restarted.assert(who)).id, "new-independent-proof");
  restarted.configure({ ...actor, generation: 4, enabled: true });
  restarted.start({ ...who, generation: 4 });
  assert.equal(
    (await restarted.assert({ ...who, generation: 4 })).id,
    "new-independent-proof",
    "same-bot credential rotation preserves the new proof",
  );
});

test("an unversioned legacy journal cannot silently restore an omitted old grant", async (t) => {
  const f = journalFixture();
  t.after(f.close);
  f.store.set(`bot:${actor.communityId}`, {
    ...actor,
    generation: 3,
    enabled: true,
  });
  const grants = new TelegramGrants(
    f.store,
    {
      async current() {
        return account;
      },
    },
    () => 1000,
  );
  assert.throws(
    () => grants.configure({ ...actor, generation: 4, enabled: true }),
    /lineage_migration_required/,
  );
  assert.throws(
    () => grants.start({ ...actor, generation: 3 }),
    /lineage_migration_required/,
  );
});
