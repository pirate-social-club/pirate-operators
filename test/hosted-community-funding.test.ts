import test from "node:test";
import assert from "node:assert/strict";
import { enrollmentTypedData } from "../packages/community/hosted-enrollment.ts";
import {
  allOperations,
  revokeHostedInvite,
} from "../packages/community/hosted-enrollment-store.ts";
import { createHostedEnrollmentService } from "../services/hosted-community-enrollment.ts";
import { createHostedFundingService } from "../services/hosted-community-funding.ts";
import {
  hostedFixture,
  lower,
} from "./fixtures/hosted-community-enrollment.ts";
import { directoryV3Abi } from "../packages/community/web2-directory.ts";

async function enrolled(
  f: Awaited<ReturnType<typeof hostedFixture>>,
  same = false,
) {
  const i = await f.invite(
      same ? { publisher: f.accounts.controller.address } : {},
    ),
    p = await f.prepare(i);
  assert.equal((await f.post("/redeem", p.auth)).status, 200);
  await f.mine();
  const recipients = same
    ? [f.accounts.controller]
    : [f.accounts.controller, f.accounts.publisher];
  const recipientProofs = await Promise.all(
    recipients.map(async (a) => ({
      recipient: lower(a.address),
      signature: await a.signTypedData(enrollmentTypedData(p.e)),
    })),
  );
  return { i, p, body: { ...p.auth, recipientProofs } };
}
test("initial topups meter exact receipt costs and permanently charge conservative bounds without duplicate transfers", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f),
      before = await f.local.getBalance({
        address: f.accounts.controller.address,
      });
    const initial = await f.post("/initial-topup", body);
    assert.equal(initial.status, 200, JSON.stringify(initial));
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal(
      (await f.local.getBalance({ address: f.accounts.controller.address })) -
        before,
      BigInt(f.policy.controllerInitialWei),
    );
    const ops = await allOperations(f.db, p.e.id);
    assert.equal(ops.length, 3);
    assert(ops.every((o) => o.state === "consumed"));
    for (const op of ops) {
      const receipt = JSON.parse(op.receipt!);
      assert.equal(receipt.chargedBoundWei, op.reservation);
      assert.equal(
        BigInt(receipt.cost),
        BigInt(receipt.principal) +
          BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
          BigInt(receipt.extraFee),
      );
      assert(BigInt(receipt.cost) <= BigInt(op.reservation));
    }
    const budget = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets WHERE scope=?")
      .bind(`hosted:${f.policy.pilotId}:global`)
      .first<{ reserved: string; spent: string }>();
    assert.equal(budget?.reserved, "0");
    assert.equal(
      BigInt(budget!.spent),
      ops.reduce((n, o) => n + BigInt(o.reservation), 0n),
    );
    const sent = f.state.sendCount;
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    assert.equal(f.state.sendCount, sent);
    console.log(
      JSON.stringify({
        proof: "hosted-topups",
        operations: ops.map((o) => ({
          kind: o.kind,
          hash: o.tx_hash,
          receipt: JSON.parse(o.receipt!),
        })),
        budget,
      }),
    );
  } finally {
    await f.close();
  }
});
test("same controller and publisher receives one maximum initial allocation under concurrent requests", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true),
      before = await f.local.getBalance({
        address: f.accounts.controller.address,
      });
    const results = await Promise.all([
      f.post("/initial-topup", body),
      f.post("/initial-topup", body),
    ]);
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r));
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal(
      (await f.local.getBalance({ address: f.accounts.controller.address })) -
        before,
      BigInt(f.policy.publisherInitialWei),
    );
    assert.equal(
      (await allOperations(f.db, p.e.id)).filter((o) => o.kind === "topup")
        .length,
      1,
    );
    assert.equal(f.state.sendCount, 2);
  } finally {
    await f.close();
  }
});
test("lost real broadcast response and service restart reconcile the original without redispatch", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true);
    f.state.dropSend = 1;
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    const sent = f.state.sendCount;
    const before = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    assert(before.raw && before.tx_hash);
    assert.equal(before.state, "dispatched");
    const restarted = createHostedEnrollmentService(f.runtime);
    await f.mine();
    assert.equal((await f.post("/status", p.auth, restarted)).status, 200);
    const after = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    assert.equal(after.state, "consumed");
    assert.equal(after.raw, before.raw);
    assert.equal(after.tx_hash, before.tx_hash);
    assert.equal(after.nonce, before.nonce);
    assert.equal(f.state.sendCount, sent);
    assert.equal(
      (
        await f.post(
          "/initial-topup",
          body,
          createHostedFundingService(f.runtime),
        )
      ).status,
      200,
    );
    assert.equal(f.state.sendCount, sent);
  } finally {
    await f.close();
  }
});
test("revocation blocks new funding while an already broadcast original can settle", async () => {
  const f = await hostedFixture();
  try {
    const { i, p, body } = await enrolled(f, true);
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    await revokeHostedInvite(f.db, i.id);
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal(
      (await f.post("/initial-topup", body)).body.error,
      "enrollment_inactive",
    );
    assert.equal(f.state.sendCount, 2);
    assert(
      (await allOperations(f.db, p.e.id)).every((o) => o.state === "consumed"),
    );
  } finally {
    await f.close();
  }
});
test("global reservation race admits exactly one transfer and leaves no nonce for the cap loser", async () => {
  const f = await hostedFixture({ globalCeiling: "35000000000000000" });
  try {
    const a = await enrolled(f, true),
      b = await enrolled(f, true);
    const results = await Promise.all([
      f.post("/initial-topup", a.body),
      f.post("/initial-topup", b.body),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      results.find((r) => r.status === 409)!.body.error,
      "funding_cap_exhausted",
    );
    const loser = results[0]!.status === 409 ? a : b,
      winner = loser === a ? b : a;
    assert.equal(
      (await allOperations(f.db, loser.p.e.id)).filter(
        (o) => o.kind === "topup",
      ).length,
      0,
    );
    await f.mine();
    assert.equal((await f.post("/status", winner.p.auth)).status, 200);
    const ops = await f.db
      .prepare(
        "SELECT receipt,reservation FROM hosted_operations WHERE state='consumed'",
      )
      .all<{ receipt: string; reservation: string }>();
    const expected = ops.results.reduce(
      (n, o) => n + BigInt(o.reservation),
      0n,
    );
    const rows = await f.db
      .prepare("SELECT scope,ceiling,reserved,spent FROM spending_budgets")
      .all<{
        scope: string;
        ceiling: string;
        reserved: string;
        spent: string;
      }>();
    assert.equal(
      BigInt(rows.results.find((x) => x.scope.endsWith(":global"))!.spent),
      expected,
    );
    for (const row of rows.results)
      assert(BigInt(row.reserved) + BigInt(row.spent) <= BigInt(row.ceiling));
    assert.equal(f.state.sendCount, 3);
  } finally {
    await f.close();
  }
});
test("saved original hash mismatch and canonical-chain reorg refuse settlement without resetting reservation", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true);
    const snapshot = await f.rpc("evm_snapshot");
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    const op = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    await f.db
      .prepare("UPDATE hosted_operations SET tx_hash=? WHERE id=?")
      .bind(`0x${"f".repeat(64)}`, op.id)
      .run();
    assert.equal(
      (await f.post("/status", p.auth)).body.error,
      "hosted_original_hash_mismatch",
    );
    await f.db
      .prepare("UPDATE hosted_operations SET tx_hash=? WHERE id=?")
      .bind(op.tx_hash, op.id)
      .run();
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const chargedBefore = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets ORDER BY scope")
      .all();
    await f.rpc("evm_revert", [snapshot]);
    await f.mine();
    const after = await f.post("/status", p.auth);
    assert.equal(after.status, 503);
    assert.equal(f.state.sendCount, 2);
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT reserved,spent FROM spending_budgets ORDER BY scope")
          .all()
      ).results,
      chargedBefore.results,
    );
  } finally {
    await f.close();
  }
});
test("wrong recipient proof and current publisher rotation cannot draw another initial allocation", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f);
    const wrong = structuredClone(body);
    wrong.recipientProofs[0]!.recipient = lower(f.accounts.stranger.address);
    assert.equal(
      (await f.post("/initial-topup", wrong)).body.error,
      "recipient_proof_set_mismatch",
    );
    const controllerClient = (await import("viem")).createWalletClient({
      account: f.accounts.controller,
      chain: (await import("viem/chains")).foundry,
      transport: (await import("viem")).custom({
        request: async ({ method, params }) =>
          f.rpc(method, params as unknown[]),
      }),
    });
    const config = {
      controller: p.e.plan.config.controller,
      publisher: lower(f.accounts.stranger.address),
      operatorPayments: p.e.plan.config.operatorPayments,
      learningRecords: p.e.plan.config.learningRecords,
      sha256Digest: p.e.plan.commitment,
      uri: p.e.plan.uri,
    };
    const hash = await controllerClient.writeContract({
      address: f.directory,
      abi: directoryV3Abi,
      functionName: "configure",
      args: [p.e.plan.profile.communityId, 1n, config],
    });
    await f.local.waitForTransactionReceipt({ hash });
    await f.mine();
    assert.equal(
      (await f.post("/initial-topup", body)).body.error,
      "funding_roles_changed",
    );
    assert.equal(f.state.sendCount, 1);
  } finally {
    await f.close();
  }
});
test("post-dispatch pre-send failure recovers only the stored raw transaction after restart", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true);
    const other = await enrolled(f, true);
    f.state.dropBeforeSend = 1;
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    const old = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    assert.equal(old.attempts, 1);
    assert.equal(f.state.sendCount, 2);
    assert.equal(
      (await f.post("/initial-topup", other.body)).body.error,
      "hosted_sender_nonce_unobserved",
    );
    assert.equal(
      (await allOperations(f.db, other.p.e.id)).filter(
        (o) => o.kind === "topup",
      ).length,
      0,
    );
    f.state.clock += f.policy.broadcastRetrySeconds;
    const restarted = createHostedFundingService(f.runtime);
    assert.equal((await f.post("/initial-topup", body, restarted)).status, 200);
    const sent = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    assert.equal(sent.attempts, 2);
    assert.equal(sent.tx_hash, old.tx_hash);
    assert.equal(sent.raw, old.raw);
    assert.equal(sent.nonce, old.nonce);
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal((await f.post("/initial-topup", other.body)).status, 200);
    await f.mine();
    assert.equal((await f.post("/status", other.p.auth)).status, 200);
    const nonces = await f.db
      .prepare(
        "SELECT nonce FROM hosted_operations WHERE kind='topup' ORDER BY nonce",
      )
      .all<{ nonce: number }>();
    assert.deepEqual(
      nonces.results.map((o) => o.nonce),
      [0, 1],
    );
    assert.equal(f.state.sendCount, 4);
  } finally {
    await f.close();
  }
});
test("historical status uses original policy after fee-policy change while new effects refuse", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true);
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    await f.mine();
    const runtime = {
      ...f.runtime,
      policy: { ...f.policy, maxFeePerGas: "3000000000" },
    };
    assert.equal(
      (await f.post("/status", p.auth, createHostedEnrollmentService(runtime)))
        .status,
      200,
    );
    assert.equal(
      (
        await f.post(
          "/initial-topup",
          body,
          createHostedFundingService(runtime),
        )
      ).body.error,
      "hosted_policy_changed",
    );
    assert.equal(f.state.sendCount, 2);
  } finally {
    await f.close();
  }
});
test("recipient lifetime cap refusal allocates no nonce and a different eligible recipient still funds", async () => {
  const f = await hostedFixture({ recipientCeiling: "25000000000000000" });
  try {
    const a = await enrolled(f, true);
    assert.equal((await f.post("/initial-topup", a.body)).status, 200);
    await f.mine();
    await f.post("/status", a.p.auth);
    const b = await enrolled(f, true);
    assert.equal(
      (await f.post("/initial-topup", b.body)).body.error,
      "funding_cap_exhausted",
    );
    assert.equal(
      (await allOperations(f.db, b.p.e.id)).filter((o) => o.kind === "topup")
        .length,
      0,
    );
    const i = await f.invite({
        controller: f.accounts.publisher.address,
        publisher: f.accounts.publisher.address,
      }),
      p = await f.prepare(i, f.accounts.publisher);
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    await f.mine();
    const proof = await f.accounts.publisher.signTypedData(
      enrollmentTypedData(p.e),
    );
    assert.equal(
      (
        await f.post("/initial-topup", {
          ...p.auth,
          recipientProofs: [
            {
              recipient: lower(f.accounts.publisher.address),
              signature: proof,
            },
          ],
        })
      ).status,
      200,
    );
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const operations = await f.db
      .prepare(
        "SELECT nonce FROM hosted_operations WHERE kind='topup' ORDER BY nonce",
      )
      .all<{ nonce: number }>();
    assert.deepEqual(
      operations.results.map((o) => o.nonce),
      [0, 1],
    );
  } finally {
    await f.close();
  }
});
test("community lifetime cap covers registration and transfer principal together", async () => {
  const f = await hostedFixture({ communityCeiling: "15000000000000000" });
  try {
    const { p, body } = await enrolled(f, true);
    assert.equal(
      (await f.post("/initial-topup", body)).body.error,
      "funding_cap_exhausted",
    );
    assert.equal(f.state.sendCount, 1);
    assert.equal(
      (await allOperations(f.db, p.e.id)).filter((o) => o.kind === "topup")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});
test("storage failure after canonical receipt keeps the full reservation and cannot resend the terminal original", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true);
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    await f.mine();
    const op = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    // Real SQLite transaction failure, not a fake budget or chain implementation.
    await f.db
      .prepare(
        "CREATE TRIGGER fail_settlement BEFORE UPDATE ON spending_budgets WHEN NEW.spent <> OLD.spent BEGIN SELECT RAISE(ABORT,'fixture_storage_fault'); END",
      )
      .run();
    const { reconcileHostedOperation } = await import(
      "../packages/community/hosted-topup-chain.ts"
    );
    await assert.rejects(
      reconcileHostedOperation(f.runtime, p.e, op),
      /fixture_storage_fault/,
    );
    const terminal = (await allOperations(f.db, p.e.id)).find(
      (o) => o.kind === "topup",
    )!;
    assert.equal(terminal.state, "consumed");
    const held = await f.db
      .prepare(
        "SELECT status,amount FROM spending_reservations WHERE reservation_id=?",
      )
      .bind(op.id)
      .all<{ status: string; amount: string }>();
    assert.equal(held.results.length, 3);
    assert(
      held.results.every(
        (x) => x.status === "reserved" && x.amount === op.reservation,
      ),
    );
    await f.db.prepare("DROP TRIGGER fail_settlement").run();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    assert.equal(f.state.sendCount, 2);
    const settled = await f.db
      .prepare(
        "SELECT status FROM spending_reservations WHERE reservation_id=?",
      )
      .bind(op.id)
      .all<{ status: string }>();
    assert(settled.results.every((x) => x.status === "settled"));
  } finally {
    await f.close();
  }
});
test("same database cannot reset lifetime global or recipient budgets by changing pilot configuration", async () => {
  const f = await hostedFixture();
  try {
    const { p, body } = await enrolled(f, true);
    assert.equal((await f.post("/initial-topup", body)).status, 200);
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const original = await f.db
      .prepare("SELECT * FROM spending_budgets ORDER BY scope")
      .all();
    const { provisionHostedInvite } = await import(
      "../packages/community/hosted-enrollment-store.ts"
    );
    const { publicId, token } = await import("../packages/community/common.ts");
    const altered = { ...f.policy, pilotId: "accidental-reset" };
    await assert.rejects(
      provisionHostedInvite(
        f.db,
        altered,
        {
          id: publicId(),
          token: token(),
          allowanceId: publicId(),
          expiresAt: f.state.clock + 1000,
        },
        f.state.clock,
      ),
      /CHECK constraint failed/,
    );
    const response = await f.post(
      "/initial-topup",
      body,
      createHostedFundingService({ ...f.runtime, policy: altered }),
    );
    assert.equal(response.body.error, "hosted_budget_namespace_changed");
    assert.deepEqual(
      (
        await f.db
          .prepare("SELECT * FROM spending_budgets ORDER BY scope")
          .all()
      ).results,
      original.results,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT budget_namespace FROM hosted_schema")
        .first<{ budget_namespace: string }>())!.budget_namespace,
      f.policy.pilotId,
    );
    assert.equal(f.state.sendCount, 2);
  } finally {
    await f.close();
  }
});
