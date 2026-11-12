import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramConnectedMount } from "../services/telegram-connected-mount.ts";
import { factoryAuthorityFixture } from "./telegram-factory-authority-fixture.ts";

// UNRUN. Requires the exact coordinator mount proposal in addition to 7ea and
// the protected constructor/adapters. Executes actual shared scheduled recovery
// and native tick; no mocked authority/ready or private Study replacement.
test(
  "shared D1 dirty/outbox and native recovery both run through an ordinary projection failure",
  { timeout: 90000 },
  async () => {
    const fixture = await factoryAuthorityFixture(20349),
      { f } = fixture;
    try {
      f.guardUnavailable(true);
      await assert.rejects(fixture.progress());
      const original = await fixture.read();
      assert.ok(original?.transition_id);
      const configuration = f.shared.ports.configuration;
      let projectionUnavailable = true;
      const mount = () =>
        telegramConnectedMount({
          env: f.shared.env,
          selectedOrigin: f.options.origin,
          telegram: f.factory,
          dependencies: {
            ...f.shared.ports,
            configuration: async () => {
              if (projectionUnavailable)
                throw Error("fixture_projection_unavailable");
              return configuration();
            },
            linkedAuthority: {
              ports: fixture.ports(),
              async action() {
                throw Error("fixture_explicit_account_action_not_requested");
              },
            },
          },
        });
      f.restart();
      f.shared.advance(65_000);
      const before = f.guardReads();
      await assert.rejects(mount().alarm(), /community_recovery_pending/);
      assert.ok(
        f.guardReads() > before,
        "ordinary projection failure must not skip independent native invalidation recovery",
      );
      assert.equal((await fixture.read())?.complete, 0);
      assert.ok(f.alarm !== null);
      assert.equal(f.shared.store.entries("studyTelegramTombstone:").length, 0);
      projectionUnavailable = false;
      f.guardUnavailable(false);
      f.restart();
      for (
        let step = 0;
        step < 12 && !(await fixture.read())?.complete;
        step++
      ) {
        f.shared.advance(65_000);
        await mount().alarm();
      }
      const done = await fixture.read();
      assert.ok(done);
      assert.equal(done.complete, 1);
      assert.equal(done.transition_id, original.transition_id);
      assert.equal(done.request_json, original.request_json);
      assert.equal(f.shared.counts().calls, 0);
    } finally {
      await f.dispose();
    }
  },
);
