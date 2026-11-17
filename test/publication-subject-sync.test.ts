import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  publicationAppFixture,
  learner,
  other,
} from "./fixtures/publication-app.ts";
import {
  publicationFenceState,
  readPublicationJob,
} from "../services/publication-command-operator.ts";
import { deliverPublicationOriginal } from "../services/publication-app-outbox.ts";
import {
  terminalWithdrawalA,
  prepareB,
  currentLearner,
  higherRemoteB,
  accountFenceKeys,
  artifact,
  type SubjectFixture,
} from "./fixtures/publication-subject-sync.ts";

const bounded = { timeout: 30000 };
async function scenario(
  t: TestContext,
  label: string,
  work: (f: SubjectFixture) => Promise<void>,
) {
  const f = await publicationAppFixture(t);
  try {
    await work(f);
  } finally {
    t.diagnostic(JSON.stringify(await artifact(f, label)));
  }
}
const head = (
  f: SubjectFixture,
  wallet: string,
  source: Parameters<typeof publicationFenceState>[1],
) =>
  publicationFenceState(
    f.store(),
    source,
    wallet.toLowerCase() as `0x${string}`,
    "study-results",
  );
const localHead = (f: SubjectFixture) =>
  f.db
    .prepare(
      `SELECT generation,stopped FROM publication_v1_heads
  WHERE account_id='account' AND purpose='study-results'`,
    )
    .first<{ generation: number; stopped: number }>();

test(
  "terminal A withdrawal durably aligns linked B's fresh grant to its captured generation",
  bounded,
  async (t) =>
    scenario(t, "subject-B-inherits-exact-generation", async (f) => {
      const a = await terminalWithdrawalA(f),
        b = await prepareB(f);
      assert.equal(b.command.localFenceGeneration, "1");
      assert.equal(head(f, other.address, b.command.source).generation, 0);
      const nonce = f.store().get("op:nonce"),
        accepted = await f.submit({
          commandId: b.command.commandId,
          signature: b.signature,
        });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
      assert.equal(
        (accepted.value.receipt as { state: string }).state,
        "queued",
      );
      assert.deepEqual(head(f, other.address, b.command.source), {
        generation: 1,
        stopped: true,
        commandId: a.command.commandId,
      });
      assert.equal(accountFenceKeys(f).length, 1);
      assert.equal(f.store().get("op:nonce"), nonce);
      assert.equal(f.store().entries("intent:").length, 2);
      const row = (await f.rows()).find(
        (r) => r.command_id === b.command.commandId,
      )!;
      assert.equal(row.signature, b.signature);
      assert.equal(row.fence_generation, 1);
      assert.equal(row.nonce_hex, b.command.message.nonce);
      assert.equal(
        (await f.rows()).find((r) => r.command_id === a.row.command_id)!
          .fence_ack_json,
        a.row.fence_ack_json,
      );
      assert.equal(
        readPublicationJob(f.store(), b.command.commandId)!.signature,
        b.signature,
      );
    }),
);

test(
  "exact legacy witness backfill and lost response survive SQLite restart without replacing the original",
  bounded,
  async (t) =>
    scenario(t, "subject-legacy-backfill-restart", async (f) => {
      const a = await terminalWithdrawalA(f);
      // Explicit older-format Store fixture: original job/fence/head untouched,
      // only the newly introduced attribution is absent before replay.
      for (const key of accountFenceKeys(f)) f.store().delete(key);
      f.restartOperator();
      assert.equal(accountFenceKeys(f).length, 0);
      const b = await prepareB(f);
      f.loseOperatorResponse("/publication/v1/fence");
      const lost = await f.submit({
        commandId: b.command.commandId,
        signature: b.signature,
      });
      assert.equal(lost.status, 503);
      const first = (await f.rows()).find(
        (r) => r.command_id === b.command.commandId,
      )!;
      assert.equal(first.phase, "accepted");
      assert.ok(first.accepted_json);
      assert.equal(accountFenceKeys(f).length, 1);
      assert.equal(head(f, other.address, b.command.source).generation, 0);
      f.restartOperator();
      f.advance(1n);
      const drained = await f.drain();
      assert.equal(drained.failed, 0);
      const row = (await f.rows()).find(
        (r) => r.command_id === b.command.commandId,
      )!;
      assert.equal(row.result_state, "queued");
      assert.equal(row.accepted_json, first.accepted_json);
      assert.equal(row.signature, b.signature);
      assert.equal(row.nonce_hex, first.nonce_hex);
      assert.equal(head(f, other.address, b.command.source).generation, 1);
      assert.equal(f.store().entries("intent:").length, 2);
      assert.equal(f.store().get("op:nonce"), a.nonce + 1);
      const fences = f.operatorCalls.filter(
        (c) => c.path === "/publication/v1/fence",
      );
      assert.equal(new Set(fences.map((c) => c.bodySha256)).size, 1);
      assert.equal(
        (await f.rows()).find((r) => r.command_id === a.row.command_id)!
          .fence_ack_json,
        a.row.fence_ack_json,
      );
    }),
);

