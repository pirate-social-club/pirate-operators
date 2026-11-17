import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseCommand } from "../services/publication-command-contract.ts";
import { drainPublicationOutbox } from "../services/publication-app-outbox.ts";
import { publicationDue } from "../services/publication-app-journal.ts";
import { publicationFenceState } from "../services/publication-command-operator.ts";
import {
  publicationAppFixture,
  learner,
  other,
} from "./fixtures/publication-app.ts";

type Fixture = Awaited<ReturnType<typeof publicationAppFixture>>;
const bounded = { timeout: 30000 };
async function scenario(
  t: TestContext,
  label: string,
  work: (f: Fixture) => Promise<void>,
) {
  const f = await publicationAppFixture(t);
  try {
    await work(f);
  } finally {
    await f.artifact(label);
  }
}
test(
  "lost actual operator accept response survives SQLite restart with one exact original intent",
  bounded,
  async (t) =>
    scenario(t, "lost-accept-restart", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command),
        signature = await f.sign(c);
      f.loseOperatorResponse("/publication/v1/accept");
      const lost = await f.submit({ commandId: c.commandId, signature });
      assert.equal(lost.status, 503);
      const original = (await f.rows())[0];
      assert.equal(original.phase, "accepted");
      assert.ok(original.accepted_json);
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
      f.restartOperator();
      f.advance(1n);
      const drain = await f.drain();
      assert.equal(drain.failed, 0);
      assert.equal(drain.processed, 1);
      const recovered = (await f.rows())[0];
      assert.equal(recovered.accepted_json, original.accepted_json);
      assert.equal(recovered.signature, signature);
      assert.equal(recovered.nonce_hex, original.nonce_hex);
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
      const acceptBodies = f.operatorCalls
        .filter((c) => c.path === "/publication/v1/accept")
        .map((c) => c.bodySha256);
      assert.equal(new Set(acceptBodies).size, 1);
      assert.equal(recovered.result_state, "queued");
    }),
);

test(
  "an untyped stop retains original learner and propagates its lost acknowledgement after restart",
  bounded,
  async (t) =>
    scenario(t, "pretyped-stop-restart", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command);
      f.loseOperatorResponse("/publication/v1/fence");
      const stop = await f.stop({
        action: "withdraw",
        purpose: c.message.purpose,
        requestId: "stop-1",
        sourceCommandId: c.commandId,
      });
      assert.equal(stop.status, 503);
      const original = (await f.rows()).find((r) => r.action === "withdraw")!;
      assert.equal(original.phase, "preparing");
      assert.equal(original.typed_json, null);
      assert.equal(original.signature, null);
      assert.equal(original.fence_ack_json, null);
      assert.equal(original.fence_generation, 1);
      const capture = JSON.parse(original.request_json).capture;
      assert.equal(capture.learner, learner.address.toLowerCase());
      assert.equal(capture.bindingId, "binding");
      assert.equal(capture.sourceCommandId, c.commandId);
      f.restartOperator();
      f.advance(1n);
      const result = await f.drain();
      assert.equal(result.failed, 0);
      const row = (await f.rows()).find(
        (r) => r.command_id === original.command_id,
      )!;
      assert.equal(row.nonce_hex, original.nonce_hex);
      assert.equal(row.typed_json, null);
      assert.ok(row.fence_ack_json);
      assert.deepEqual(JSON.parse(row.fence_ack_json), {
        commandId: row.command_id,
        generation: 1,
        requestHash: row.request_hash,
      });
      const head = await f.db
        .prepare(
          "SELECT generation,stopped FROM publication_v1_heads WHERE purpose=?",
        )
        .bind(c.message.purpose)
        .first();
      assert.deepEqual(head, { generation: 1, stopped: 1 });
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal(f.authority.state.simulations.length, 0);
      assert.equal(
        new Set(
          f.operatorCalls
            .filter((c) => c.path === "/publication/v1/fence")
            .map((c) => c.bodySha256),
        ).size,
        1,
      );
    }),
);

