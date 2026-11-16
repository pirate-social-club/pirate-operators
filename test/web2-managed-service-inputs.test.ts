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
    const entryPath = "/operator-signing?openerOrigin=" + encodeURIComponent("http://127.0.0.1:43123");
    const entry = await f.fetch(entryPath); assert.equal(entry.status, 200);
    assert.deepEqual(new Uint8Array(await entry.arrayBuffer()), f.entry);
    assert.equal((await f.fetch("/assets/helper-fixture.js")).status, 200);
    for (const path of ["/health", "/v1/managed-publishing/prepare", "/api/auth/challenge", "/unknown"])
      assert.equal((await f.fetch(path)).status, 503);
    for (const path of ["/assets/unknown.js", "/assets/%2Fprivate.js", "/assets/%252e%252e/private", "/operator-signing?key=anything"])
      assert.ok([403, 404].includes((await f.fetch(path)).status));
    // URL canonicalization moves this path outside the asset route; it remains explicitly unavailable.
    const normalized = await f.fetch("/assets/%2e%2e/private"); assert.equal(normalized.status, 503);
    assert.deepEqual(await normalized.json(), { error: "operator_signing_backend_unavailable" });
    assert.equal((await f.fetch(entryPath, { method: "POST" })).status, 405);
    assert.equal((await f.fetch(entryPath, { headers: { host: "wrong.invalid" } })).status, 403);
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


