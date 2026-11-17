import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../packages/protocol/index.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

// Failure cases were captured before the activation implementation. These
// integrations pause the actual accepting D1 UPDATE and let a competing real
// mutation win; no mock supplies the permission or compare-and-swap result.
for (const race of [
  "withdrawal",
  "session",
  "version",
  "identity",
  "lease",
] as const) {
  test(
    `recorded grant cannot open through an accepting SQL ${race} race`,
    { timeout: 30000 },
    async (t) => {
      const f = await publicationAppFixture(t);
      try {
        const prepared = await f.prepare();
        assert.equal(prepared.status, 200);
        const command = parseCommand(prepared.value.command);
        assert.equal(
          (
            await f.submit({
              commandId: command.commandId,
              signature: await f.sign(command),
            })
          ).status,
          200,
        );
        const original = await f.historicalRecordedOriginal(command);
        if (race === "lease") f.ports.clock.maxSafeBlockAgeSeconds = 1n;
        const gate = f.holdMutation(
          "UPDATE publication_v1_heads AS h SET stopped=0",
        );
        const pending = f.call("commands/" + command.commandId);
        try {
          await gate.entered;
          if (race === "withdrawal") {
            assert.equal(
              (
                await f.stop({
                  purpose: "study-results",
                  requestId: "sql-race-stop",
                  sourceCommandId: command.commandId,
                })
              ).status,
              200,
            );
          } else if (race === "session") await f.revokeSession();
          else if (race === "version")
            await f.db
              .prepare(
                "UPDATE publication_v1_commands SET due_ms=due_ms+1,version=version+1 WHERE command_id=?",
              )
              .bind(command.commandId)
              .run();
          else if (race === "identity")
            await f.db
              .prepare(
                "UPDATE application_identity SET community_origin='https://changed.invalid' WHERE id=1",
              )
              .run();
          else {
            // Keep the service clock unchanged. The real database clock must
            // reject the expired observation lease in the accepting statement.
            const expiresMs = Number(
              (f.authority.state.safe.timestamp + 2n) * 1000n,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, expiresMs - Date.now() + 50)),
            );
            const now = await f.db
              .prepare(
                "SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AS now_ms",
              )
              .first<{ now_ms: number }>();
            assert.ok(now && now.now_ms >= expiresMs);
          }
        } finally {
          gate.release();
        }
        const response = await pending;
        if (race === "session") assert.equal(response.status, 401);
        else {
          assert.equal(response.status, 200, JSON.stringify(response.value));
          assert.equal(
            (response.value.receipt as { state: string }).state,
            "recorded",
          );
          assert.equal(
            (response.value.receipt as { transactionHash: string })
              .transactionHash,
            original.hash,
          );
          assert.notEqual(
            (response.value.currentGrant as { state: string }).state,
            "allowed",
          );
        }
        const head = await f.db
          .prepare(
            "SELECT generation,stopped FROM publication_v1_heads WHERE purpose='study-results'",
          )
          .first<{ generation: number; stopped: number }>();
        assert.deepEqual(head, {
          generation: race === "withdrawal" ? 1 : 0,
          stopped: 1,
        });
        assert.equal(f.store().get("op:nonce"), 1);
        assert.equal(f.store().entries("tx:").length, 1);
        assert.equal(f.store().entries("intent:").length, 1);
      } finally {
        await f.artifact("activation-sql-" + race);
      }
    },
  );
}

test(
  "an orphaned original receipt cannot activate after exact grant replay on another branch",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const command = parseCommand(prepared.value.command);
      assert.equal(
        (
          await f.submit({
            commandId: command.commandId,
            signature: await f.sign(command),
          })
        ).status,
        200,
      );
      const original = await f.historicalRecordedOriginal(command);
      const gate = f.holdOperatorResult("/publication/v1/reconcile");
      const pending = f.call("state?purpose=study-results");
      try {
        // The actual operator has verified A and produced its signed-transport
        // reply. Before the app observes current policy, replace A with B while
        // keeping exact grant bytes and recordedAt in the explicit RPC fixture.
        await gate.entered;
        const state = f.authority.state;
        state.blocks.set(
          999n,
          f.authority.block(
            999n,
            digest("reorg-receipt-B"),
            state.recordedAt,
            [],
          ),
        );
        state.safe = { ...state.safe, hash: digest("reorg-safe-B") };
      } finally {
        gate.release();
      }
      const response = await pending;
      assert.equal(response.status, 200, JSON.stringify(response.value));
      assert.notEqual(response.value.state, "allowed");
      assert.deepEqual(
        await f.db
          .prepare(
            "SELECT generation,stopped FROM publication_v1_heads WHERE purpose='study-results'",
          )
          .first(),
        { generation: 0, stopped: 1 },
      );
      const row = (await f.rows())[0];
      assert.equal(
        row.result_state,
        "recorded",
        "retain the earlier authenticated historical observation separately",
      );
      assert.equal(f.store().get("op:nonce"), 1);
      assert.equal(f.store().entries("tx:").length, 1);
      assert.equal(
        f.store().get<{ raw: string }>("tx:0000000000")!.raw,
        original.raw,
      );
    } finally {
      await f.artifact("activation-reorg-original-branch");
    }
  },
);
