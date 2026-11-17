import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { pilotExecutionFixture } from "./fixtures/pilot-eip1559.ts";

type Fixture = Awaited<ReturnType<typeof pilotExecutionFixture>>;
const bounded = { timeout: 30000 };
async function scenario(
  t: TestContext,
  label: string,
  work: (f: Fixture) => Promise<void>,
) {
  const f = await pilotExecutionFixture(t);
  try {
    await work(f);
  } finally {
    await f.artifact(label);
  }
}
test(
  "exact signed type2 original is durable before first send and survives restart",
  bounded,
  async (t) =>
    scenario(t, "pilot-durable-original", async (f) => {
      const first = await f.runner().prepare(0, f.signer);
      assert.equal(first.phase, "signed");
      assert.ok(first.raw?.startsWith("0x02"));
      assert.equal(f.sent.length, 0);
      await f.restart();
      const retained = f.journal().snapshot().records[0];
      assert.equal(retained.raw, first.raw);
      assert.equal(retained.hash, first.hash);
      await f.runner().prepare(0, f.signer);
      assert.equal(f.signCalls(), 1);
      await f.runner().broadcast(0);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0], first.raw);
      assert.equal(f.beforeSendSnapshots[0].records[0].raw, first.raw);
      assert.equal(f.beforeSendSnapshots[0].records[0].phase, "attempted");
    }),
);
test(
  "lost managed signer response holds the captured original without another signature",
  bounded,
  async (t) =>
    scenario(t, "pilot-signing-unknown", async (f) => {
      f.loseSignerResponse();
      await assert.rejects(f.runner().prepare(0, f.signer));
      assert.equal(f.journal().snapshot().records[0].phase, "signing");
      await f.restart();
      await assert.rejects(f.runner().prepare(0, f.signer), /signing_unknown/);
      await assert.rejects(f.runner().broadcast(0));
      assert.equal(f.signCalls(), 1);
      assert.equal(f.sent.length, 0);
    }),
);
test(
  "lost send ACK and missing original receipt never cause a second broadcast or nonce",
  bounded,
  async (t) =>
    scenario(t, "pilot-send-unknown", async (f) => {
      const original = await f.runner().prepare(0, f.signer);
      f.loseSendResponse();
      await f.runner().broadcast(0);
      await f.restart();
      await f.runner().broadcast(0);
      await f.runner().reconcile(0);
      assert.equal(f.sent.length, 1);
      assert.equal(f.signCalls(), 1);
      assert.equal(f.journal().snapshot().records[0].raw, original.raw);
      assert.equal(f.journal().snapshot().records[0].phase, "unknown");
      await assert.rejects(f.runner().prepare(1, f.signer));
      assert.equal(f.signCalls(), 1);
    }),
);
test(
  "funding above fuse or observed credit refuses signing/broadcast without a refill path",
  bounded,
  async (t) =>
    scenario(t, "pilot-funding-fuse", async (f) => {
      f.balance(f.cap() + 1n);
      await assert.rejects(f.runner().prepare(0, f.signer), /funding/);
      assert.equal(f.signCalls(), 0);
      f.balance(f.cap());
      const original = await f.runner().prepare(0, f.signer);
      f.balance(f.cap() + 1n);
      await assert.rejects(f.runner().broadcast(0), /balance|funding/);
      assert.equal(f.sent.length, 0);
      assert.equal(f.journal().snapshot().records[0].raw, original.raw);
    }),
);
test(
  "canonical original recovery verifies exact transaction/runtime/getters before next step",
  bounded,
  async (t) =>
    scenario(t, "pilot-original-receipt", async (f) => {
      const original = await f.runner().prepare(0, f.signer);
      await f.runner().broadcast(0);
      f.mine(0);
      const confirmed = await f.runner().reconcile(0);
      assert.equal(confirmed.phase, "confirmed");
      assert.equal(confirmed.hash, original.hash);
      assert.equal(confirmed.raw, original.raw);
      const next = await f.runner().prepare(1, f.signer);
      assert.equal(next.nonce, 1);
      assert.equal(f.signCalls(), 2);
      assert.equal(f.sent.length, 1);
    }),
);
test(
  "wrong runtime or reorg retains the original and holds later signing",
  bounded,
  async (t) =>
    scenario(t, "pilot-runtime-reorg-hold", async (f) => {
      const original = await f.runner().prepare(0, f.signer);
      await f.runner().broadcast(0);
      f.mine(0);
      f.wrongCode(true);
      await f.runner().reconcile(0);
      assert.equal(f.journal().snapshot().records[0].phase, "unknown");
      await assert.rejects(f.runner().prepare(1, f.signer));
      assert.equal(f.signCalls(), 1);
      f.wrongCode(false);
      await f.runner().reconcile(0);
      f.reorg(true);
      await f.runner().reconcile(0);
      assert.equal(f.journal().snapshot().records[0].phase, "unknown");
      assert.equal(f.journal().snapshot().records[0].raw, original.raw);
      assert.equal(f.sent.length, 1);
    }),
);
test(
  "four fixed operations complete in order with no fifth or oracle-quote refund",
  bounded,
  async (t) =>
    scenario(t, "pilot-four-only", async (f) => {
      for (let index = 0; index < 4; index++) {
        const row = await f.runner().prepare(index, f.signer);
        assert.equal(row.nonce, index);
        await f.runner().broadcast(index);
        f.mine(index);
        assert.equal((await f.runner().reconcile(index)).phase, "confirmed");
      }
      await assert.rejects(f.runner().prepare(4, f.signer));
      const snapshot = f.journal().snapshot();
      assert.equal(snapshot.records.length, 4);
      assert.equal(snapshot.fundingReservedWei, String(f.cap()));
      assert.equal(f.signCalls(), 4);
      assert.equal(f.sent.length, 4);
      assert.ok(snapshot.records.every((r) => r.raw?.startsWith("0x02")));
    }),
);

