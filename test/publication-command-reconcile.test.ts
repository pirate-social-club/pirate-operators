import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePublicationCommand } from "../services/publication-command-reconcile.ts";
import { commandId } from "../services/publication-command-contract.ts";
import { inhibitPublication } from "../services/publication-command-operator.ts";
import { digest } from "../packages/protocol/index.ts";
import { publicationCommandFixture, receiptHashA, receiptHashB, safeHashB } from "./fixtures/publication-command.ts";

test("original reverted receipt remains readable without current fee admission or a send", async t => {
  const f = await publicationCommandFixture(t), rpc = f.scripted();
  const result = await reconcilePublicationCommand(f.store, f.command.commandId, rpc.read);
  assert.equal(result.state, "reverted");
  assert.equal(result.transactionHash, f.hash);
  assert.equal(f.row().mined?.status, "reverted");
  assert.ok(rpc.calls.every(c => !["eth_sendRawTransaction", "eth_estimateGas", "eth_gasPrice", "eth_call"].includes(c.method)));
});

test("missing safe hash and null canonical recheck cannot confirm an original receipt", async t => {
  const f = await publicationCommandFixture(t);
  const rpc = f.scripted({ omitSafeHash: true, nullSafeAgain: true });
  await assert.rejects(reconcilePublicationCommand(f.store, f.command.commandId, rpc.read),
    /publication_/);
  assert.equal(f.row().publicationReceipt, undefined);
  assert.equal(f.row().mined, null);
});

test("a successful transaction without the exact generated consent event is never recorded", async t => {
  const f = await publicationCommandFixture(t), rpc = f.scripted({ status: "0x1" });
  await assert.rejects(reconcilePublicationCommand(f.store, f.command.commandId, rpc.read),
    /publication_event_missing_or_ambiguous/);
  const code = rpc.calls.find(c => c.method === "eth_getCode");
  assert.ok(code);
  assert.deepEqual(code.params[1], { blockHash: receiptHashA, requireCanonical: true });
  assert.equal(f.row().publicationReceipt, undefined);
});

test("a held pre-reorg reconciliation cannot replace the newer canonical disposition", async t => {
  const f = await publicationCommandFixture(t);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const old = f.scripted({ beforeFinalBlock: async () => { reached(); await held; } });
  const pending = reconcilePublicationCommand(f.store, f.command.commandId, old.read);
  // Ensure an early failure cannot become an unhandled rejection or hang setup.
  const checked = pending.then(value => ({ value }), error => ({ error }));
  await Promise.race([entered, checked.then(result => {
    if ("error" in result) throw result.error;
    throw Error("old reconciliation completed before the held header");
  })]);
  const current = f.scripted({ blockHash: receiptHashB, safeHash: safeHashB });
  await reconcilePublicationCommand(f.store, f.command.commandId, current.read);
  const latest = structuredClone(f.row());
  assert.equal(latest.publicationReceipt?.blockHash, receiptHashB);
  release();
  const result = await checked;
  assert.ok("error" in result, "stale reconciliation must refuse its old disposition");
  assert.deepEqual(f.row(), latest);
});

test("the exact original grant event remains historical after a local withdrawal and a reorg removes confirmation", async t => {
  const f = await publicationCommandFixture(t);
  const { source, accountId } = f.command;
  const requestId = "withdraw-after-original";
  const id = commandId({ source, accountId, requestId, action: "withdraw", purpose: "study-results" });
  inhibitPublication(f.store, { schema: "pirate.publication-inhibition/1", commandId: id,
    accountId, requestId, source, learner: f.command.message.learner,
    purpose: "study-results", generation: "1", requestHash: digest("local-withdrawal") },
    { source, issuer: f.command.message.learner, operator: f.job.fee.payer });
  const original = f.scripted({ status: "0x1", grantEvent: true });
  const recorded = await reconcilePublicationCommand(f.store, f.command.commandId, original.read);
  assert.equal(recorded.state, "recorded");
  assert.equal(recorded.transactionHash, f.hash);
  assert.equal(f.row().publicationReceipt?.state, "recorded");
  assert.ok(original.calls.every(c => !/eth_call|send|gasPrice|estimateGas/.test(c.method)));
  const prior = f.row();
  const reorg = f.scripted({ noReceipt: true, blockHash: receiptHashB });
  const unknown = await reconcilePublicationCommand(f.store, f.command.commandId, reorg.read);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.transactionHash, f.hash);
  assert.equal(f.row().publicationReceipt, undefined);
  for (const key of ["raw", "hash", "nonce"] as const) assert.equal(f.row()[key], prior[key]);
  const evidence = f.store.entries("publicationV1Observation:");
  assert.equal(evidence.length, 2);
  assert.equal(f.store.get<number>("op:nonce"), 1);
});

test("an event for another grant cannot establish consumption of this original command", async t => {
  const f = await publicationCommandFixture(t);
  const rpc = f.scripted({ status: "0x1", grantEvent: true, grantId: digest("different-grant") });
  await assert.rejects(reconcilePublicationCommand(f.store, f.command.commandId, rpc.read),
    /publication_grant_event_changed/);
  assert.equal(f.row().publicationReceipt, undefined);
});
