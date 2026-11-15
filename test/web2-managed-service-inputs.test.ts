// Server-only Linux custody + actual managed HTTP/D1. All cases UNRUN.
import assert from "node:assert/strict";
import test from "node:test";
import { managedServicesFixture } from "./fixtures/managed-first-song-services.ts";
import { createWeb2ManagedServiceInputs } from "../deploy/linux/web2-managed-service-inputs.ts";
import { bytesToHex, recoverTypedDataAddress } from "viem";
import { enrollmentTypedData, parseEnrollment } from "../packages/community/hosted-enrollment.ts";
import { hashJson } from "../packages/community/common.ts";

test("signed installed inputs supply exact grant port and existing publisher signer without key output", async () => {
  const f = await managedServicesFixture();
  try {
    const installed = await f.linuxInputs();
    const inputs = await createWeb2ManagedServiceInputs(installed);
    assert.deepEqual(await inputs.publisher.selected(), {
      address: f.registration.scope.publisher, custodyBindingDigest: f.registration.custody.custodyBindingDigest,
    });
    const selection = await inputs.managedGrant.prepare(f.registration.scope);
    assert.deepEqual(selection, f.selection);
    assert.equal((await inputs.managedGrant.attach(selection.selectionDigest)).state, "attached");
    const challenge = await f.publisherChallenge();
    const proof = await inputs.publisher.signEnrollment(challenge);
    assert.equal((await recoverTypedDataAddress({ ...enrollmentTypedData(parseEnrollment(challenge.prepared.enrollment)),
      signature: proof.signature })).toLowerCase(), f.registration.scope.publisher);
    const serialized = JSON.stringify({ selection, proof });
    assert.equal(serialized.includes(bytesToHex(f.publisherKey)), false);
    assert.equal(serialized.includes(f.credential), false);
    await f.artifact("linux-key-channel-and-grant");
  } finally { await f.close(); }
});

test("transport uncertainty returns unknown on the same original without an automatic attach retry", async () => {
  const f = await managedServicesFixture();
  try {
    const inputs = await createWeb2ManagedServiceInputs(await f.linuxInputs());
    await inputs.managedGrant.prepare(f.registration.scope);
    f.loseReply("attach");
    const result = await inputs.managedGrant.attach(f.selection.selectionDigest);
    assert.equal(result.state, "unknown");
    assert.equal(f.attachCalls(), 1);
    assert.equal((await inputs.managedGrant.reconcile(f.selection.selectionDigest)).state, "attached");
    assert.equal(f.attachCalls(), 1);
    await f.artifact("linux-lost-reply");
  } finally { await f.close(); }
});

test("origin redirect, changed credentials, custody generation, lease and challenge refuse", async () => {
  const f = await managedServicesFixture();
  try {
    const installed = await f.linuxInputs();
    const inputs = await createWeb2ManagedServiceInputs(installed);
    await inputs.managedGrant.prepare(f.registration.scope);
    f.redirectNextReply();
    assert.equal((await inputs.managedGrant.attach(f.selection.selectionDigest)).state, "unknown");
    assert.equal(f.crossOriginRequests(), 0);
    await f.mutateCustodyGeneration();
    await assert.rejects(inputs.publisher.selected());
    await assert.rejects(inputs.managedGrant.prepare(f.registration.scope));
    const challenge = await f.publisherChallenge();
    await assert.rejects(inputs.publisher.signEnrollment({ ...challenge, operationId: hashJson({ arbitrary: true }) }));
    await f.breakLease();
    await assert.rejects(inputs.publisher.selected());
    await f.artifact("linux-binding-refusals");
  } finally { await f.close(); }
});


test("a changed actual key or installation credential refuses before sending grant work", async () => {
  const f = await managedServicesFixture();
  try {
    const inputs = await createWeb2ManagedServiceInputs(await f.linuxInputs());
    await f.replaceActualPublisherKey(); await assert.rejects(inputs.publisher.selected());
    await f.replaceActualServiceCredential();
    await assert.rejects(inputs.managedGrant.prepare(f.registration.scope));
    assert.equal(f.attachCalls(), 0);
    await f.artifact("actual-key-and-credential-refusal");
  } finally { await f.close(); }
});

test("altered signed installed origin, issuer or admission bytes fail signature authentication", async () => {
  const f = await managedServicesFixture();
  try {
    const installed = await f.linuxInputs();
    const changed = structuredClone(installed.record);
    changed.body.registration.body.serviceOrigin = "https://unadmitted.invalid";
    await assert.rejects(createWeb2ManagedServiceInputs({ ...installed, record: changed }));
    await f.artifact("installed-signature-refusal");
  } finally { await f.close(); }
});


// Correction-v2 keyless route and namespace contract cases; all UNRUN.
test("bundled signing-only profile serves only a pinned static closure with no backend bindings", async () => {
  const { signingHelperBoundaryFixture } = await import("./fixtures/managed-first-song-services.ts");
  const f = await signingHelperBoundaryFixture();
  try {
    const entry = await f.fetch("/operator-signing"); assert.equal(entry.status, 200);
    assert.deepEqual(new Uint8Array(await entry.arrayBuffer()), f.entry);
    assert.equal((await f.fetch("/assets/helper-fixture.js")).status, 200);
    for (const path of ["/health", "/v1/managed-publishing/prepare", "/api/auth/challenge", "/unknown"])
      assert.equal((await f.fetch(path)).status, 503);
    for (const path of ["/assets/unknown.js", "/assets/%2e%2e/private", "/operator-signing?key=anything"])
      assert.ok([403, 404].includes((await f.fetch(path)).status));
    assert.equal((await f.fetch("/operator-signing", { method: "POST" })).status, 405);
    assert.equal((await f.fetch("/operator-signing", { headers: { host: "wrong.invalid" } })).status, 403);
    await f.tamperChunk(); assert.equal((await f.fetch("/assets/helper-fixture.js")).status, 503);
    await f.artifact("v2-keyless-static-boundary");
  } finally { await f.close(); }
});

test("fresh package identity refuses the historical namespace, terminators and a mismatched selected stack", async () => {
  const { managedFreshStackIdentity } = await import("../harness/managed-package.ts");
  const selected = { prefix: "pirate-managed-v2-fixture", packageProfile: "managed-web2" as const, planId: hashJson({ reviewed: "fixture plan" }),
    state: { store: "pirate-encrypted-local" as const, stack: "pirate-managed-v2-fixture" } };
  assert.deepEqual(managedFreshStackIdentity(selected), selected);
  for (const prefix of ["pirate-managed-firstsong-20261105", "pirate-managed-firstsong-20261105-db", selected.prefix + "\n", selected.prefix + "\u2028"])
    assert.throws(() => managedFreshStackIdentity({ ...selected, prefix, state: { ...selected.state, stack: prefix } }));
  assert.throws(() => managedFreshStackIdentity({ ...selected, state: { ...selected.state, stack: "pirate-managed-firstsong-20261105" } }));
});