async function windowScenario(
  t: TestContext,
  label: string,
  window: NonNullable<Parameters<typeof pilotExecutionFixture>[1]>,
  work: (f: Fixture) => Promise<void>,
) {
  const f = await pilotExecutionFixture(t, window);
  try {
    await work(f);
  } finally {
    await f.artifact(label);
  }
}
test(
  "first broadcast recertifies prior originals despite matching current code/getters",
  bounded,
  async (t) => {
    for (const fault of ["missing", "contradictory"] as const)
      await t.test(fault, async (t) =>
        scenario(t, "pilot-prior-receipt-" + fault, async (f) => {
          await f.runner().prepare(0, f.signer);
          await f.runner().broadcast(0);
          f.mine(0);
          assert.equal((await f.runner().reconcile(0)).phase, "confirmed");
          const next = await f.runner().prepare(1, f.signer);
          if (fault === "missing") f.receiptMissing(0);
          else f.receiptContradiction(0);
          await assert.rejects(
            f.runner().broadcast(1),
            /prior_original_unresolved/,
          );
          const retained = f.journal().snapshot().records[1]!;
          assert.equal(f.sent.length, 1);
          assert.equal(f.signCalls(), 2);
          assert.equal(retained.raw, next.raw);
          assert.equal(retained.hash, next.hash);
          assert.equal(retained.phase, "signed");
          assert.equal(retained.dispatch, "never-attempted");
        }),
      );
  },
);
test(
  "expired or too-near exact registrar child plan holds before the first signature",
  bounded,
  async (t) => {
    for (const [label, remaining] of [
      ["expired", -1n],
      ["too-near", 29n],
    ] as const)
      await t.test(label, async (t) =>
        windowScenario(
          t,
          "pilot-registrar-" + label,
          {
            registrarRemainingSeconds: remaining,
            minRegistrarRemainingSeconds: 30n,
          },
          async (f) => {
            assert.ok(f.clockMs() < f.deadlineMs());
            await assert.rejects(
              f.runner().prepare(0, f.signer),
              /registrar_window_stale/,
            );
            assert.equal(f.signCalls(), 0);
            assert.equal(f.sent.length, 0);
            assert.equal(f.journal().snapshot().records.length, 0);
          },
        ),
      );
  },
);
test(
  "safe age expiring across the real signing-intent write prevents a signature",
  bounded,
  async (t) =>
    scenario(t, "pilot-safe-age-signing-write", async (f) => {
      f.advanceAfterWrite("beginSigning", 901000);
      await assert.rejects(f.runner().prepare(0, f.signer), /safe_stale/);
      assert.ok(f.clockMs() < f.deadlineMs());
      assert.equal(f.signCalls(), 0);
      assert.equal(f.sent.length, 0);
      const row = f.journal().snapshot().records[0]!;
      assert.equal(row.phase, "signing");
      assert.equal(row.raw, null);
      await f.restart();
      await assert.rejects(f.runner().prepare(0, f.signer), /signing_unknown/);
      assert.equal(f.signCalls(), 0);
    }),
);
test(
  "registrar margin expiring across the real signing-intent write prevents a signature",
  bounded,
  async (t) =>
    windowScenario(
      t,
      "pilot-registrar-signing-write",
      { registrarRemainingSeconds: 31n, minRegistrarRemainingSeconds: 30n },
      async (f) => {
        f.advanceAfterWrite("beginSigning", 2000);
        await assert.rejects(
          f.runner().prepare(0, f.signer),
          /registrar_window_stale/,
        );
        assert.ok(f.clockMs() < f.deadlineMs());
        assert.equal(f.signCalls(), 0);
        assert.equal(f.sent.length, 0);
        assert.equal(f.journal().snapshot().records[0]!.phase, "signing");
      },
    ),
);
test(
  "safe age expiring across the real attempt write prevents send and remains non-resendable",
  bounded,
  async (t) =>
    scenario(t, "pilot-safe-age-attempt-write", async (f) => {
      const original = await f.runner().prepare(0, f.signer);
      f.advanceAfterWrite("attempted", 901000);
      await assert.rejects(f.runner().broadcast(0), /safe_stale/);
      assert.ok(f.clockMs() < f.deadlineMs());
      assert.equal(f.sent.length, 0);
      assert.equal(f.signCalls(), 1);
      const row = f.journal().snapshot().records[0]!;
      assert.equal(row.raw, original.raw);
      assert.equal(row.phase, "attempted");
      assert.equal(row.dispatch, "attempted");
      await f.restart();
      await f.runner().broadcast(0);
      assert.equal(f.sent.length, 0);
      assert.equal(f.journal().snapshot().records[0]!.dispatch, "attempted");
    }),
);
test(
  "registrar margin expiring across the real attempt write prevents send",
  bounded,
  async (t) =>
    windowScenario(
      t,
      "pilot-registrar-attempt-write",
      { registrarRemainingSeconds: 31n, minRegistrarRemainingSeconds: 30n },
      async (f) => {
        const original = await f.runner().prepare(0, f.signer);
        f.advanceAfterWrite("attempted", 2000);
        await assert.rejects(f.runner().broadcast(0), /registrar_window_stale/);
        assert.ok(f.clockMs() < f.deadlineMs());
        assert.equal(f.sent.length, 0);
        assert.equal(f.signCalls(), 1);
        const row = f.journal().snapshot().records[0]!;
        assert.equal(row.raw, original.raw);
        assert.equal(row.hash, original.hash);
        assert.equal(row.dispatch, "attempted");
        await f.runner().broadcast(0);
        assert.equal(f.sent.length, 0);
      },
    ),
);
test(
  "absent receipt for a retained signed never-attempted original preserves exactly one first send",
  bounded,
  async (t) =>
    scenario(t, "pilot-signed-unattempted-first-send", async (f) => {
      const original = await f.runner().prepare(0, f.signer);
      await f.restart();
      const read = await f.runner().reconcile(0);
      assert.equal(read.phase, "signed");
      assert.equal(read.dispatch, "never-attempted");
      assert.equal(read.raw, original.raw);
      assert.equal(read.hash, original.hash);
      await f.runner().broadcast(0);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0], original.raw);
      assert.equal(f.beforeSendSnapshots[0]!.records[0]!.dispatch, "attempted");
      await f.restart();
      await f.runner().broadcast(0);
      await f.runner().reconcile(0);
      assert.equal(f.sent.length, 1);
      assert.equal(f.signCalls(), 1);
      assert.equal(f.journal().snapshot().records[0]!.dispatch, "attempted");
    }),
);