test(
  "actual indexed due pages bound restart discovery and old acknowledgements preserve the newest fence",
  bounded,
  async (t) =>
    scenario(t, "bounded-due-and-old-fence-replay", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command);
      for (let i = 0; i < 3; i++) {
        f.loseOperatorResponse("/publication/v1/fence");
        assert.equal(
          (
            await f.stop({
              action: "withdraw",
              purpose: c.message.purpose,
              requestId: "stop-" + i,
              sourceCommandId: c.commandId,
            })
          ).status,
          503,
        );
      }
      const first = await publicationDue(
        f.ports.db,
        Number(f.now() * 1000n),
        1,
        null,
      );
      assert.equal(first.rows.length, 1);
      assert.ok(first.next);
      const second = await publicationDue(
        f.ports.db,
        Number(f.now() * 1000n),
        1,
        first.next,
      );
      assert.equal(second.rows.length, 1);
      assert.notEqual(first.rows[0].command_id, second.rows[0].command_id);
      f.restartOperator();
      const before = publicationFenceState(
        f.store(),
        c.source,
        learner.address.toLowerCase() as `0x${string}`,
        c.message.purpose,
      );
      assert.equal(before.generation, 3);
      const drained = await drainPublicationOutbox(f.ports, {
        maxCommands: 1,
        maxDurationMs: 10000,
      });
      assert.equal(drained.processed, 1);
      assert.equal(drained.more, true);
      assert.deepEqual(
        publicationFenceState(
          f.store(),
          c.source,
          learner.address.toLowerCase() as `0x${string}`,
          c.message.purpose,
        ),
        before,
      );
      assert.equal(f.store().entries("intent:").length, 0);
    }),
);

test(
  "local stop and original learner commit before the actual operator HTTP request completes",
  bounded,
  async (t) =>
    scenario(t, "local-stop-before-operator", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command);
      const gate = f.holdOperator("/publication/v1/fence"),
        pending = f.stop({
          action: "withdraw",
          purpose: c.message.purpose,
          requestId: "held-stop",
          sourceCommandId: c.commandId,
        });
      try {
        await gate.entered;
        const row = (await f.rows()).find((r) => r.action === "withdraw")!;
        assert.ok(row);
        assert.equal(row.typed_json, null);
        assert.equal(row.fence_ack_json, null);
        assert.equal(
          JSON.parse(row.request_json).capture.learner,
          learner.address.toLowerCase(),
        );
        const head = await f.db
          .prepare(
            "SELECT generation,stopped FROM publication_v1_heads WHERE purpose=?",
          )
          .bind(c.message.purpose)
          .first();
        assert.deepEqual(head, { generation: 1, stopped: 1 });
        assert.equal(f.store().entries("publicationV1Fence:").length, 0);
        assert.equal(f.authority.state.simulations.length, 0);
      } finally {
        gate.release();
      }
      assert.equal((await pending).status, 200);
    }),
);

test(
  "a later authenticated binding can inhibit an original while new signing still requires its original learner",
  bounded,
  async (t) =>
    scenario(t, "rebound-account-stop", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command);
      await f.db
        .prepare(
          "UPDATE credential_bindings SET subject=? WHERE binding_id='binding'",
        )
        .bind(other.address.toLowerCase())
        .run();
      const body = {
        action: "withdraw",
        purpose: c.message.purpose,
        requestId: "rebound-stop",
        sourceCommandId: c.commandId,
      };
      assert.equal((await f.stop(body)).status, 200);
      const row = (await f.rows()).find((r) => r.action === "withdraw")!;
      assert.equal(
        JSON.parse(row.request_json).capture.learner,
        learner.address.toLowerCase(),
      );
      assert.equal(row.phase, "preparing");
      assert.equal(row.typed_json, null);
      const challenge = await f.withdraw(body);
      assert.equal(challenge.status, 409);
      assert.equal(challenge.value.walletRequest, undefined);
      assert.equal(f.store().entries("intent:").length, 0);
    }),
);

test(
  "retained original recovery works with first-song active=null and RPC unavailable for an unallocated original",
  bounded,
  async (t) =>
    scenario(t, "original-recovery-without-active-grants", async (f) => {
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const c = parseCommand(prepared.value.command),
        signature = await f.sign(c);
      assert.equal(
        (await f.submit({ commandId: c.commandId, signature })).status,
        200,
      );
      const original = (await f.rows())[0];
      await f.setCatalog(null);
      f.authority.state.offline = true;
      const calls = f.authority.state.calls.length;
      const recovered = await f.call("commands/" + c.commandId);
      assert.equal(recovered.status, 200);
      assert.equal(
        (recovered.value.receipt as { state: string }).state,
        "queued",
      );
      assert.equal(f.authority.state.calls.length, calls);
      assert.equal((await f.rows())[0].accepted_json, original.accepted_json);
      assert.equal((await f.prepare("new-grant")).status, 409);
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
    }),
);
