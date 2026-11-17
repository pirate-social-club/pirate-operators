import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { digest } from "../packages/protocol/index.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

type Fixture = Awaited<ReturnType<typeof publicationAppFixture>>;
async function scenario(
  t: TestContext,
  label: string,
  work: (f: Fixture) => Promise<void>,
) {
  const f = await publicationAppFixture(t, { safeLag: 389n });
  try {
    await work(f);
  } finally {
    await f.artifact(label);
  }
}
// These are required successor assertions. They intentionally expose sealed
// source3's missing pending-before-wallet join; no skip, todo or green claim.
test(
  "safe lag returns observation-pending before wallet exposure, then resumes the same original",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "safe-lag-original-progress", async (f) => {
      const issued = f.now(),
        pending = await f.prepare();
      assert.equal(pending.status, 503, JSON.stringify(pending.value));
      assert.equal(pending.value.error, "publication_observation_pending");
      assert.equal(pending.value.walletRequest, undefined);
      const first = (await f.rows())[0];
      assert.ok(first);
      assert.equal(first.phase, "preparing");
      assert.equal(first.typed_json, null);
      assert.equal(first.signature, null);
      assert.equal(BigInt(Math.floor(first.created_at / 1000)), issued);
      f.authority.advanceSafe(issued);
      const resumed = await f.prepare();
      assert.equal(resumed.status, 200, JSON.stringify(resumed.value));
      const command = parseCommand(resumed.value.command);
      assert.equal(command.action, "grant");
      assert.equal(command.commandId, first.command_id);
      assert.equal(command.message.nonce, first.nonce_hex);
      assert.equal(command.message.issuedAt, String(issued));
      assert.equal(command.message.validAfter, String(issued));
      assert.equal(command.preparedAtMs, first.created_at);
      assert.equal((await f.rows()).length, 1);
      const accepted = await f.submit({
        commandId: command.commandId,
        signature: await f.sign(command),
      });
      assert.equal(accepted.status, 200);
      assert.equal(
        (accepted.value.receipt as { state: string }).state,
        "queued",
      );
      assert.equal(f.authority.state.simulations.length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
    }),
);

test(
  "an original exhausted during safe lag is retained without extended time or replacement wallet challenge",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "safe-lag-original-exhausted", async (f) => {
      const pending = await f.prepare();
      assert.equal(pending.status, 503);
      assert.equal(pending.value.error, "publication_observation_pending");
      const original = (await f.rows())[0];
      assert.ok(original);
      f.advance(1801n);
      f.authority.advanceSafe(f.now());
      const retry = await f.prepare();
      assert.equal(retry.status, 409, JSON.stringify(retry.value));
      assert.equal(retry.value.error, "publication_original_window_expired");
      assert.equal(retry.value.walletRequest, undefined);
      const rows = await f.rows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].command_id, original.command_id);
      assert.equal(rows[0].nonce_hex, original.nonce_hex);
      assert.equal(rows[0].created_at, original.created_at);
      assert.equal(rows[0].typed_json, null);
      assert.equal(rows[0].signature, null);
      assert.equal(f.authority.state.simulations.length, 0);
      assert.equal(f.store().entries("intent:").length, 0);
    }),
);

test(
  "submission rechecks safe coverage without accepting or replacing the original signature",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "safe-lag-at-submission", async (f) => {
      f.authority.advanceSafe(f.now());
      const prepared = await f.prepare();
      assert.equal(prepared.status, 200);
      const command = parseCommand(prepared.value.command),
        signature = await f.sign(command),
        original = (await f.rows())[0];
      f.authority.state.safe = {
        number: 999n,
        hash: digest("lagged-canonical-node"),
        timestamp: f.now() - 389n,
      };
      // Independent fixed chain response if unsafe full calldata simulation is
      // reached. The production pending gate must prevent that wallet loop.
      f.authority.state.simulationError = "0x1e03086a";
      const pending = await f.submit({
        commandId: command.commandId,
        signature,
      });
      assert.equal(pending.status, 503);
      assert.equal(pending.value.error, "publication_observation_pending");
      assert.equal(f.authority.state.simulations.length, 0);
      const retained = (await f.rows())[0];
      assert.equal(retained.typed_json, original.typed_json);
      assert.equal(retained.nonce_hex, original.nonce_hex);
      assert.equal(retained.created_at, original.created_at);
      assert.equal(retained.signature, null);
      assert.equal(retained.accepted_json, null);
      f.authority.state.simulationError = null;
      f.authority.advanceSafe(f.now());
      assert.equal(
        (await f.submit({ commandId: command.commandId, signature })).status,
        200,
      );
      assert.equal((await f.rows())[0].signature, signature);
      assert.equal((await f.rows()).length, 1);
    }),
);
