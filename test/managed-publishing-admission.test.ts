// Tests authored before production bodies. SOURCE ONLY; every case UNRUN.
import assert from "node:assert/strict";
import test from "node:test";
import { managedServicesFixture } from "./fixtures/managed-first-song-services.ts";
import { hashJson, hashText } from "../packages/community/common.ts";
import { reserveOwnerBudget, settleOwnerBudget } from "../packages/release/owner-grant.ts";

test("HTTP/D1 immutable prepare, attachment lost reply and restart retain the exact original", async () => {
  const f = await managedServicesFixture();
  try {
    const a = await f.prepare();
    assert.equal(a.status, 200, await a.clone().text());
    const selection = await a.json();
    assert.deepEqual(await (await f.prepare()).json(), selection);
    f.loseReply("attach");
    await assert.rejects(f.attach());
    await f.restart();
    const retained = await (await f.reconcile()).json();
    assert.equal(retained.state, "attached");
    assert.equal(retained.selectionDigest, f.selection.selectionDigest);
    assert.equal(retained.admissionReference, f.registration.admissionReference);
    assert.equal(retained.grantDigest, f.registration.grant.sha256);
    assert.deepEqual(await (await f.prepare()).json(), selection);
    assert.equal((await f.rows()).length, 1);
    const health = await f.ownerRequest(); assert.equal(health.status, 200);
    const status = await health.json() as { ownerRelease: { selectionDigest: string; admissionReference: string } };
    assert.equal(status.ownerRelease.selectionDigest, f.selection.selectionDigest);
    assert.equal(status.ownerRelease.admissionReference, f.registration.admissionReference);
    await f.artifact("immutable-attach-restart");
  } finally { await f.close(); }
});

test("authentication, issuer, scope, community, custody and grant conflicts cannot replace originals", async () => {
  const f = await managedServicesFixture();
  try {
    assert.equal((await f.prepare({}, { authorization: "Bearer wrong" })).status, 403);
    assert.equal((await f.prepare({}, { origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await f.prepare({ installationId: hashText("another installation") })).status, 409);
    assert.equal((await f.prepare({ communityId: hashText("crossed community") })).status, 409);
    assert.equal((await f.prepare({ ownerWallet: f.registration.scope.controller })).status, 409);
    assert.equal((await f.prepare()).status, 200);
    const before = await f.rows();
    for (const change of ["grant", "custody", "issuer", "scope"] as const) {
      const response = await f.withChangedRegistration(change, () => f.prepare());
      assert.ok([403, 409, 503].includes(response.status), change);
      assert.deepEqual(await f.rows(), before);
    }
    await f.artifact("refused-conflicts");
  } finally { await f.close(); }
});

test("a canonical configuration change or unavailable RPC refuses fresh attachment", async () => {
  const f = await managedServicesFixture();
  try {
    assert.equal((await f.prepare()).status, 200);
    f.chain.unavailable(true);
    assert.equal((await f.attach()).status, 503);
    assert.equal((await (await f.reconcile()).json()).state, "absent");
    f.chain.unavailable(false);
    await f.chain.nextRevision();
    assert.equal((await f.attach()).status, 409);
    assert.equal((await (await f.reconcile()).json()).state, "absent");
    await f.artifact("canonical-authority-refusal");
  } finally { await f.close(); }
});

test("durable attaching uncertainty never becomes absence or ready; revocation retains past acknowledgements", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare();
    await f.markAttaching();
    assert.equal((await (await f.reconcile()).json()).state, "unknown");
    await f.revoke();
    assert.equal((await f.attach()).status, 403);
    assert.equal((await (await f.reconcile()).json()).state, "unknown");
    assert.equal((await f.ownerRequest()).status, 403);
    await f.artifact("uncertain-revoked-original");
  } finally { await f.close(); }
  const acknowledged = await managedServicesFixture();
  try {
    await acknowledged.prepare(); await acknowledged.attach(); await acknowledged.revoke();
    assert.equal((await (await acknowledged.reconcile()).json()).state, "attached");
    assert.equal((await acknowledged.ownerRequest()).status, 403);
    await acknowledged.artifact("retained-acknowledgement");
  } finally { await acknowledged.close(); }
});

test("same-window replacement claims retain existing counters and original ceilings", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach();
    const g = f.registration.grant, id = "managed-service-observable-reservation";
    await reserveOwnerBudget(f.db, g, "songs", id, hashText("fixed independent song request"), "1");
    await settleOwnerBudget(f.db, g, "songs", id, "1");
    const before = await f.budgets();
    await f.attach();
    assert.deepEqual(await f.budgets(), before);
    await assert.rejects(f.provisionReplacement({ ...g.limits, songs: g.limits.songs + 1 }));
    assert.deepEqual(await f.budgets(), before);
    const retained = await f.reconcile();
    assert.equal((await retained.json()).grantDigest, g.sha256);
    assert.notEqual(hashJson(before), hashText("empty"));
    await f.artifact("retained-owner-window");
  } finally { await f.close(); }
});