test(
  "a higher target learner head refuses fresh queue and is never copied into the app generation",
  bounded,
  async (t) =>
    scenario(t, "subject-higher-remote-refused", async (f) => {
      const a = await terminalWithdrawalA(f);
      await higherRemoteB(f, 3);
      const b = await prepareB(f);
      assert.equal(b.command.localFenceGeneration, "1");
      assert.equal(head(f, other.address, b.command.source).generation, 3);
      const before = head(f, other.address, b.command.source),
        response = await f.submit({
          commandId: b.command.commandId,
          signature: b.signature,
        });
      assert.ok(response.status >= 400, JSON.stringify(response.value));
      assert.equal(
        readPublicationJob(f.store(), b.command.commandId),
        undefined,
      );
      assert.deepEqual(head(f, other.address, b.command.source), before);
      assert.deepEqual(await localHead(f), { generation: 1, stopped: 1 });
      const retained = (await f.rows()).find(
        (r) => r.command_id === b.command.commandId,
      )!;
      assert.equal(retained.fence_generation, 1);
      assert.equal(retained.nonce_hex, b.command.message.nonce);
      assert.equal(retained.signature, b.signature);
      assert.equal(f.store().get("op:nonce"), a.nonce + 1);
      assert.equal(f.store().entries("intent:").length, 1);
    }),
);

test(
  "a newer local withdrawal during witness replay prevents newly queueing the stale accepted grant",
  bounded,
  async (t) =>
    scenario(t, "subject-withdrawal-wins-replay", async (f) => {
      await terminalWithdrawalA(f);
      const b = await prepareB(f),
        gate = f.holdOperatorResult("/publication/v1/fence"),
        pending = f.submit({
          commandId: b.command.commandId,
          signature: b.signature,
        });
      try {
        await gate.entered;
        const stop = await f.stop({
          purpose: "study-results",
          requestId: "B-newer-stop",
          sourceCommandId: b.command.commandId,
        });
        assert.equal(stop.status, 200, JSON.stringify(stop.value));
        assert.deepEqual(await localHead(f), { generation: 2, stopped: 1 });
      } finally {
        gate.release();
      }
      const response = await pending;
      assert.ok(response.status >= 400);
      assert.equal(
        readPublicationJob(f.store(), b.command.commandId),
        undefined,
      );
      assert.equal(head(f, other.address, b.command.source).generation, 2);
      const row = (await f.rows()).find(
        (r) => r.command_id === b.command.commandId,
      )!;
      assert.equal(row.phase, "accepted");
      assert.equal(row.fence_generation, 1);
      assert.equal(row.signature, b.signature);
      assert.equal(row.nonce_hex, b.command.message.nonce);
    }),
);

test(
  "an existing B generation0 original reconciles after A advances the account, without requeue or rebind",
  bounded,
  async (t) =>
    scenario(t, "subject-old-original-recovery", async (f) => {
      const b = await prepareB(f, "B-old"),
        accepted = await f.submit({
          commandId: b.command.commandId,
          signature: b.signature,
        });
      assert.equal(accepted.status, 200);
      assert.equal(b.command.localFenceGeneration, "0");
      const old = (await f.rows()).find(
          (r) => r.command_id === b.command.commandId,
        )!,
        job = readPublicationJob(f.store(), b.command.commandId)!;
      await currentLearner(f, learner.address);
      const a = await terminalWithdrawalA(f);
      const before = head(f, other.address, b.command.source),
        count = f.store().entries("intent:").length,
        fenceCalls = f.operatorCalls.filter(
          (c) => c.path === "/publication/v1/fence",
        ).length;
      const recovered = await deliverPublicationOriginal(f.ports, old);
      assert.equal(recovered.result_state, "queued");
      assert.equal(recovered.accepted_json, old.accepted_json);
      assert.equal(recovered.signature, b.signature);
      assert.deepEqual(readPublicationJob(f.store(), b.command.commandId), job);
      assert.deepEqual(head(f, other.address, b.command.source), before);
      assert.equal(before.generation, 0);
      assert.equal(f.store().entries("intent:").length, count);
      assert.equal(f.store().get("op:nonce"), a.nonce + 1);
      assert.equal(
        f.operatorCalls.filter((c) => c.path === "/publication/v1/fence")
          .length,
        fenceCalls,
      );
      assert.equal(f.operatorCalls.at(-1)?.path, "/publication/v1/reconcile");
      assert.ok(
        f.authority.state.calls.every(
          (method) => !method.startsWith("eth_send"),
        ),
      );
    }),
);

