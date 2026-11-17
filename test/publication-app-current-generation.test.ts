import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseCommand } from "../services/publication-command-contract.ts";
import {
  publicationAppFixture,
  learner,
  other,
} from "./fixtures/publication-app.ts";

type Fixture = Awaited<ReturnType<typeof publicationAppFixture>>;
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
async function queued(f: Fixture) {
  const prepared = await f.prepare();
  assert.equal(prepared.status, 200);
  const command = parseCommand(prepared.value.command);
  const response = await f.submit({
    commandId: command.commandId,
    signature: await f.sign(command),
  });
  assert.equal(response.status, 200);
  assert.equal((response.value.receipt as { state: string }).state, "queued");
  return command;
}
const head = (f: Fixture) =>
  f.db
    .prepare(
      "SELECT generation,stopped FROM publication_v1_heads WHERE purpose='study-results'",
    )
    .first<{ generation: number; stopped: number }>();

test(
  "initial and queued grant heads remain stopped, without nonce allocation or a usable grant",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "initial-queued-head-stopped", async (f) => {
      const c = await queued(f);
      assert.deepEqual(await head(f), { generation: 0, stopped: 1 });
      const state = await f.call("commands/" + c.commandId);
      assert.equal(state.status, 200);
      assert.notEqual(
        (state.value.currentGrant as { state: string }).state,
        "allowed",
      );
      assert.equal(f.store().get("op:nonce"), undefined);
      assert.equal(f.store().entries("tx:").length, 0);
    }),
);

// Required Root successor join: this must fail against sealed source3. The
// fixture provides a historical signed original but NEVER clears stopped.
test(
  "only the original recorded grant of the current generation can open its local head",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "recorded-current-generation-opens", async (f) => {
      const c = await queued(f);
      assert.equal(c.action, "grant");
      const original = await f.historicalRecordedOriginal(c);
      assert.deepEqual(await head(f), { generation: 0, stopped: 1 });
      const state = await f.call("commands/" + c.commandId);
      assert.equal(state.status, 200, JSON.stringify(state.value));
      assert.equal(
        (state.value.receipt as { state: string; transactionHash: string })
          .state,
        "recorded",
      );
      assert.equal(
        (state.value.receipt as { transactionHash: string }).transactionHash,
        original.hash,
      );
      assert.deepEqual(await head(f), { generation: 0, stopped: 0 });
      assert.equal(
        (state.value.currentGrant as { state: string }).state,
        "allowed",
      );
      const repeated = await f.call("commands/" + c.commandId);
      assert.equal(repeated.status, 200);
      assert.deepEqual(await head(f), { generation: 0, stopped: 0 });
      assert.equal(f.store().get("op:nonce"), 1);
      assert.equal(f.store().entries("tx:").length, 1);
      assert.equal(
        f.store().get<{ raw: string }>("tx:0000000000")!.raw,
        original.raw,
      );
    }),
);

test(
  "a withdrawal winning before original recording prevents stale grant re-enable while receipt recovery still succeeds",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "withdrawal-wins-recorded-join", async (f) => {
      const c = await queued(f);
      assert.equal(c.action, "grant");
      const stop = await f.stop({
        action: "withdraw",
        purpose: c.message.purpose,
        requestId: "withdraw-wins",
        sourceCommandId: c.commandId,
      });
      assert.equal(stop.status, 200);
      assert.deepEqual(await head(f), { generation: 1, stopped: 1 });
      const original = await f.historicalRecordedOriginal(c);
      const state = await f.call("commands/" + c.commandId);
      assert.equal(state.status, 200);
      assert.equal(
        (state.value.receipt as { state: string }).state,
        "recorded",
      );
      assert.equal(
        (state.value.receipt as { transactionHash: string }).transactionHash,
        original.hash,
      );
      assert.notEqual(
        (state.value.currentGrant as { state: string }).state,
        "allowed",
      );
      assert.deepEqual(await head(f), { generation: 1, stopped: 1 });
      const status = await f.call("commands/" + c.commandId);
      assert.equal(status.status, 200);
      assert.equal(
        (status.value.receipt as { state: string }).state,
        "recorded",
      );
      assert.equal(f.store().get("op:nonce"), 1);
      assert.equal(f.store().entries("intent:").length, 1);
    }),
);

test(
  "purpose-keyed stop cannot advance another purpose's local generation",
  { timeout: 30000 },
  async (t) =>
    scenario(t, "purpose-keyed-local-stop", async (f) => {
      const study = await f.prepare("study", "study-results"),
        karaoke = await f.prepare("karaoke", "karaoke-results");
      assert.equal(study.status, 200);
      assert.equal(karaoke.status, 200);
      const c = parseCommand(study.value.command);
      assert.equal(
        (
          await f.stop({
            action: "withdraw",
            purpose: "study-results",
            requestId: "study-stop",
            sourceCommandId: c.commandId,
          })
        ).status,
        200,
      );
      const rows = (
        await f.db
          .prepare(
            "SELECT purpose,generation,stopped FROM publication_v1_heads ORDER BY purpose",
          )
          .all()
      ).results;
      assert.deepEqual(rows, [
        { purpose: "karaoke-results", generation: 0, stopped: 1 },
        { purpose: "study-results", generation: 1, stopped: 1 },
      ]);
      assert.equal(f.store().entries("intent:").length, 0);
    }),
);

for (const changedWallet of [false, true])
  test(
    `historical receipt survives ${changedWallet ? "wallet" : "binding"} change without opening old consent`,
    { timeout: 30000 },
    async (t) =>
      scenario(
        t,
        changedWallet ? "recorded-old-wallet" : "recorded-old-binding",
        async (f) => {
          const c = await queued(f),
            original = await f.historicalRecordedOriginal(c);
          const session = await f.db
            .prepare(
              "SELECT * FROM community_sessions WHERE account_id='account'",
            )
            .first<{
              session_hash: string;
              community_id: string;
              community_origin: string;
              account_id: string;
              csrf_token: string;
              expires_at: number;
            }>();
          assert.ok(session);
          // Model a completed unbind/rebind, respecting the unique wallet identity.
          await f.db.batch([
            f.db.prepare(
              "DELETE FROM community_sessions WHERE account_id='account'",
            ),
            ...(!changedWallet
              ? [
                  f.db.prepare(
                    "DELETE FROM credential_bindings WHERE binding_id='binding'",
                  ),
                ]
              : []),
            f.db
              .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
              .bind(
                "replacement-binding",
                "account",
                "moss",
                6343,
                (changedWallet ? other : learner).address.toLowerCase(),
                Date.now(),
              ),
            f.db
              .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
              .bind(
                session.session_hash,
                session.community_id,
                session.community_origin,
                session.account_id,
                "replacement-binding",
                session.csrf_token,
                session.expires_at,
              ),
          ]);
          const state = await f.call("commands/" + c.commandId);
          assert.equal(state.status, 200, JSON.stringify(state.value));
          assert.equal(
            (state.value.receipt as { state: string }).state,
            "recorded",
          );
          assert.equal(
            (state.value.receipt as { transactionHash: string })
              .transactionHash,
            original.hash,
          );
          assert.deepEqual(state.value.currentGrant, {
            state: "denied",
            reason: "wrong_scope",
          });
          assert.deepEqual(await head(f), { generation: 0, stopped: 1 });
          assert.equal(f.store().get("op:nonce"), 1);
          assert.equal(f.store().entries("intent:").length, 1);
          const current = await f.call("state?purpose=study-results");
          assert.equal(current.status, 200);
          assert.notEqual(current.value.state, "allowed");
        },
      ),
  );
