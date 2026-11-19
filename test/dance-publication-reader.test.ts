/** Real Miniflare D1 + production protocol/reader/store;
 * RPC bytes are explicitly scripted observations, not chain/provider proof. */
import test from "node:test";
import assert from "node:assert/strict";
import { canonical, CommunityError } from "../packages/community/common.ts";
import { readDancePublicationAdmission, resolveDancePublication } from "../services/dance-publication-reader.ts";
import type { ConsentCommandReceiptV1, PreparedConsentCommandV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { hex, publicationReaderFixture, waitForRealD1Expiry, type Lease } from "./dance-publication-reader-fixture.ts";

type Fixture = Awaited<ReturnType<typeof publicationReaderFixture>>;
const denied = (code: string, status = 403) => (error: unknown) =>
  error instanceof CommunityError && error.code === code && error.status === status;
async function reached(gate: { entered: Promise<void> }, result: Promise<unknown>) {
  await Promise.race([gate.entered, result.then(() => assert.fail("read finished before the scripted boundary"))]);
}
async function accept(f: Fixture, fences: Awaited<ReturnType<typeof readDancePublicationAdmission>>["fences"], id: string) {
  await f.store.atomic(fences, [
    f.db.prepare("INSERT INTO publication_test_acceptance VALUES(?)").bind(id), f.store.changed(),
  ]);
}
function receipt(command: PreparedConsentCommandV1, state: ConsentCommandReceiptV1["state"]): ConsentCommandReceiptV1 {
  const common = { schema: "pirate.publication-command-receipt/1" as const,
    commandId: command.commandId, digest: command.digest, action: command.action,
    purpose: command.message.purpose, source: structuredClone(command.source), transactionHash: null };
  if (state === "recorded" || state === "reverted") return { ...common, state, transactionHash: hex(60),
    observed: { blockNumber: "50", blockHash: hex(40), timestampS: String(BigInt(command.preparedAtMs) / 1000n) }, transactionIndex: 0 };
  if (state === "withheld" || state === "refused") return { ...common, state, reason: "retained-original-outcome" };
  return { ...common, state };
}

test("V2 reader uses original ABI grant/account bindings and real D1 acceptance for capture, owner and delegate", async t => {
  for (const kind of ["capture", "owner", "delegate"] as const) {
    const f = await publicationReaderFixture({ ownerReviewer: kind === "owner" });
    try {
      const input = kind === "capture" ? { ...f.fresh, original: {
        kind: "capture" as const, capture: f.capture, learner: f.learner,
      } } : f.fresh;
      const original = structuredClone(input.original);
      const result = await readDancePublicationAdmission(input);
      assert.equal(result.kind, "canonical-read/2");
      assert.deepEqual(input.original, original);
      assert.equal(result.observations.length, kind === "capture" ? 1 : 2);
      await accept(f, result.fences, kind);
      assert.deepEqual(await f.accepted(), [{ id: kind }]);
      assert.equal(await f.guards(), 0);
      t.diagnostic(JSON.stringify({ artifact: "pirate.dance-publication-admission/1", mode: kind,
        sourceHash: result.sourceHash, captureHash: result.captureHash,
        originalGrantIds: result.observations.map(o => o.binding.grantId),
        blockNumber: String(result.anchor.number), blockHash: result.anchor.hash,
        accepted: await f.accepted(), broadcasts: 0 }));
    } finally { await f.close(); }
  }
});

test("held ownerContext and final source-anchor reads cannot admit a context expired after the safe block", async () => {
  for (const key of ["call:ownerContext", "block:finish"]) {
    const f = await publicationReaderFixture({ lease: "owner" });
    const gate = f.holdRead(key);
    try {
      const original = structuredClone(f.fresh.original);
      const pending = readDancePublicationAdmission(f.fresh);
      await reached(gate, pending);
      assert.ok(f.base < f.expires("owner"));
      f.state.now = f.expires("owner") + 5n; // Anchor remains valid/fresh, owner does not.
      gate.release();
      await assert.rejects(pending, denied("dance_owner_context_expired"));
      assert.deepEqual(f.fresh.original, original);
      assert.deepEqual(await f.accepted(), []);
      assert.equal(await f.guards(), 0);
    } finally { gate.release(); await f.close(); }
  }
});

test("held delegated reviewer role read rechecks current exclusive expiry without retargeting the original review", async () => {
  const f = await publicationReaderFixture({ lease: "reviewer" });
  const gate = f.holdRead("call:reviewerRoles");
  try {
    const original = structuredClone(f.fresh.original);
    const pending = readDancePublicationAdmission(f.fresh);
    await reached(gate, pending);
    f.state.now = f.expires("reviewer");
    gate.release();
    await assert.rejects(pending, denied("dance_publication_lease_expired"));
    assert.deepEqual(f.fresh.original, original);
    assert.deepEqual(await f.accepted(), []);
    assert.equal(await f.guards(), 0);
  } finally { gate.release(); await f.close(); }
});

test("held checkGrant, purpose and grantOf cannot reuse anchor-time learner or reviewer permission after expiry", async () => {
  for (const lease of ["learner-grant", "reviewer-grant"] as const) {
    for (const method of ["checkGrant", "purpose", "grantOf"]) {
      const purpose = lease === "learner-grant" ? "dance-verdict" : "dance-review-attribution";
      const f = await publicationReaderFixture({ lease }), gate = f.holdRead("grant:" + method + ":" + purpose);
      try {
        const originals = structuredClone([f.learner.binding, f.reviewer.binding]);
        const pending = readDancePublicationAdmission(f.fresh);
        await reached(gate, pending);
        f.state.now = f.expires(lease);
        gate.release();
        await assert.rejects(pending, denied("dance_publication_lease_expired"));
        assert.deepEqual([f.learner.binding, f.reviewer.binding], originals);
        assert.deepEqual(await f.accepted(), []);
        assert.equal(await f.guards(), 0);
      } finally { gate.release(); await f.close(); }
    }
  }
});

test("final awaited anchor reconciliation rechecks all previously established grant lease windows", async () => {
  const f = await publicationReaderFixture({ lease: "learner-grant" });
  const gate = f.holdRead("block:finish", 2);
  try {
    const pending = readDancePublicationAdmission(f.fresh);
    await reached(gate, pending);
    assert.ok(f.state.reads.includes("grant:grantOf:dance-review-attribution"));
    f.state.now = f.expires("learner-grant");
    gate.release();
    await assert.rejects(pending, denied("dance_publication_lease_expired"));
    assert.deepEqual(await f.accepted(), []);
    assert.equal(await f.guards(), 0);
  } finally { gate.release(); await f.close(); }
});

test("owner, delegate and each grant remain fenced by the actual D1 clock in the held accepting mutation batch", async () => {
  for (const lease of ["owner", "reviewer", "learner-grant", "reviewer-grant"] satisfies Lease[]) {
    const f = await publicationReaderFixture({ lease, ttl: 8n });
    let gate: ReturnType<Fixture["holdNextBatch"]> | undefined;
    try {
      const result = await readDancePublicationAdmission(f.fresh);
      const expiryMs = Number(f.expires(lease) * 1000n), frozenNow = f.state.now;
      assert.equal(result.expiresAtMs, expiryMs);
      const bindings = (await f.native.prepare("SELECT * FROM publication_test_bindings ORDER BY account_id").all()).results;
      const permissions = (await f.native.prepare("SELECT * FROM publication_test_permissions ORDER BY account_id").all()).results;
      await accept(f, result.fences, "before-expiry");
      assert.deepEqual(await f.accepted(), [{ id: "before-expiry" }]);
      gate = f.holdNextBatch();
      const pending = accept(f, result.fences, "must-not-commit-after-expiry");
      // Attach before release so a native rejection can never become unhandled.
      const rejected = assert.rejects(pending, denied("dance_fence_changed", 409));
      await gate.entered;
      const dbNow = await waitForRealD1Expiry(f.native as unknown as D1Database, expiryMs);
      assert.ok(dbNow >= expiryMs);
      assert.equal(f.state.now, frozenNow, "trusted read clock remains pre-expiry; SQL must independently refuse");
      gate.release();
      await rejected;
      assert.deepEqual(await f.accepted(), [{ id: "before-expiry" }]);
      assert.equal(await f.guards(), 0, "all earlier guards in the same failed batch roll back");
      assert.deepEqual((await f.native.prepare("SELECT * FROM publication_test_bindings ORDER BY account_id").all()).results, bindings);
      assert.deepEqual((await f.native.prepare("SELECT * FROM publication_test_permissions ORDER BY account_id").all()).results, permissions);
    } finally { gate?.release(); await f.close(); }
  }
});

test("V2 reader caps the deadline at the exclusive safe-head freshness boundary", async () => {
  const f = await publicationReaderFixture();
  try {
    const maxSafeBlockAgeSeconds = 1n;
    const result = await readDancePublicationAdmission({
      ...f.fresh, clock: { ...f.fresh.clock, maxSafeBlockAgeSeconds },
    });
    assert.equal(result.expiresAtMs, Number((result.anchor.timestamp + maxSafeBlockAgeSeconds + 1n) * 1000n));
  } finally {
    await f.close();
  }
});

test("unchanged current time immediately below expiry is distinct from the exact exclusive grant boundary", async () => {
  const f = await publicationReaderFixture({ lease: "reviewer-grant" });
  try {
    f.state.now = f.expires("reviewer-grant") - 1n;
    const before = await readDancePublicationAdmission(f.fresh);
    assert.equal(before.observations[1].binding.grantId, f.reviewer.binding.grantId);
    f.state.now = f.expires("reviewer-grant");
    await assert.rejects(readDancePublicationAdmission(f.fresh), denied("dance_publication_lease_expired"));
    assert.deepEqual(await f.accepted(), []);
    assert.equal(await f.guards(), 0);
  } finally { await f.close(); }
});

test("reconciliation callback cannot mutate its clone and return a matching retargeted receipt", async () => {
  const f = await publicationReaderFixture();
  try {
    const command = await f.command(), original = structuredClone(command);
    await f.retain(command, receipt(command, "unknown"));
    const rows = await f.originals();
    for (const mutate of [
      (c: PreparedConsentCommandV1) => { Object.assign(c, { commandId: hex(61), digest: hex(62) }); },
      (c: PreparedConsentCommandV1) => { Object.assign(c.source, { registry: "0x0000000000000000000000000000000000000063" }); },
      (c: PreparedConsentCommandV1) => { Object.assign(c.message, { nonce: hex(64) }); },
    ]) {
      let supplied: PreparedConsentCommandV1 | undefined;
      await assert.rejects(resolveDancePublication({ originalCommand: command, journal: {
        ...f.journal, async reconcileOriginal(c) {
          assert.notEqual(c, command); assert.notEqual(c.source, command.source); assert.notEqual(c.message, command.message);
          supplied = c; mutate(c); return receipt(c, "recorded");
        },
      } }), denied("dance_publication_command_mutated", 503));
      assert.ok(supplied);
      assert.deepEqual(command, original);
      assert.deepEqual(await f.originals(), rows);
    }
    assert.equal(f.state.fenceReads, 0);
    assert.deepEqual(f.state.reads, []);
  } finally { await f.close(); }
});

test("an unchanged callback command still requires an exact original receipt identity, source, action and purpose", async () => {
  const f = await publicationReaderFixture();
  try {
    const command = await f.command(), original = canonical(command), retained = receipt(command, "pending");
    await f.retain(command, retained); const rows = await f.originals();
    for (const changed of [
      { commandId: hex(65) }, { digest: hex(66) }, { action: "withdraw" as const },
      { purpose: "dance-review-attribution" as const },
      { source: { ...command.source, registry: "0x0000000000000000000000000000000000000067" as const } },
    ]) {
      await assert.rejects(resolveDancePublication({ originalCommand: command, journal: {
        ...f.journal, async reconcileOriginal(c) {
          assert.equal(canonical(c), original); return { ...retained, ...changed };
        },
      } }), denied("dance_publication_receipt_mismatch", 503));
      assert.equal(canonical(command), original);
      assert.deepEqual(await f.originals(), rows);
    }
    assert.equal(f.state.fenceReads, 0); assert.deepEqual(f.state.reads, []);
  } finally { await f.close(); }
});

test("original grant and withdrawal outcomes reconcile first after local withdrawal, expiry, disablement and registry replacement", async () => {
  const f = await publicationReaderFixture();
  try {
    f.state.grantsDisabled = true; f.state.registryReplaced = true;
    f.state.now = f.base + 10000n;
    f.fresh.clock.now = () => { throw Error("recovery must not sample current eligibility"); };
    await f.db.prepare("UPDATE publication_test_permissions SET generation='5',denied=1").run();
    for (const action of ["grant", "withdraw"] as const) {
      const command = await f.command(action), original = structuredClone(command);
      for (const state of ["prepared", "queued", "pending", "unknown", "withheld", "refused", "recorded", "reverted"] as const) {
        const retained = receipt(command, state); await f.retain(command, retained);
        const rows = await f.originals(), result = await resolveDancePublication({
          originalCommand: command, journal: { ...f.journal,
            acceptanceFences() { throw Error("recovery must not request a new permission"); },
          },
        });
        assert.equal(result.kind, "original-command");
        assert.deepEqual(result.original, original); assert.deepEqual(result.receipt, retained);
        assert.deepEqual(command, original); assert.deepEqual(await f.originals(), rows);
      }
    }
    assert.equal(f.state.receiptReads, 16); assert.equal(f.state.fenceReads, 0);
    assert.deepEqual(f.state.reads, [], "no fresh registry/source RPC and no broadcast");
    assert.deepEqual(await f.accepted(), []); assert.equal(await f.guards(), 0);
  } finally { await f.close(); }
});

test("original binding and current purpose-generation predicates are enforced in the same actual accepting batch", async () => {
  const f = await publicationReaderFixture();
  try {
    const result = await readDancePublicationAdmission(f.fresh);
    await accept(f, result.fences, "original-valid");
    await f.db.prepare("UPDATE publication_test_permissions SET generation='5',denied=1 WHERE account_id=? AND purpose=?")
      .bind(f.learner.accountId, f.learner.binding.grant.purpose).run();
    await assert.rejects(accept(f, result.fences, "must-not-use-withdrawn-generation"), denied("dance_fence_changed", 409));
    assert.deepEqual(await f.accepted(), [{ id: "original-valid" }]);
    assert.equal(await f.guards(), 0);
  } finally { await f.close(); }
});

test("a safe block behind actual capture time waits without changing the original, then admits that same capture", async () => {
  const f = await publicationReaderFixture({ startOffset: 2n });
  try {
    const original = structuredClone(f.fresh.original);
    const bindings = (await f.native.prepare("SELECT * FROM publication_test_bindings ORDER BY account_id").all()).results;
    await assert.rejects(readDancePublicationAdmission(f.fresh),
      denied("dance_publication_observation_pending", 503));
    assert.deepEqual(f.fresh.original, original);
    assert.deepEqual((await f.native.prepare("SELECT * FROM publication_test_bindings ORDER BY account_id").all()).results, bindings);
    assert.deepEqual(await f.accepted(), []);
    f.advanceSafe(f.startedAt);
    await waitForRealD1Expiry(f.native as unknown as D1Database, Number(f.startedAt * 1000n));
    const admitted = await readDancePublicationAdmission(f.fresh);
    assert.equal(admitted.observations[0].binding.boundAtS, String(f.startedAt));
    assert.deepEqual(f.fresh.original, original);
    await accept(f, admitted.fences, "same-original-after-safe-advance");
    assert.deepEqual(await f.accepted(), [{ id: "same-original-after-safe-advance" }]);
    assert.equal(await f.guards(), 0);
  } finally { await f.close(); }
});

test("a start later than trusted current time is rejected rather than queued as ordinary safe-block lag", async () => {
  const f = await publicationReaderFixture({ startOffset: 2n });
  try {
    f.state.now = f.base;
    await assert.rejects(readDancePublicationAdmission(f.fresh),
      denied("dance_publication_original_changed", 403));
    assert.deepEqual(await f.accepted(), []);
    assert.equal(await f.guards(), 0);
  } finally { await f.close(); }
});