test(
  "failed witness fence delivery cannot block recovery of an already recorded B original",
  bounded,
  async (t) =>
    scenario(
      t,
      "subject-recorded-recovery-despite-fence-failure",
      async (f) => {
        await terminalWithdrawalA(f);
        const b = await prepareB(f);
        assert.equal(
          (
            await f.submit({
              commandId: b.command.commandId,
              signature: b.signature,
            })
          ).status,
          200,
        );
        f.advance(1n);
        f.authority.advanceSafe(f.now());
        const original = await f.historicalRecordedOriginal(b.command);
        const row = (await f.rows()).find(
          (r) => r.command_id === b.command.commandId,
        )!;
        const before = head(f, other.address, b.command.source),
          jobs = f.store().entries("intent:").length;
        f.loseOperatorResponse("/publication/v1/fence");
        const recovered = await deliverPublicationOriginal(f.ports, row);
        assert.equal(recovered.result_state, "recorded");
        assert.equal(recovered.accepted_json, row.accepted_json);
        assert.equal(recovered.signature, b.signature);
        assert.deepEqual(head(f, other.address, b.command.source), before);
        assert.equal(f.store().entries("intent:").length, jobs);
        assert.equal(f.store().get("op:nonce"), original.nonce + 1);
        assert.equal(
          f.store().get<{
            raw: string;
          }>("tx:" + String(original.nonce).padStart(10, "0"))!.raw,
          original.raw,
        );
        assert.equal(f.operatorCalls.at(-1)?.path, "/publication/v1/reconcile");
      },
    ),
);

test(
  "conflicting account acknowledgements hold fresh grants while original receipts still recover",
  bounded,
  async (t) =>
    scenario(t, "subject-conflicting-account-fences", async (f) => {
      const a = await terminalWithdrawalA(f);
      const { commandId } = await import(
        "../services/publication-command-contract.ts"
      );
      const { digest } = await import("../packages/protocol/index.ts");
      const id = commandId({
        source: a.command.source,
        accountId: "account",
        requestId: "forked-B-stop",
        action: "withdraw",
        purpose: "study-results",
      });
      // An explicitly contradictory but genuinely issuer-signed declaration,
      // representing a forked installation. It supplies no learner signature.
      const body = {
        schema: "pirate.publication-inhibition/1",
        commandId: id,
        accountId: "account",
        requestId: "forked-B-stop",
        source: a.command.source,
        learner: other.address.toLowerCase(),
        purpose: "study-results",
        generation: "1",
        requestHash: digest("forked-B-request"),
      };
      await f.ports.transport.request(
        "/publication/v1/fence",
        { ...a.row, command_id: id },
        f.authority.release,
        body,
      );
      const keys = accountFenceKeys(f);
      assert.equal(keys.length, 1);
      assert.equal(
        f.store().get<{ conflicted: boolean }>(keys[0])!.conflicted,
        true,
      );
      const b = await prepareB(f),
        jobs = f.store().entries("intent:").length;
      const response = await f.submit({
        commandId: b.command.commandId,
        signature: b.signature,
      });
      assert.equal(response.status, 503);
      assert.equal(
        f.operatorErrors.at(-1)!.error,
        "publication_account_generation_unacknowledged",
      );
      assert.equal(
        readPublicationJob(f.store(), b.command.commandId),
        undefined,
      );
      assert.equal(
        (await f.call("commands/" + a.command.commandId)).value.receipt &&
          (
            (await f.call("commands/" + a.command.commandId)).value.receipt as {
              state: string;
            }
          ).state,
        "recorded",
      );
      assert.equal(f.store().entries("intent:").length, jobs);
      assert.equal(f.store().get("op:nonce"), a.nonce + 1);
      assert.equal(
        f.store().get<{ conflicted: boolean }>(keys[0])!.conflicted,
        true,
      );
    }),
);

