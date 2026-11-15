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