// Correction-v3: literal expected browser contract, independent of the worker validator. UNRUN.
test("signing helper accepts only the exact public loopback entry query and emits the final W1 response policy", async () => {
  const { signingHelperBoundaryFixture } = await import("./fixtures/managed-first-song-services.ts"), f = await signingHelperBoundaryFixture();
  try {
    const query = "?openerOrigin=" + encodeURIComponent("http://127.0.0.1:43123"), expected = {
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.megaeth.com; frame-src https://*.megaeth.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "strict-origin", "x-content-type-options": "nosniff", "cache-control": "no-store", "x-frame-options": "DENY",
      "cross-origin-opener-policy": "unsafe-none",
      "permissions-policy": 'publickey-credentials-get=(self "https://account.megaeth.com"), publickey-credentials-create=(self "https://account.megaeth.com")',
    };
    for (const path of ["/operator-signing" + query, "/assets/helper-fixture.js"]) {
      const response = await f.fetch(path); assert.equal(response.status, 200);
      for (const [name, value] of Object.entries(expected)) assert.equal(response.headers.get(name), value, name);
    }
    const head = await f.fetch("/operator-signing" + query, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    for (const tail of ["", "?", query + "&openerOrigin=" + encodeURIComponent("http://127.0.0.1:43124"), query + "&nonce=private",
      "?%6fpenerOrigin=" + encodeURIComponent("http://127.0.0.1:43123"), "?openerOrigin=http://127.0.0.1:43123",
      "?openerOrigin=" + encodeURIComponent("http://localhost:43123"), "?openerOrigin=" + encodeURIComponent("http://[::1]:43123"),
      "?openerOrigin=" + encodeURIComponent("http://127.0.0.1"), "?openerOrigin=" + encodeURIComponent("http://127.0.0.1:0"),
      "?openerOrigin=" + encodeURIComponent("http://127.0.0.1:65536"), "?openerOrigin=" + encodeURIComponent("http://127.0.0.1:43123/"),
      "?openerOrigin=" + encodeURIComponent("http://127.0.0.1:43123\n"), query.replace(/%3A/g, "%3a")]) {
      assert.ok([403, 404].includes((await f.fetch("/operator-signing" + tail)).status), tail);
    }
    for (const path of ["/assets/helper-fixture.js" + query, "/assets/%68elper-fixture.js", "/assets/helper-fixture%2ejs"])
      assert.equal((await f.fetch(path)).status, 404, path);
    await f.changeCsp("default-src 'none'; script-src *");
    assert.equal((await f.fetch("/operator-signing" + query)).status, 503);
    await f.artifact("v3-final-helper-http-contract");
  } finally { await f.close(); }
});

test("actual fresh packaged Alchemy entry refuses absent and incompatible profile selection before stack construction", async () => {
  const { managedPackageEntryBoundaryFixture } = await import("./fixtures/managed-first-song-services.ts"), f = await managedPackageEntryBoundaryFixture();
  try {
    for (const profile of ["managed-web2", "operator-signing-only"] as const) {
      for (const selector of [undefined, "", "historical-owner"]) {
        const result = await f.importPackagedEntry(profile, selector);
        assert.deepEqual(result.outcome, { error: "managed_package_profile_required" });
        assert.deepEqual(result.afterState, result.beforeState);
      }
      const result = await f.importPackagedEntry(profile, profile === "managed-web2" ? "operator-signing-only" : "managed-web2");
      assert.deepEqual(result.outcome, { error: "managed_package_stack_changed" });
      assert.deepEqual(result.afterState, result.beforeState);
    }
    await f.artifact("v3-packaged-entry-early-refusal");
  } finally { await f.close(); }
});


// v4: installed Alchemy resources + actual Effect Config resolution, no cloud provider.
test("selected Alchemy profiles resolve required redacted bindings while fresh catalog defers only OpenAI", async () => {
  const { managedPackageEntryBoundaryFixture } = await import("./fixtures/managed-first-song-services.ts"), f = await managedPackageEntryBoundaryFixture();
  try {
    const fresh = await f.collectSelectedProfile("managed-web2", ["OPENAI_API_KEY"]);
    assert.equal(fresh.config.ok, true, fresh.config.error);
    assert.deepEqual(fresh.resources.map(r => r.id), ["App", "Consumer", "Database", "Jobs", "Media", "RecognitionApp", "RecognitionConsumer", "RecognitionDatabase", "RecognitionJobs"]);
    const app = fresh.resources.find(r => r.id === "App")!;
    assert.deepEqual(app.secrets, ["ACRCLOUD_ACCESS_KEY", "ACRCLOUD_ACCESS_SECRET", "FILEBASE_IPFS_TOKEN", "MODERATION_SIGNER_PRIVATE_KEY"]);
    assert.equal(app.env.includes("OPENAI_API_KEY"), false);
    assert.equal(fresh.config.allRedacted, true);
    const noSigner = await f.collectSelectedProfile("managed-web2", ["OPENAI_API_KEY", "MODERATION_SIGNER_PRIVATE_KEY"]);
    assert.equal(noSigner.config.ok, false); assert.match(noSigner.config.error!, /MODERATION_SIGNER_PRIVATE_KEY/);
    for (const profile of ["historical-owner", "historical-registered"] as const) {
      const historical = await f.collectSelectedProfile(profile, ["OPENAI_API_KEY"]);
      assert.equal(historical.config.ok, false); assert.match(historical.config.error!, /OPENAI_API_KEY/);
      const complete = await f.collectSelectedProfile(profile, []);
      assert.equal(complete.config.ok, true, complete.config.error); assert.equal(complete.config.allRedacted, true);
      assert.deepEqual(complete.resources.map(r => r.id), ["App", "Consumer", "Database", "Jobs", "Media"]);
      assert.deepEqual(complete.resources.find(r => r.id === "App")!.secrets,
        ["ACRCLOUD_ACCESS_KEY", "ACRCLOUD_ACCESS_SECRET", "FILEBASE_IPFS_TOKEN", "MODERATION_SIGNER_PRIVATE_KEY", "OPENAI_API_KEY",
          ...(profile === "historical-registered" ? ["REGISTRATION_OPERATOR_PRIVATE_KEY"] : [])].sort());
    }
    const helper = await f.collectSelectedProfile("operator-signing-only", ["OPENAI_API_KEY", "MODERATION_SIGNER_PRIVATE_KEY"]);
    assert.equal(helper.config.ok, true, helper.config.error);
    assert.deepEqual(helper.resources.map(r => r.id), ["SigningHelper"]);
    assert.deepEqual(helper.resources[0]!.secrets, []); assert.deepEqual(helper.resources[0]!.crons, []);
    assert.deepEqual(helper.resources[0]!.env, ["MANAGED_PUBLISHING_PROFILE", "OPERATOR_SIGNING_PROFILE_JSON"]);
    assert.equal(helper.resources.some(r => /D1|R2|Queue/.test(r.type)), false);
    await f.artifact("v4-actual-profile-config-resolution");
  } finally { await f.close(); }
});

test("fresh package dependencies require a real owned committed-lock installation", async () => {
  const { ownedManagedPackageDependencies } = await import("./fixtures/managed-package-dependencies.ts"),
    { managedSigningHelperPackage } = await import("../harness/managed-package.ts"),
    { resolve } = await import("node:path");
  const selected = await ownedManagedPackageDependencies();
  await selected.verify();
  assert.equal(selected.provenance.kind, "owned-committed-lock");
  await assert.rejects(ownedManagedPackageDependencies(resolve("node_modules")), /owned_dependency_directory_required/);
  await assert.rejects(managedSigningHelperPackage({ identity: { prefix: "pirate-dependency-refusal", packageProfile: "operator-signing-only", planId: `0x${"ab".repeat(32)}`, state: { store: "pirate-encrypted-local", stack: "pirate-dependency-refusal" } },
    assets: { directory: "absent", manifestPath: ".vite/manifest.json", manifestSha256: `0x${"cd".repeat(32)}`, entryKey: "moss-signing.html", htmlFile: "moss-signing.html", origin: "https://signing.fixture.example", contentSecurityPolicy: "absent" } },
    { ...selected, modules: resolve("node_modules") }), /fresh_dependency_input_changed/);
});

test("verified owned dependency input refuses a newly introduced nested resolution shadow", async () => {
  const { lockedPackageDependencyInput } = await import("./fixtures/managed-package-dependencies.ts"),
    { mkdtemp, mkdir, cp, writeFile, copyFile } = await import("node:fs/promises"), { tmpdir } = await import("node:os"),
    { join, resolve } = await import("node:path"), { promisify } = await import("node:util"), { execFile } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "real-owned-resolution-")), modules = join(directory, "node_modules");
  await mkdir(modules);
  // Two small actual locked public packages, not a fabricated resolver/verifier.
  await cp(resolve("apps/community-wizard/node_modules/merge-anything"), join(modules, "merge-anything"), { recursive: true });
  await cp(resolve("apps/community-wizard/node_modules/is-what"), join(modules, "is-what"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, dependencies: { "merge-anything": "5.1.7" } }));
  await copyFile(resolve("apps/community-wizard/package-lock.json"), join(directory, "package-lock.json"));
  await copyFile(resolve("apps/community-wizard/node_modules/.package-lock.json"), join(modules, ".package-lock.json"));
  const selected = await lockedPackageDependencyInput(directory, ["merge-anything"]);
  await selected.verify();
  const resolveActual = async () => (await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {createRequire} from 'node:module';console.log(createRequire(${JSON.stringify(join(modules, "merge-anything/package.json"))}).resolve('is-what'));`], { timeout: 10000 })).stdout.trim();
  const original = await resolveActual(); assert(original.startsWith(join(modules, "is-what")));
  await mkdir(join(modules, "merge-anything/node_modules"));
  await cp(join(modules, "is-what"), join(modules, "merge-anything/node_modules/is-what"), { recursive: true });
  assert.notEqual(await resolveActual(), original);
  await assert.rejects(selected.verify(), /owned_dependency_input_changed/);
});
