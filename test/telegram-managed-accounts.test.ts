import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramAccountPort } from "../services/telegram-accounts.ts";
import { actor, account, journalFixture } from "./telegram-fixture.ts";
import { d1Sqlite } from "./telegram-linked-fixture.ts";
import { barrier } from "./telegram-repair1-fixture.ts";

test("account authority includes the persisted revision and rechecks it after delayed enablement", async (t) => {
  const f = journalFixture();
  t.after(f.close);
  f.database.exec(`CREATE TABLE community_accounts(account_id TEXT PRIMARY KEY);
    CREATE TABLE application_identity(id INTEGER PRIMARY KEY,community_id TEXT);
    CREATE TABLE learning_settings(account_id TEXT PRIMARY KEY,last_withdrawn_at INTEGER);
    CREATE TABLE credential_bindings(binding_id TEXT,account_id TEXT,namespace TEXT,network INTEGER,subject TEXT);`);
  f.database
    .prepare("INSERT INTO community_accounts VALUES(?)")
    .run(account.accountId);
  f.database
    .prepare("INSERT INTO application_identity VALUES(1,?)")
    .run(actor.communityId);
  f.database
    .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?)")
    .run("binding-one", account.accountId, account.wallet);
  const state = { revision: "revision-1", pending: false };
  let gate: ReturnType<typeof barrier> | undefined;
  const port = telegramAccountPort({
    db: d1Sqlite(f.database),
    authorityState: async () => ({ ...state }),
    assertAccountEnabled: async () => {
      await gate?.pause();
    },
  });
  const first = await port.current(
    actor.communityId,
    account.accountId,
    account.wallet,
  );
  state.revision = "revision-2";
  const second = await port.current(
    actor.communityId,
    account.accountId,
    account.wallet,
  );
  assert.notEqual(first.authorityVersion, second.authorityVersion);
  gate = barrier();
  const running = port.current(
    actor.communityId,
    account.accountId,
    account.wallet,
  );
  await gate.waiting;
  state.revision = "revision-3";
  gate.release();
  await assert.rejects(running, /authority_changed/);
  state.pending = true;
  await assert.rejects(
    port.current(actor.communityId, account.accountId, account.wallet),
    /publication_pending/,
  );
});