test("revocation during an awaited canonical read cannot acknowledge attachment", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); f.afterNextCanonicalRead(() => f.revoke());
    assert.equal((await f.attach()).status, 403);
    assert.equal((await (await f.reconcile()).json()).state, "absent");
    await f.artifact("revocation-during-canonical-read");
  } finally { await f.close(); }
});

test("window expiration during an awaited canonical read never extends or replaces the original", async () => {
  const f = await managedServicesFixture({ grantSeconds: 30 });
  try {
    await f.prepare(); const original = await f.rows();
    f.afterNextCanonicalRead(() => f.waitPastGrantExpiry());
    assert.ok([403, 503].includes((await f.attach()).status));
    await f.waitPastGrantExpiry();
    assert.deepEqual(await f.rows(), original);
    assert.equal((await (await f.reconcile()).json()).state, "absent");
    await f.artifact("expiry-during-canonical-read");
  } finally { await f.close(); }
});


// Correction-v2 regressions: authored before corrective production changes. UNRUN.
test("prepare reselects the exact durable original after revocation, disablement and registry removal", async () => {
  const f = await managedServicesFixture();
  try {
    const selected = await (await f.prepare()).json(); await f.attach();
    const originals = await f.rows(), budgets = await f.budgets();
    await f.revoke();
    assert.deepEqual(await (await f.prepare()).json(), selected);
    await f.activeRegistry("disabled");
    assert.deepEqual(await (await f.prepare()).json(), selected);
    await f.activeRegistry("removed");
    assert.deepEqual(await (await f.prepare()).json(), selected);
    assert.equal((await (await f.reconcile()).json()).state, "attached");
    assert.deepEqual(await f.rows(), originals); assert.deepEqual(await f.budgets(), budgets);
    assert.equal((await f.ownerRequest()).status, 403);
    await f.artifact("v2-retained-reselection");
  } finally { await f.close(); }
});

test("lost actual attachment reply remains reselectable and reconcilable after expiry", async () => {
  const f = await managedServicesFixture({ grantSeconds: 30 });
  try {
    const selected = await (await f.prepare()).json(); f.loseReply("attach");
    await assert.rejects(f.attach()); const original = await f.rows(), budgets = await f.budgets();
    await f.waitPastGrantExpiry();
    assert.deepEqual(await (await f.prepare()).json(), selected);
    assert.equal((await (await f.reconcile()).json()).state, "attached");
    assert.equal((await (await f.attach()).json()).state, "attached");
    assert.deepEqual(await f.rows(), original); assert.deepEqual(await f.budgets(), budgets);
    await f.artifact("v2-expired-lost-ack");
  } finally { await f.close(); }
});

test("an expired absent original cannot be freshly prepared and unknown attachment cannot become acknowledgement", async () => {
  const f = await managedServicesFixture({ grantSeconds: 30 });
  try {
    await f.waitPastGrantExpiry(); assert.equal((await f.prepare()).status, 403);
    assert.deepEqual(await f.rows(), []); await f.artifact("v2-no-expired-mint");
  } finally { await f.close(); }
  const unknown = await managedServicesFixture();
  try {
    await unknown.prepare(); await unknown.markAttaching(); const before = await unknown.rows();
    assert.equal((await (await unknown.prepare()).json()).selectionDigest, unknown.selection.selectionDigest);
    assert.equal((await (await unknown.attach()).json()).state, "unknown");
    assert.deepEqual(await unknown.rows(), before); await unknown.artifact("v2-held-unknown");
  } finally { await unknown.close(); }
});

test("signed noncanonical host/reference/window strings and malformed original bytes cannot acquire admission", async () => {
  const f = await managedServicesFixture();
  try {
    const budgets = await f.budgets();
    for (const suffix of ["\n", "\r\n", "\u2028", "\u2029"]) {
      for (const field of ["host", "reference", "period", "raw"] as const) {
        await assert.rejects(f.provisionChangedOriginal(r => {
          if (field === "host") {
            r.scope.hostInstallationId += suffix; r.custody.installationId = r.scope.hostInstallationId;
            const { custodyBindingDigest: _digest, ...binding } = r.custody; r.custody.custodyBindingDigest = hashJson(binding);
          }
          if (field === "reference") r.admissionReference += suffix;
          if (field === "period") r.moderation.budgetPeriod += suffix;
          if (field === "raw") r.registrationOriginal.rawTransaction = `${r.registrationOriginal.rawTransaction}${suffix}`;
        }));
      }
    }
    await assert.rejects(f.provisionChangedOriginal(r => { r.registrationOriginal.rawTransaction = `${r.registrationOriginal.rawTransaction}a`; }));
    await assert.rejects(f.provisionChangedOriginal(r => { r.registrationOriginal.transactionHash = hashText("a different original transaction"); }));
    assert.deepEqual(await f.rows(), []); assert.deepEqual(await f.budgets(), budgets);
    await f.artifact("v2-complete-string-refusals");
  } finally { await f.close(); }
});