test(
  "sponsor exhaustion rolls target alignment and new job back in the actual Store transaction",
  bounded,
  async (t) =>
    scenario(t, "subject-alignment-budget-rollback", async (f) => {
      const a = await terminalWithdrawalA(f),
        b = await prepareB(f);
      const { feeLimits } = await import(
        "../services/publication-command-contract.ts"
      );
      const { reserveSponsorship, chargeSponsorship } = await import(
        "../services/sponsor-budget.ts"
      );
      const limits = feeLimits(f.authority.release.fee);
      // Durable historical charges from other admitted work consume the same
      // real ledger. They are not new public transactions or invented refunds.
      for (let i = 0; i < 9; i++) {
        const ref = "retained-work-" + i;
        reserveSponsorship(f.store(), limits, ref);
        chargeSponsorship(f.store(), limits, ref);
      }
      const before = head(f, other.address, b.command.source),
        ledger = f.store().get("sponsor:ledger"),
        attribution = f.store().entries("publicationV1AccountFence:"),
        jobs = f.store().entries("intent:").length;
      assert.equal(before.generation, 0);
      const response = await f.submit({
        commandId: b.command.commandId,
        signature: b.signature,
      });
      assert.equal(response.status, 503);
      assert.equal(f.operatorErrors.at(-1)!.error, "sponsor_exhausted");
      assert.deepEqual(head(f, other.address, b.command.source), before);
      assert.deepEqual(f.store().get("sponsor:ledger"), ledger);
      assert.deepEqual(
        f.store().entries("publicationV1AccountFence:"),
        attribution,
      );
      assert.equal(
        readPublicationJob(f.store(), b.command.commandId),
        undefined,
      );
      assert.equal(f.store().entries("intent:").length, jobs);
      assert.equal(f.store().get("op:nonce"), a.nonce + 1);
    }),
);

test(
  "failed current D1 admission read still reconciles an already recorded original",
  bounded,
  async (t) =>
    scenario(
      t,
      "subject-recorded-recovery-despite-context-failure",
      async (f) => {
        await terminalWithdrawalA(f);
        const b = await prepareB(f);
        assert.equal(
          (
            await f.submit({
              commandId: b.command.commandId,
              signature: b.signature,
            })
          ).status,
          200,
        );
        f.advance(1n);
        f.authority.advanceSafe(f.now());
        const original = await f.historicalRecordedOriginal(b.command),
          row = (await f.rows()).find(
            (r) => r.command_id === b.command.commandId,
          )!,
          before = head(f, other.address, b.command.source),
          jobs = f.store().entries("intent:").length;
        const acceptCalls = f.operatorCalls.filter(
          (c) => c.path === "/publication/v1/accept",
        ).length;
        f.failRead("SELECT h.generation,h.stop_command_id,");
        const recovered = await deliverPublicationOriginal(f.ports, row);
        assert.equal(recovered.result_state, "recorded");
        assert.equal(recovered.accepted_json, row.accepted_json);
        assert.equal(recovered.signature, b.signature);
        assert.equal(recovered.nonce_hex, row.nonce_hex);
        assert.deepEqual(head(f, other.address, b.command.source), before);
        assert.equal(f.store().entries("intent:").length, jobs);
        assert.equal(f.store().get("op:nonce"), original.nonce + 1);
        assert.equal(
          f.store().get<{
            raw: string;
          }>("tx:" + String(original.nonce).padStart(10, "0"))!.raw,
          original.raw,
        );
        assert.equal(
          f.operatorCalls.filter((c) => c.path === "/publication/v1/accept")
            .length,
          acceptCalls,
        );
        assert.equal(f.operatorCalls.at(-1)?.path, "/publication/v1/reconcile");
      },
    ),
);

test(
  "unavailable current admission with no remote original stays held without a new queue",
  bounded,
  async (t) =>
    scenario(t, "subject-no-original-context-unavailable", async (f) => {
      const b = await prepareB(f);
      f.failRead("SELECT h.generation,h.stop_command_id,");
      const response = await f.submit({
        commandId: b.command.commandId,
        signature: b.signature,
      });
      assert.equal(response.status, 503);
      const row = (await f.rows())[0];
      assert.equal(row.phase, "accepted");
      assert.equal(row.signature, b.signature);
      assert.equal(row.nonce_hex, b.command.message.nonce);
      assert.ok(row.accepted_json);
      assert.equal(f.operatorCalls.at(-1)?.path, "/publication/v1/reconcile");
      assert.equal(
        f.operatorCalls.some((c) => c.path === "/publication/v1/accept"),
        false,
      );
      assert.equal(
        readPublicationJob(f.store(), b.command.commandId),
        undefined,
      );
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal(f.store().get("op:nonce"), undefined);
      assert.equal(f.store().get("sponsor:ledger"), undefined);
    }),
);
