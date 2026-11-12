// Repair2 prepared HTTP regressions, UNRUN. Actual session SQL, account reader
// and public routes; broker/provider methods are forbidden fixture ports.
import test from "node:test";
import assert from "node:assert/strict";
import { hashText } from "../packages/community/common.ts";
import { TelegramError } from "../packages/telegram/contracts.ts";
import { CommunityAuthorityPending } from "../packages/community-setup/authority-ledger.ts";
import {
  telegramAccountPort,
  telegramWebAccountPorts,
} from "../services/telegram-accounts.ts";
import { telegramCommunityRoutes } from "../services/telegram-http.ts";
import { TelegramGrants } from "../services/telegram-grants.ts";
import { TelegramLinking } from "../services/telegram-linking.ts";
import { journalFixture } from "./telegram-fixture.ts";
import { managedFixture } from "./telegram-managed-fixture.ts";
import { withdrawalFixture } from "./learning-public-results-memory-fixture.ts";

test(
  "public HTTP adapter preserves temporary authority503 with a real session and keeps invalid sessions/accounts closed",
  { timeout: 10000 },
  async () => {
    const f = await withdrawalFixture(),
      journal = journalFixture();
    const origin = f.ports.config.app.origin,
      scope = { communityId: f.owner.communityId, botId: "123", generation: 1 };
    const token = "a".repeat(64),
      state = { revision: "1", permissionRevision: "1", pending: false };
    let pause = false,
      disabled = false,
      rawPending = false,
      calls = 0;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      await f.db
        .prepare(
          "INSERT INTO community_sessions VALUES(?,?,?,'a','binding','csrf',?)",
        )
        .bind(hashText(token), scope.communityId, origin, f.now + 10000)
        .run();
      const accounts = telegramAccountPort({
        db: f.db,
        authorityState: async () => {
          calls++;
          if (rawPending) throw new CommunityAuthorityPending();
          return { ...state };
        },
        assertAccountEnabled: async () => {
          if (disabled)
            throw new TelegramError("telegram_account_mismatch", 403);
          if (pause) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      const grants = new TelegramGrants(journal.store, accounts, () => f.now);
      const linking = new TelegramLinking(
        grants,
        {
          request: async () => {
            throw Error("forbidden broker request");
          },
          redeem: async () => {
            throw Error("forbidden broker redeem");
          },
        },
        "fixture-client",
        origin + "/api/telegram/connect/return",
      );
      const managed = managedFixture(
        grants,
        { ...scope, enabled: true },
        { communityId: scope.communityId as `0x${string}` },
      );
      const route = telegramCommunityRoutes(
        linking,
        telegramWebAccountPorts({
          db: f.db,
          scope,
          origin,
          accounts,
          now: () => f.now,
        }),
        managed.publication,
      );
      const get = (cookie = token) =>
        route(
          new Request(origin + "/api/telegram/connection", {
            headers: { cookie: "__Host-community_session=" + cookie },
          }),
        );
      assert.equal((await get()).status, 200);
      state.pending = true;
      let response = await get();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "telegram_publication_pending",
      });
      const count = calls;
      assert.equal((await get("bad")).status, 401);
      assert.equal(calls, count);
      state.pending = false;
      pause = true;
      const waiting = get();
      await entered.promise;
      state.pending = true;
      release.resolve();
      response = await waiting;
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "telegram_publication_pending",
      });
      pause = false;
      state.pending = false;
      rawPending = true;
      response = await get();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "telegram_publication_pending",
      });
      rawPending = false;
      disabled = true;
      assert.equal((await get()).status, 401);
      disabled = false;
      state.pending = true;
      await f.db.prepare("UPDATE community_sessions SET expires_at=0").run();
      assert.equal((await get()).status, 401);
      assert.equal(journal.store.entries("grant:").length, 0);
      assert.equal(managed.denials.size, 0);
    } finally {
      release.resolve();
      f.close();
      journal.close();
    }
  },
);
