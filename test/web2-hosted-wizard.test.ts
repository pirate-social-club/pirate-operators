import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import {
  readFile,
  lstat,
  writeFile,
  mkdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { web2Other } from "./fixtures/web2-first-song-chain.ts";
import { enrollmentTypedData } from "../packages/community/hosted-enrollment.ts";
import { hostedWizardFixture } from "./fixtures/web2-hosted-wizard.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  createWeb2WizardClient,
  type Web2Snapshot,
} from "../apps/community-wizard/src/web2-api.ts";

// Failure plan precedes production in the onboarding document. These exercise
// the actual paired HTTP server, hosted handlers, D1, signatures and local RPC.
test("paired Web2 Wizard retains one original across lost redeem reply and restart without Pirate-funded gas", async () => {
  const f = await hostedWizardFixture();
  try {
    const bad = await f.post("prepare", {
      ...f.prepareInput,
      controller: "0x1234",
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "web2_controller_address_invalid");
    assert.match(String(bad.body.error), /controller address/);
    assert.equal((await f.state()).selection, null);
    assert.equal(await f.preparationCount(), 0);
    assert.equal(f.broadcasts(), 0);
    let view = await f.send("prepare", {
      ...f.prepareInput,
      controller: getAddress(f.prepareInput.controller),
      publisher: getAddress(f.prepareInput.publisher),
    });
    assert.equal(
      view.selection?.controller,
      f.prepareInput.controller.toLowerCase(),
    );
    assert.equal(
      view.selection?.publisher,
      f.prepareInput.publisher.toLowerCase(),
    );
    assert(view.challenge);
    f.dropRedeemReply();
    view = await f.send("redeem", { signature: await f.sign(view.challenge) });
    assert.equal(view.phase, "unknown");
    const identity = view.selection;
    await f.restart();
    await f.mine();
    view = await f.send("reconcile", {});
    assert.deepEqual(view.selection, identity);
    assert.equal(view.enrollment?.operations[0]?.state, "consumed");
    const sent = f.broadcasts();
    view = await f.send("redeem", { signature: await f.sign(view.challenge!) });
    assert.equal(f.broadcasts(), sent);
    assert.equal(view.enrollment?.operations.length, 1);
    assert(view.enrollment.operations.every((op) => op.state === "consumed"));
    const funded = f.broadcasts();
    const topup = await f.post("topup", {});
    assert.equal(topup.status, 409);
    assert.equal(topup.body.code, "hosted_request_refused");
    assert.equal(f.broadcasts(), funded);
    const unavailable = await f.post("install", {});
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, "web2_installation_unavailable");
    const current = await f.raw("GET", "/api/web2/state"),
      slowClient = createWeb2WizardClient(async (resource, init) => {
        const request = new Request(
            resource instanceof Request
              ? resource
              : new URL(resource, f.origin),
            init,
          ),
          headers = new Headers(request.headers);
        // Keep the existing explicit fixture pairing channel. The actual
        // runner still checks Origin, CSRF, revision and all request data.
        headers.set("cookie", "wizard_fixture=paired");
        headers.set("origin", f.origin);
        const response = await fetch(new Request(request, { headers }));
        // Delay the real unavailable-installer reply past the old deadline;
        // no installer or successful installation response is substituted.
        await delay(31_000, undefined, { signal: request.signal });
        return response;
      });
    await assert.rejects(
      slowClient.send(
        "installation-prepare",
        {},
        current.body as unknown as Web2Snapshot,
      ),
      /The real Linux Web2 installer is unavailable/,
    );
    assert.deepEqual((await f.state()).selection, identity);
    assert.equal(f.broadcasts(), funded);
    const publicText = JSON.stringify(await f.state());
    assert(!publicText.includes("inviteToken"));
    assert.equal((await lstat(f.journal)).mode & 0o777, 0o600);
    const original = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(Object.hasOwn(original, "inviteToken"), false);
    await f.artifact("recovery", view);
  } finally {
    await f.close();
  }
});

test("unknown preparation resumes after reconstruction using the retained original community", async () => {
  const f = await hostedWizardFixture();
  try {
    f.dropPrepareReply();
    let view = await f.prepare();
    assert.equal(view.phase, "unknown");
    const original = view.selection;
    await f.restart();
    view = await f.send("resume-prepare", {});
    assert.deepEqual(view.selection, original);
    assert(view.challenge);
    assert.equal(f.broadcasts(), 0);
    await f.artifact("preparation-recovery", view);
  } finally {
    await f.close();
  }
});

test("repeated real journal rename failures permit no hosted preparation until the original is durable", async () => {
  const f = await hostedWizardFixture();
  try {
    // A directory at the file destination makes atomic rename fail even as
    // root in CI. It does not depend on permission mocks or an injected store.
    await mkdir(f.journal);
    assert.equal((await f.post("prepare", f.prepareInput)).status, 502);
    const identity = (await f.state()).selection;
    assert.equal((await f.post("resume-prepare", {})).status, 502);
    assert.equal(await f.preparationCount(), 0);
    assert.equal(f.broadcasts(), 0);
    await rmdir(f.journal);
    const view = await f.send("resume-prepare", {});
    assert.deepEqual(view.selection, identity);
    assert.equal(await f.preparationCount(), 1);
  } finally {
    await f.close();
  }
});

