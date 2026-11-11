import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, account, linkFixture } from "./telegram-fixture.ts";
import { telegramLinkRetention } from "../services/telegram-link-retention.ts";
import { TELEGRAM_LINK_MS } from "../packages/telegram/contracts.ts";

test("short-lived account/browser and OIDC state is erased independently of the durable grant", async (t) => {
  const f = await linkFixture();
  t.after(f.dispose);
  const flow = await f.begin();
  await f.complete(flow, await f.verify(flow));
  f.advance(TELEGRAM_LINK_MS + 1);
  assert.ok((await telegramLinkRetention(f.store, f.now())).erased > 0);
  assert.ok(
    (await telegramLinkRetention(f.brokerJournal.store, f.now())).erased > 0,
  );
  assert.equal(f.store.entries("link:").length, 0);
  assert.equal(f.brokerJournal.store.entries("broker:").length, 0);
  assert.equal((await f.grants.assert(actor)).accountId, account.accountId);
});
