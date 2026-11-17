import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../packages/protocol/index.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { publicationAppFixture } from "./fixtures/publication-app.ts";

test(
  "public consent routes separate purpose state from immutable command resources",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const prepared = await f.call("grants/prepare", {
        purpose: "study-results",
        requestId: "public-route",
      });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
      const command = parseCommand(prepared.value.command);
      assert.match(String(prepared.value.sourceId), /^0x[0-9a-f]{64}$/);
      const original = await f.call("commands/" + command.commandId);
      assert.equal(original.status, 200);
      assert.deepEqual(original.value.command, prepared.value.command);
      assert.equal(original.value.signature, undefined);
      assert.equal(original.value.accepted_json, undefined);
      const state = await f.call("state?purpose=study-results");
      assert.equal(state.status, 200);
      assert.equal(state.value.schema, "pirate.publication-permission/1");
      assert.equal(state.value.purpose, "study-results");
      assert.equal(state.value.commandId, command.commandId);
      assert.equal(
        state.value.binding,
        undefined,
        "GET must not invent an actual-start binding",
      );
      const submitted = await f.call(
        "commands/" + command.commandId + "/submit",
        { signature: await f.sign(command) },
      );
      assert.equal(submitted.status, 200, JSON.stringify(submitted.value));
      assert.equal(
        (submitted.value.receipt as { state: string }).state,
        "queued",
      );
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
    } finally {
      await f.artifact("public-purpose-and-command-routes");
    }
  },
);

test(
  "withdrawal preparation accepts only an owned retained source ID and stops before signing",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const prepared = await f.call("grants/prepare", {
        purpose: "study-results",
        requestId: "source-route",
      });
      assert.equal(prepared.status, 200);
      const refused = await f.call("withdrawals/prepare", {
        purpose: "study-results",
        requestId: "foreign-source",
        sourceId: digest("not-retained"),
      });
      assert.equal(refused.status, 404);
      const withdrawal = await f.call("withdrawals/prepare", {
        purpose: "study-results",
        requestId: "owned-source",
        sourceId: prepared.value.sourceId,
      });
      assert.equal(withdrawal.status, 200, JSON.stringify(withdrawal.value));
      const command = parseCommand(withdrawal.value.command);
      assert.equal(command.action, "withdraw");
      const head = await f.db
        .prepare(
          "SELECT generation,stopped FROM publication_v1_heads WHERE purpose='study-results'",
        )
        .first<{ generation: number; stopped: number }>();
      assert.deepEqual(head, { generation: 1, stopped: 1 });
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal((await f.call("commands/" + command.commandId)).status, 200);
    } finally {
      await f.artifact("public-retained-source-withdrawal");
    }
  },
);

test(
  "unpublished flat route proposals are not exposed as alternate public commands",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      for (const route of [
        "prepare",
        "submit",
        "original?commandId=" + digest("absent"),
      ]) {
        const response = await f.call(
          route,
          route.startsWith("original")
            ? undefined
            : {
                action: "grant",
                purpose: "study-results",
                requestId: "old-route",
              },
        );
        assert.equal(response.status, 404);
      }
      assert.equal((await f.rows()).length, 0);
    } finally {
      await f.artifact("public-closed-route-inventory");
    }
  },
);

test(
  "retained source withdrawal selects the authenticated binding instead of a newer linked wallet",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await f.prepare("wallet-a");
      assert.equal(first.status, 200);
      const a = parseCommand(first.value.command);
      const { other } = await import("./fixtures/publication-app.ts");
      await f.db.batch([
        f.db
          .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
          .bind(
            "second-binding",
            "account",
            "moss",
            6343,
            other.address.toLowerCase(),
            Date.now(),
          ),
        f.db.prepare(
          "UPDATE community_sessions SET binding_id='second-binding' WHERE account_id='account'",
        ),
      ]);
      f.advance(1n);
      f.authority.advanceSafe(f.now());
      const second = await f.prepare("wallet-b");
      assert.equal(second.status, 200);
      const b = parseCommand(second.value.command);
      assert.notEqual(a.message.learner, b.message.learner);
      assert.equal(first.value.sourceId, second.value.sourceId);
      await f.db
        .prepare(
          "UPDATE community_sessions SET binding_id='binding' WHERE account_id='account'",
        )
        .run();
      const withdrawal = await f.call("withdrawals/prepare", {
        purpose: "study-results",
        requestId: "withdraw-wallet-a",
        sourceId: first.value.sourceId,
      });
      assert.equal(withdrawal.status, 200, JSON.stringify(withdrawal.value));
      const command = parseCommand(withdrawal.value.command);
      assert.equal(command.action, "withdraw");
      assert.equal(command.message.learner, a.message.learner);
      assert.notEqual(command.message.learner, b.message.learner);
      assert.equal(f.store().entries("intent:").length, 0);
      assert.equal(f.store().get("op:nonce"), undefined);
    } finally {
      await f.artifact("public-source-current-binding");
    }
  },
);