test("the managed gate guards the actual D1 transaction and authenticates replay without resetting owner ceilings", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach();
    const gate = f.admissionGate(), g = f.registration.grant,
      original = { operationId: "v2-original-pin", requestHash: hashText("independent original pin request"), asset: "pin_adds" as const, requested: "1" };
    const condition = await gate.reservationCondition(g, original);
    await f.revoke();
    // Actual existing reserveBudget executes both owner and admission predicates
    // in one D1 transaction; no test mock implements the guard.
    await assert.rejects(f.reserveWithGateCondition(original, condition));
    assert.equal(await f.reservationCount(original.operationId), 0);
    await assert.rejects(gate.beforeDispatch(g, original));
    await f.artifact("v2-atomic-gate-refusal");
  } finally { await f.close(); }
});

test("scoped health requires both exact selected headers and never treats health as an attachment acknowledgement", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare();
    assert.equal((await f.health()).status, 403);
    assert.equal((await f.health({ "x-pirate-community": f.registration.scope.communityId })).status, 403);
    assert.equal((await f.ownerRequest()).status, 403);
    await f.attach();
    assert.equal((await f.health({ "x-pirate-community": f.registration.scope.communityId, "x-pirate-owner-grant": hashText("wrong selected grant") })).status, 409);
    const before = await f.rows(); assert.equal((await f.ownerRequest()).status, 200);
    assert.deepEqual(await f.rows(), before); await f.artifact("v2-exact-scoped-health");
  } finally { await f.close(); }
});


test("revocation during real canonical readiness blocks the managed HTTP ADD before provider dispatch", async () => {
  const f = await managedServicesFixture();
  try {
    await f.prepare(); await f.attach(); const intent = await f.acceptCanonicalIntent();
    await assert.rejects(f.recognitionClient().reserve(intent)); await f.waitRecognitionReady(intent);
    f.afterCanonicalAction("ready", () => f.revoke());
    const response = await f.pinAudioOriginal(intent); assert.equal(response.ok, false);
    assert.equal(f.pinAdds(), 0);
    assert.equal((await (await f.reconcile()).json()).state, "attached");
    await f.artifact("v2-real-managed-dispatch-gate");
  } finally { await f.close(); }
});


// Correction-v3: captured authority must expire inside the actual D1 transaction. UNRUN.
test("database-time expiry refuses a captured live admission predicate without consuming counters and retains authenticated replay", async () => {
  const f = await managedServicesFixture({ grantSeconds: 30 });
  try {
    await f.prepare(); await f.attach();
    const g = f.registration.grant, gate = f.admissionGate(), live = {
      operationId: "v3-live-pin-original", requestHash: hashText("independent v3 live pin request"), asset: "pin_adds" as const, requested: "1",
    }, delayed = { ...live, operationId: "v3-captured-expired-pin", requestHash: hashText("independent v3 delayed pin request") };
    // Exercise the committed shared lazy supplier and actual budget transaction positively.
    await reserveOwnerBudget(f.db, g, live.asset, live.operationId, live.requestHash, live.requested, undefined,
      () => gate.reservationCondition(g, live));
    assert.equal(await f.reservationCount(live.operationId), 1);
    const captured = await gate.reservationCondition(g, delayed), before = await f.budgets();
    await f.waitForDatabaseExpiry();
    // Bypass only the JS sampling to expose the reservation's actual SQL fence.
    await assert.rejects(f.reserveWithGateCondition(delayed, captured), /managed_admission_not_current/);
    assert.equal(await f.reservationCount(delayed.operationId), 0);
    assert.deepEqual(await f.budgets(), before);
    let liveSupplierCalls = 0;
    const unavailable = async () => { liveSupplierCalls++; throw Error("expired live supplier must not run for an identical original"); };
    await reserveOwnerBudget(f.db, g, live.asset, live.operationId, live.requestHash, live.requested, undefined, unavailable);
    assert.equal(liveSupplierCalls, 0);
    await assert.rejects(reserveOwnerBudget(f.db, g, live.asset, live.operationId, hashText("conflicting v3 replay"), live.requested,
      undefined, unavailable), /reservation_conflict/);
    assert.equal(liveSupplierCalls, 0);
    await settleOwnerBudget(f.db, g, live.asset, live.operationId, "1");
    const settled = await f.db.prepare("SELECT status,actual FROM spending_reservations WHERE reservation_id=?")
      .bind(live.operationId).first<{ status: string; actual: string }>();
    assert.deepEqual(settled, { status: "settled", actual: "1" });
    assert.equal((await (await f.reconcile()).json()).state, "attached");
    await f.artifact("v3-database-expiry-and-retained-settlement");
  } finally { await f.close(); }
});