test("unexpected invitation input is refused and a wrong signature can be corrected without replacing the community", async () => {
  const f = await hostedWizardFixture();
  try {
    const malformed = await f.post("prepare", {
      ...f.prepareInput,
      inviteToken: "x",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await f.state()).selection, null);
    let view = await f.prepare();
    const wrong = await web2Other.signTypedData(
      view.challenge as ReturnType<typeof enrollmentTypedData>,
    );
    const denied = await f.post("redeem", { signature: wrong });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "hosted_authorization_refused");
    assert.equal((await f.state()).controllerAuthorized, false);
    assert.equal(f.broadcasts(), 0);
    view = await f.send("redeem", { signature: await f.sign(view.challenge) });
    await f.mine();
    view = await f.send("reconcile", {});
    assert.equal(view.enrollment?.operations[0]?.state, "consumed");
    assert.equal(f.broadcasts(), 1);
  } finally {
    await f.close();
  }
});

test("restored private state refuses a changed selection without overwriting its evidence", async () => {
  const f = await hostedWizardFixture();
  try {
    await f.prepare();
    const original = JSON.parse(await readFile(f.journal, "utf8"));
    original.request.origin = "https://changed.example";
    const changed = JSON.stringify(original);
    await writeFile(f.journal, changed);
    await assert.rejects(f.restart(), /web2_original_unreadable/);
    assert.equal(await readFile(f.journal, "utf8"), changed);
  } finally {
    await f.close();
  }
});

test("an invalid host deployment cannot freeze a partial selection or bypass its validation on resume", async () => {
  const f = await hostedWizardFixture({ invalidDeployment: true });
  try {
    assert.equal((await f.prepareResponse()).status, 400);
    assert.equal((await f.state()).selection, null);
    assert.equal((await f.post("resume-prepare", {})).status, 409);
    assert.equal(await f.preparationCount(), 0);
    assert.equal(f.broadcasts(), 0);
  } finally {
    await f.close();
  }
});

test("losing an initialized original refuses reconstruction rather than allocating another community", async () => {
  const f = await hostedWizardFixture();
  try {
    await f.prepare();
    await unlink(f.journal);
    await assert.rejects(f.restart(), /web2_original_missing/);
    assert.equal(await f.preparationCount(), 1);
    assert.equal(f.broadcasts(), 0);
  } finally {
    await f.close();
  }
});

test("a retained same-account original reconciles one initial allocation through the Wizard", async () => {
  const f = await hostedWizardFixture({ sameRecipient: true });
  try {
    let view = await f.prepare();
    view = await f.send("redeem", { signature: await f.sign(view.challenge) });
    await f.mine();
    view = await f.send("reconcile", {});
    const proofs = await f.recipientProofs(view);
    assert.equal(proofs.length, 1);
    view = await f.send("topup", {});
    await f.mine();
    view = await f.send("reconcile", {});
    assert.equal(view.enrollment?.operations.length, 2);
    assert(view.enrollment.operations.every((op) => op.state === "consumed"));
    assert.equal(f.broadcasts(), 2);
    await f.artifact("shared-recipient", view);
  } finally {
    await f.close();
  }
});

test("Web2 Wizard refuses changed hosted signing terms before exposing a wallet request", async () => {
  const f = await hostedWizardFixture();
  try {
    f.changePrepareReply();
    const r = await f.prepareResponse();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "hosted_signing_request_changed");
    assert.equal((await f.state()).challenge, null);
    assert.equal(f.broadcasts(), 0);
    await f.artifact("changed-signing-terms", await f.state());
  } finally {
    await f.close();
  }
});

test("Web2 Wizard requires paired authorization, exact host, Origin and CSRF and retains originals after refusal", async () => {
  const f = await hostedWizardFixture();
  try {
    assert.equal(
      (await f.raw("GET", "/api/web2/state", undefined, { pair: false }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.raw("GET", "/api/web2/state", undefined, {
          host: "evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.raw(
          "POST",
          "/api/web2/prepare",
          {},
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.raw("POST", "/api/web2/prepare", {}, { csrf: "0".repeat(64) }))
        .status,
      403,
    );
    const before = await f.state();
    const prepared = await f.prepare();
    const stale = await f.post("prepare", f.prepareInput, before.revision);
    assert.equal(stale.status, 409);
    assert.deepEqual((await f.state()).selection, prepared.selection);
    assert.equal(f.broadcasts(), 0);
  } finally {
    await f.close();
  }
});

test("contract controller uses actual ERC1271 enrollment authorization without collecting a key", async () => {
  const f = await hostedWizardFixture({ contractController: true });
  try {
    let view = await f.prepare();
    view = await f.send("redeem", { signature: await f.sign(view.challenge!) });
    await f.mine();
    view = await f.send("reconcile", {});
    const proofs = await f.recipientProofs(view);
    // This existing ERC1271 fixture contract is deliberately nonpayable.
    // Its policy allocates no topup, rather than pretending it can receive one.
    assert.equal(proofs.length, 0);
    assert.equal(view.enrollment?.operations.length, 1);
    assert(view.enrollment.operations.every((op) => op.state === "consumed"));
    await f.artifact("contract-controller", view);
  } finally {
    await f.close();
  }
});