test(
  "an unsigned new preparation cannot replace an existing recorded permission",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await f.prepare("recorded-grant");
      assert.equal(first.status, 200);
      const recorded = parseCommand(first.value.command);
      assert.equal(
        (
          await f.submit({
            commandId: recorded.commandId,
            signature: await f.sign(recorded),
          })
        ).status,
        200,
      );
      await f.historicalRecordedOriginal(recorded);
      const original = await f.call("commands/" + recorded.commandId);
      assert.equal(
        (original.value.currentGrant as { state: string }).state,
        "allowed",
      );
      f.advance(1n);
      f.authority.advanceSafe(f.now());
      const pending = await f.prepare("abandoned-preparation");
      assert.equal(pending.status, 200);
      const unrecorded = parseCommand(pending.value.command);
      const current = await f.call("state?purpose=study-results");
      assert.equal(current.status, 200);
      assert.equal(current.value.state, "allowed");
      assert.equal(current.value.commandId, recorded.commandId);
      assert.equal(current.value.grantId, recorded.digest);
      const pendingState = await f.call("commands/" + unrecorded.commandId);
      assert.equal(pendingState.value.phase, "prepared");
      assert.equal(pendingState.value.receipt, null);
      assert.notEqual(
        (pendingState.value.currentGrant as { state: string }).state,
        "allowed",
      );
      assert.equal((await f.rows()).length, 2);
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), 1);
    } finally {
      await f.artifact("public-recorded-permission-survives-prepare");
    }
  },
);

test(
  "a new unrelated binding cannot silently stop one of several historical learners",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await f.prepare("learner-a");
      assert.equal(first.status, 200);
      const { other } = await import("./fixtures/publication-app.ts");
      await f.db.batch([
        f.db
          .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
          .bind(
            "binding-b",
            "account",
            "moss",
            6343,
            other.address.toLowerCase(),
            Date.now(),
          ),
        f.db.prepare(
          "UPDATE community_sessions SET binding_id='binding-b' WHERE account_id='account'",
        ),
      ]);
      f.advance(1n);
      f.authority.advanceSafe(f.now());
      assert.equal((await f.prepare("learner-b")).status, 200);
      await f.db.batch([
        f.db
          .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
          .bind(
            "binding-c",
            "account",
            "moss",
            6343,
            "0x" + "99".repeat(20),
            Date.now(),
          ),
        f.db.prepare(
          "UPDATE community_sessions SET binding_id='binding-c' WHERE account_id='account'",
        ),
      ]);
      const stopped = await f.call("withdrawals/stop", {
        purpose: "study-results",
        requestId: "ambiguous-stop",
        sourceId: first.value.sourceId,
      });
      assert.equal(stopped.status, 409);
      assert.equal(stopped.value.error, "publication_source_ambiguous");
      assert.equal(stopped.value.walletRequest, undefined);
      assert.equal((await f.rows()).length, 2);
      assert.equal(f.operatorCalls.length, 0);
    } finally {
      await f.artifact("public-source-ambiguous-subject-stop");
    }
  },
);

test(
  "an expired selected recorded grant cannot revive an older unexpired grant",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await f.prepare("long-grant");
      assert.equal(first.status, 200);
      const a = parseCommand(first.value.command);
      assert.equal(a.action, "grant");
      assert.equal(
        (await f.submit({ commandId: a.commandId, signature: await f.sign(a) }))
          .status,
        200,
      );
      await f.historicalRecordedOriginal(a);
      assert.equal(
        (await f.call("state?purpose=study-results")).value.state,
        "allowed",
      );
      const short = structuredClone(f.authority.release);
      short.grantDurationSeconds = "30";
      short.submitWindowSeconds = "30";
      f.replaceActive(short);
      f.advance(1n);
      f.authority.advanceSafe(f.now());
      const second = await f.prepare("short-grant");
      assert.equal(second.status, 200);
      const b = parseCommand(second.value.command);
      assert.equal(
        (await f.submit({ commandId: b.commandId, signature: await f.sign(b) }))
          .status,
        200,
      );
      const recorded = await f.historicalRecordedOriginal(b);
      assert.equal(recorded.nonce, 1);
      assert.equal(
        (await f.call("state?purpose=study-results")).value.state,
        "allowed",
      );
      f.advance(31n);
      f.authority.advanceSafe(f.now());
      assert.ok(
        BigInt(a.message.expiresAt) > f.now(),
        "older on-chain grant remains unexpired",
      );
      const current = await f.call("state?purpose=study-results");
      assert.equal(current.status, 200);
      assert.equal(current.value.commandId, b.commandId);
      assert.equal(current.value.state, "denied");
      assert.equal(current.value.reason, "expired");
      assert.equal(
        (await f.call("commands/" + a.commandId)).value.phase,
        "accepted",
      );
      assert.equal((await f.rows()).length, 2);
      assert.equal(f.store().get("op:nonce"), 2);
      assert.equal(f.store().entries("tx:").length, 2);
    } finally {
      await f.artifact("public-expired-selection-no-revival");
    }
  },
);

test(
  "with no recorded grant the newest unsigned command remains the pending purpose selection",
  { timeout: 30000 },
  async (t) => {
    const f = await publicationAppFixture(t);
    try {
      const first = await f.prepare("queued-pending");
      assert.equal(first.status, 200);
      const a = parseCommand(first.value.command);
      assert.equal(
        (await f.submit({ commandId: a.commandId, signature: await f.sign(a) }))
          .status,
        200,
      );
      f.advance(1n);
      f.authority.advanceSafe(f.now());
      const second = await f.prepare("newer-unsigned-pending");
      assert.equal(second.status, 200);
      const b = parseCommand(second.value.command);
      const current = await f.call("state?purpose=study-results");
      assert.equal(current.status, 200);
      assert.equal(current.value.state, "unavailable");
      assert.equal(current.value.commandId, b.commandId);
      assert.equal(
        (await f.call("commands/" + a.commandId)).value.phase,
        "accepted",
      );
      assert.equal(
        (await f.call("commands/" + b.commandId)).value.phase,
        "prepared",
      );
      assert.equal(f.store().entries("intent:").length, 1);
      assert.equal(f.store().get("op:nonce"), undefined);
    } finally {
      await f.artifact("public-newest-pending-command");
    }
  },
);
