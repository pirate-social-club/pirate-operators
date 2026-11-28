// Authored before the implementation. Actual paired HTTP, D1 and local chain;
// the SDK transport and Pirate admission are explicit test boundaries. These
// fixtures do not establish real MOSS or public-provider acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { hashJson } from "../packages/community/common.ts";
import { hostedWizardFixture } from "./fixtures/web2-hosted-wizard.ts";
import { web2Other } from "./fixtures/web2-first-song-chain.ts";
import { createWeb2Wallet } from "../apps/community-wizard/src/web2-wallet.ts";

async function installAndRegister(
  f: Awaited<ReturnType<typeof hostedWizardFixture>>,
  proof?: string,
) {
  let v = await f.prepare();
  v = await f.send("authorize", {
    signature: proof ?? (await f.sign(v.challenge)),
  });
  v = await f.install();
  await f.mine();
  v = await f.send("reconcile", {});
  assert.deepEqual(
    v.enrollment?.operations.map((op) => op.kind),
    ["registration"],
    "ordinary install registration produces no top-up",
  );
  assert.equal(v.enrollment?.operations[0]?.state, "consumed");
  return v;
}

test("paired signing retains controller proof and separately reviewed V2 authority across lost attachment reply and restart", async () => {
  const f = await hostedWizardFixture({ publishing: true, scriptedInstallation: true, fundedEnrollment: true });
  try {
    let v = await f.prepare();
    const identity = v.selection;
    const wallet = createWeb2Wallet(async () => ({
      async initialise() {},
      async connect() {
        return { address: f.prepareInput.controller, network: "testnet" };
      },
      async signData({ data }) {
        return { status: "success", signature: await f.sign(data) };
      },
    }));
    const proof = await wallet.signTypedData({
      expectedController: f.prepareInput.controller as `0x${string}`,
      requestDigest: hashJson(v.challenge) as `0x${string}`,
      data: v.challenge as Parameters<typeof wallet.signTypedData>[0]["data"],
    });
    assert.equal(proof.status, "success");
    if (proof.status !== "success") throw Error("proof required");
    v = await installAndRegister(f, proof.signature);
    // Browser-supplied publisher proof cannot become a fresh original.
    assert.equal(
      (
        await f.post("topup", {
          proofs: [
            { recipient: v.selection!.publisher, signature: proof.signature },
          ],
        })
      ).status,
      403,
    );
    // Product obtains the distinct publisher's gas proof.
    v = await f.send("topup", {});
    await f.mine();
    v = await f.send("reconcile", {});
    assert(v.enrollment!.operations.every((o) => o.state === "consumed"));
    v = await f.send("publishing-prepare", {
      ownerWallet: web2Other.address.toLowerCase(),
      rolesReviewed: true,
    });
    assert.equal(
      v.publishing!.authorization!.schema,
      "pirate.owner-publishing-authorization/2",
    );
    assert.equal(
      v.publishing!.authorization!.ownerWallet,
      web2Other.address.toLowerCase(),
    );
    const sig = await f.sign(v.publishing!.typedData);
    assert.equal((await f.post("publishing-authorize",{signature:sig+"\n",requestDigest:v.publishing!.requestDigest,reviewed:true})).status,400);
    v = await f.send("publishing-authorize", {
      signature: sig,
      requestDigest: v.publishing!.requestDigest,
      reviewed: true,
    });
    const accepted = JSON.parse(await readFile(f.signingJournal, "utf8"));
    const effects = f.broadcasts();
    f.loseAttachmentReply();
    assert.equal((await f.post("publishing-attach", {})).status, 503);
    await f.restart();
    v = await f.send("publishing-reconcile", {});
    assert.equal(v.publishing!.attached, true);
    assert.deepEqual(v.selection, identity);
    assert.equal(f.broadcasts(), effects);
    assert.equal(f.attachmentEffects(), 1);
    const recovered = JSON.parse(await readFile(f.signingJournal, "utf8"));
    assert.deepEqual(recovered.accepted, accepted.accepted);
    assert.equal(
      (
        await f.post("publishing-authorize", {
          signature: `0x${"01".repeat(65)}`,
          requestDigest: v.publishing!.requestDigest,
          reviewed: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.post("publishing-prepare", {
          ownerWallet: f.prepareInput.controller,
          rolesReviewed: true,
        })
      ).status,
      409,
    );
    await f.artifact("operator-signing-recovery", v);
  } finally {
    await f.close();
  }
});

test("SDK cancellation and changed connected account cannot submit retained enrollment proof", async () => {
  const f = await hostedWizardFixture();
  try {
    const v = await f.prepare();
    let changed = false;
    let cancel = true;
    const wallet = createWeb2Wallet(async () => ({
      async initialise() {},
      async connect() {
        return {
          address: changed ? web2Other.address : f.prepareInput.controller,
          network: "testnet",
        };
      },
      async signData({ data }) {
        if (cancel) return { status: "cancelled" };
        const signature = await f.sign(data);
        changed = true;
        return { status: "success", signature };
      },
    }));
    const request = {
      expectedController: f.prepareInput.controller as `0x${string}`,
      requestDigest: hashJson(v.challenge) as `0x${string}`,
      data: v.challenge as Parameters<typeof wallet.signTypedData>[0]["data"],
    };
    assert.deepEqual(await wallet.signTypedData(request), {
      status: "cancelled",
    });
    cancel = false;
    assert.deepEqual(await wallet.signTypedData(request), {
      status: "error",
      code: "web2_wallet_account_changed",
    });
    assert.equal((await f.state()).controllerAuthorized, false);
    assert.equal(f.broadcasts(), 0);
  } finally {
    await f.close();
  }
});

test("missing trusted issuer or managed key binding is explicitly unavailable without invented authority", async () => {
  const f = await hostedWizardFixture({ scriptedInstallation: true });
  try {
    await installAndRegister(f);
    assert.equal(
      (
        await f.post("publishing-prepare", {
          ownerWallet: f.prepareInput.controller,
          rolesReviewed: true,
        })
      ).status,
      503,
    );
    f.custodyUnavailable();
    assert.equal((await f.post("topup", {})).status, 503);
    assert.equal(f.broadcasts(), 1);
  } finally {
    await f.close();
  }
});

test("fresh preparation without configured publisher custody refuses before retaining enrollment or sending", async () => {
  const f = await hostedWizardFixture({ missingCustody: true });
  try {
    const response = await f.prepareResponse();
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "publisher_custody_binding_unavailable");
    assert.equal((await f.state()).selection, null);
    assert.equal(await f.preparationCount(), 0);
    assert.equal(f.broadcasts(), 0);
  } finally {
    await f.close();
  }
});

test("changed configured grant or publisher cannot replace a retained selection or enter an installation", async () => {
  const f = await hostedWizardFixture({ publishing: true, scriptedInstallation: true });
  try {
    const installed = await installAndRegister(f);
    const v = await f.send("publishing-prepare", {
      ownerWallet: f.prepareInput.controller,
      rolesReviewed: true,
    });
    const original = await readFile(f.signingJournal, "utf8");
    f.changeGrantSelection("publisher");
    assert.equal((await f.post("publishing-reconcile", {})).status, 409);
    assert.equal(await readFile(f.signingJournal, "utf8"), original);
    const survival = await f.send("installation-status", {});
    assert.equal(
      survival.observation?.installationId,
      installed.observation?.installationId,
    );
    assert.equal(f.attachmentEffects(), 0);
  } finally {
    await f.close();
  }
});

// Losing current observations can be reconciled; losing all immutable signing
// originals must not invite another owner selection or extend its window.
test("missing signing originals refuse reconstruction after restart", async () => {
  const f = await hostedWizardFixture({ publishing: true, scriptedInstallation: true });
  try {
    await installAndRegister(f);
    const v = await f.send("publishing-prepare", {
      ownerWallet: f.prepareInput.controller,
      rolesReviewed: true,
    });
    await f.send("publishing-authorize", {
      signature: await f.sign(v.publishing!.typedData),
      requestDigest: v.publishing!.requestDigest,
      reviewed: true,
    });
    for (const name of [
      "web2-signing-sidecar.json",
      "web2-signing-selection.json",
      "web2-signing-accepted.json",
    ])
      await unlink(f.directory + "/" + name);
    await assert.rejects(f.restart(), /web2_signing_original_changed/);
    assert.equal(f.broadcasts(), 1);
    assert.equal(f.attachmentEffects(), 0);
  } finally {
    await f.close();
  }
});

// Failure plan: a lost completed attachment must remain recordable after its
// window closes; authenticated absence must allow an explicit same-byte retry;
// unknown must remain held, and absent-after-expiry must never permit an attach.
for (const outcome of ["before","after"] as const) test(`lost ${outcome}-acceptance grant reply reconciles the same authorization after restart`,async()=>{
  const f=await hostedWizardFixture({publishing:true,grantWindowSeconds:12,scriptedInstallation:true});
  try {
    let v=await installAndRegister(f);
    v=await f.send("publishing-prepare",{ownerWallet:f.prepareInput.controller,rolesReviewed:true});
    v=await f.send("publishing-authorize",{signature:await f.sign(v.publishing!.typedData),requestDigest:v.publishing!.requestDigest,reviewed:true});
    const original=await readFile(f.signingJournal,"utf8");f.loseAttachmentReply(outcome);
    assert.equal((await f.post("publishing-attach",{})).status,503);await f.restart();
    if(outcome === "before") {
      v=await f.send("publishing-reconcile",{});assert.equal(v.publishing!.pending,false);assert.equal(v.publishing!.attached,false);
      v=await f.send("publishing-attach",{});assert.equal(v.publishing!.attached,true);
    } else {
      await f.waitForGrantExpiry();v=await f.send("publishing-reconcile",{});
      assert.equal(v.publishing!.attached,true);assert.equal(v.publishing!.live,false);
      const attachmentEffects=f.attachmentEffects();
      const survival=await f.send("installation-status",{});
      assert.equal(survival.observation?.installationId,v.observation?.installationId);
      const repeat=await f.send("publishing-attach",{});
      assert.equal(repeat.publishing?.live,false);
      assert.equal(f.attachmentEffects(),attachmentEffects);
    }
    assert.equal(f.attachmentEffects(),1);
    assert.deepEqual(JSON.parse(await readFile(f.signingJournal,"utf8")).accepted,JSON.parse(original).accepted);
    await f.artifact(`completion-attachment-${outcome}`,v);
  } finally {await f.close();}
});

test("unknown attachment holds, and authoritative absence after expiry cannot authorize a retry",async()=>{
  const f=await hostedWizardFixture({publishing:true,grantWindowSeconds:12,scriptedInstallation:true});
  try {
    let v=await installAndRegister(f);
    v=await f.send("publishing-prepare",{ownerWallet:f.prepareInput.controller,rolesReviewed:true});
    v=await f.send("publishing-authorize",{signature:await f.sign(v.publishing!.typedData),requestDigest:v.publishing!.requestDigest,reviewed:true});
    const original=JSON.parse(await readFile(f.signingJournal,"utf8")).accepted;
    f.loseAttachmentReply("before");assert.equal((await f.post("publishing-attach",{})).status,503);
    f.attachmentUnknown(true);
    assert.equal((await f.post("publishing-reconcile",{})).status,503);
    assert.equal((await f.state()).publishing!.pending,true);
    assert.equal((await f.post("publishing-attach",{})).status,503);
    assert.equal(f.attachmentEffects(),0);
    f.attachmentUnknown(false);await f.waitForGrantExpiry();
    v=await f.send("publishing-reconcile",{});
    assert.equal(v.publishing!.pending,false);assert.equal(v.publishing!.attached,false);assert.equal(v.publishing!.live,false);
    const survival=await f.send("installation-status",{});
    assert.equal(survival.observation?.installationId,v.observation?.installationId);
    assert.equal((await f.post("publishing-attach",{})).status,403);
    assert.equal(f.attachmentEffects(),0);
    assert.deepEqual(JSON.parse(await readFile(f.signingJournal,"utf8")).accepted,original);
    await f.artifact("completion-absent-expired",v);
  } finally {await f.close();}
});
