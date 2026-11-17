import assert from "node:assert/strict";
import test from "node:test";
import { canonical } from "../packages/protocol/index.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import {
  drainPublicationOutbox,
  propagatePublicationFence,
  reconcilePublicationOriginal,
} from "../services/publication-app-outbox.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

// Credible failures: an already running alarm keeps its old selection after a
// profile replacement; a delayed receipt or stop ACK updates the journal after
// an installation changes between the final read and actual accepting SQL.
// Use real HTTP, cryptography, D1 and the actual operator nonce journal.
const bounded = { timeout: 30000 };
test(
  "an old background mount stops before transport and cannot postpone current recovery",
  bounded,
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const prepared = await f.prepare("stale-background"),
        command = parseCommand(prepared.value.command);
      assert.equal(
        (
          await f.submit({
            commandId: command.commandId,
            signature: await f.sign(command),
          })
        ).status,
        200,
      );
      const oldPorts = f.ports;
      await f.setCatalog(null);
      f.advance(1n);
      const before = canonical(await f.rows()),
        calls = f.operatorCalls.length;
      await assert.rejects(
        drainPublicationOutbox(oldPorts, {
          maxCommands: 20,
          maxDurationMs: 10000,
        }),
        /publication_installation_changed/,
      );
      assert.equal(f.operatorCalls.length, calls);
      assert.equal(canonical(await f.rows()), before);
      const current = await f.drain();
      assert.equal(current.failed, 0);
      assert.equal(current.processed, 1);
      assert.equal(f.operatorCalls.at(-1)!.path, "/publication/v1/reconcile");
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
    } finally {
      await f.artifact("installed-outbox-stale-mount");
    }
  },
);

test(
  "a receipt racing actual observation SQL remains recoverable by the current disabled mount",
  bounded,
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const prepared = await f.prepare("stale-observation"),
        command = parseCommand(prepared.value.command);
      assert.equal(
        (
          await f.submit({
            commandId: command.commandId,
            signature: await f.sign(command),
          })
        ).status,
        200,
      );
      const original = await f.historicalRecordedOriginal(command),
        row = (await f.rows())[0],
        before = canonical(row),
        gate = f.holdMutation(
          "INSERT OR IGNORE INTO publication_v1_observations",
        ),
        pending = reconcilePublicationOriginal(f.ports, row);
      try {
        await gate.entered;
        await f.setCatalog(null);
      } finally {
        gate.release();
      }
      await assert.rejects(pending, /publication_installation_changed/);
      assert.equal(canonical((await f.rows())[0]), before);
      const proofCount = await f.db
        .prepare("SELECT COUNT(*) AS n FROM publication_v1_observations")
        .first("n");
      assert.equal(proofCount, 1);
      const current = await reconcilePublicationOriginal(
        f.ports,
        (await f.rows())[0],
      );
      assert.equal(current.result_state, "recorded");
      assert.notEqual(current.observation_hash, row.observation_hash);
      assert.equal(
        f.store().get<{ raw: string }>("tx:0000000000")!.raw,
        original.raw,
      );
      assert.equal(f.store().get("op:nonce"), 1);
    } finally {
      await f.artifact("installed-outbox-observation-sql");
    }
  },
);

test(
  "a stop acknowledgement racing actual ACK SQL cannot mutate an obsolete mount",
  bounded,
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const prepared = await f.prepare("stale-fence-ack"),
        command = parseCommand(prepared.value.command);
      f.loseOperatorResponse("/publication/v1/fence");
      assert.equal(
        (
          await f.stop({
            purpose: command.message.purpose,
            requestId: "original-stop",
            sourceCommandId: command.commandId,
          })
        ).status,
        503,
      );
      const row = (await f.rows()).find((r) => r.action === "withdraw")!,
        before = canonical(row),
        gate = f.holdMutation("SET fence_ack_json"),
        pending = propagatePublicationFence(f.ports, row);
      try {
        await gate.entered;
        await f.setCatalog(null);
      } finally {
        gate.release();
      }
      await assert.rejects(pending, /publication_installation_changed/);
      assert.equal(
        canonical(
          (await f.rows()).find((r) => r.command_id === row.command_id),
        ),
        before,
      );
      const current = await propagatePublicationFence(f.ports, row);
      assert.ok(current.fence_ack_json);
      assert.equal(current.fence_generation, 1);
      assert.equal(current.nonce_hex, row.nonce_hex);
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal(f.store().get("op:nonce"), undefined);
    } finally {
      await f.artifact("installed-outbox-fence-sql");
    }
  },
);
