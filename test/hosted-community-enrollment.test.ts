import test from "node:test";
import assert from "node:assert/strict";
import { hashText, publicId } from "../packages/community/common.ts";
import { directoryV3Abi } from "../packages/community/web2-directory.ts";
import { enrollmentTypedData } from "../packages/community/hosted-enrollment.ts";
import {
  allOperations,
  revokeHostedInvite,
} from "../packages/community/hosted-enrollment-store.ts";
import {
  hostedFixture,
  lower,
} from "./fixtures/hosted-community-enrollment.ts";

// Failure plan is in the admitted doc. These invoke real HTTP handlers, D1,
// local chain, signatures and compiled contracts; no successful RPC is mocked.
test("hosted controller enrollment registers once, stays unlisted and exposes no private original", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    await f.mine();
    const status = await f.post("/status", p.auth);
    assert.equal(status.status, 200, JSON.stringify(status));
    assert.equal(
      (status.body.operations as { state: string }[])[0]!.state,
      "consumed",
    );
    assert.equal(
      await f.local.readContract({
        address: f.directory,
        abi: directoryV3Abi,
        functionName: "isDiscoverable",
        args: [i.profile.communityId],
      }),
      false,
    );
    const ops = await allOperations(f.db, p.e.id);
    assert.equal(ops.length, 1);
    assert(ops[0]!.raw);
    const publicText = JSON.stringify(status.body);
    for (const privateText of [
      i.secret,
      p.auth.controllerSignature,
      ops[0]!.raw!,
    ])
      assert(!publicText.includes(privateText));
    const sent = f.state.sendCount;
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    assert.equal(f.state.sendCount, sent);
    console.log(
      JSON.stringify({
        proof: "hosted-registration",
        community: i.profile.communityId,
        transaction: ops[0]!.tx_hash,
        receipt: JSON.parse(ops[0]!.receipt!),
      }),
    );
  } finally {
    await f.close();
  }
});
test("concurrent exact redeem shares original nonce and one send; conflicting prepare cannot steal binding", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    const altered = structuredClone(i.body);
    altered.profile.installationId = publicId();
    assert.notEqual((await f.post("/prepare", altered)).status, 200);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.post("/redeem", p.auth)),
    );
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(f.state.sendCount, 1);
    assert.equal((await allOperations(f.db, p.e.id)).length, 1);
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
  } finally {
    await f.close();
  }
});
test("expiry and revocation stop new registration without losing prepared identity", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite({ ttl: 20 }),
      p = await f.prepare(i);
    f.state.clock += 20;
    assert.notEqual((await f.post("/redeem", p.auth)).status, 200);
    assert.equal(f.state.sendCount, 0);
    f.state.clock -= 20;
    const j = await f.invite(),
      q = await f.prepare(j);
    await revokeHostedInvite(f.db, j.id);
    assert.notEqual((await f.post("/redeem", q.auth)).status, 200);
    assert.equal(f.state.sendCount, 0);
  } finally {
    await f.close();
  }
});
test("wrong source, CID bytes, policy acknowledgement and typed domain are refused", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite();
    const bad = structuredClone(i.body);
    bad.profile.sourceCommit = "f".repeat(40);
    assert.equal(
      (await f.post("/prepare", bad)).body.error,
      "unaccepted_hosted_deployment",
    );
    assert.equal(
      (await f.post("/prepare", { ...i.body, noticeSha256: hashText("other") }))
        .body.error,
      "pilot_notice_required",
    );
    f.state.invalidPin = true;
    assert.equal(
      (await f.post("/prepare", i.body)).body.error,
      "configuration_pin_unavailable",
    );
    f.state.invalidPin = false;
    const p = await f.prepare(i),
      typed = enrollmentTypedData(p.e);
    const wrong = await f.accounts.controller.signTypedData({
      ...typed,
      domain: { ...typed.domain, chainId: 6343 },
    });
    assert.equal(
      (await f.post("/redeem", { ...p.auth, controllerSignature: wrong })).body
        .error,
      "enrollment_authentication_failed",
    );
    const wrongContract = await f.accounts.controller.signTypedData({
      ...typed,
      domain: {
        ...typed.domain,
        verifyingContract: f.accounts.stranger.address,
      },
    });
    assert.equal(
      (
        await f.post("/redeem", {
          ...p.auth,
          controllerSignature: wrongContract,
        })
      ).body.error,
      "enrollment_authentication_failed",
    );
    assert.equal(f.state.sendCount, 0);
  } finally {
    await f.close();
  }
});
test("real deployed ERC1271 controller proof succeeds and wrong signer fails without account activation shortcuts", async () => {
  const f = await hostedFixture();
  try {
    const a = f.compiled.MockAccount!;
    const hash = await f.wallet.deployContract({
      abi: a.abi,
      bytecode: a.bytecode,
    });
    const receipt = await f.local.waitForTransactionReceipt({ hash });
    assert(receipt.contractAddress);
    const account = lower(receipt.contractAddress),
      i = await f.invite({ controller: account }),
      p = await f.prepare(i);
    assert.notEqual((await f.post("/redeem", p.auth)).status, 200);
    const init = await f.wallet.writeContract({
      address: account,
      abi: a.abi,
      functionName: "initialize",
      args: [f.accounts.controller.address],
    });
    await f.local.waitForTransactionReceipt({ hash: init });
    await f.mine();
    const wrong = await f.accounts.stranger.signTypedData(
      enrollmentTypedData(p.e),
    );
    assert.equal(
      (await f.post("/redeem", { ...p.auth, controllerSignature: wrong })).body
        .error,
      "enrollment_authentication_failed",
    );
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
  } finally {
    await f.close();
  }
});
test("replacement invite and installation cannot reset a redeemed lifetime allowance", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    await f.mine();
    const j = await f.invite({ allowanceId: i.allowanceId }),
      q = await f.prepare(j);
    assert.notEqual((await f.post("/redeem", q.auth)).status, 200);
    assert.equal(f.state.sendCount, 1);
    assert.equal((await allOperations(f.db, q.e.id)).length, 0);
  } finally {
    await f.close();
  }
});
test("unknown service schema refuses before any signing or registration", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite();
    await f.db.prepare("CREATE TABLE xcf_untracked(value TEXT)").run();
    assert.equal(
      (await f.post("/prepare", i.body)).body.error,
      "hosted_schema_mismatch",
    );
    assert.equal(f.state.sendCount, 0);
  } finally {
    await f.close();
  }
});
test("competing valid preparations bind one original and unauthenticated status is opaque", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      j = await f.invite();
    const results = await Promise.all([
      f.post("/prepare", i.body),
      f.post("/prepare", { ...j.body, inviteToken: i.secret }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const known = results.find((r) => r.status === 200)!.body.enrollmentId;
    const sig = `0x${"01".repeat(65)}`;
    assert.deepEqual(
      await f.post("/status", {
        enrollmentId: known,
        controllerSignature: sig,
      }),
      await f.post("/status", {
        enrollmentId: publicId(),
        controllerSignature: sig,
      }),
    );
  } finally {
    await f.close();
  }
});
test("a slow real signer cannot dispatch against an expired safe-view age", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    const { createHostedEnrollmentService } = await import(
      "../services/hosted-community-enrollment.ts"
    );
    const slow = createHostedEnrollmentService({
      ...f.runtime,
      registrar: {
        ...f.runtime.registrar,
        signTransaction: async (tx) => {
          const raw = await f.runtime.registrar.signTransaction(tx);
          f.state.clock += 301;
          return raw;
        },
      },
    });
    assert.equal(
      (await f.post("/redeem", p.auth, slow)).body.error,
      "hosted_safe_view_unavailable",
    );
    assert.equal(f.state.sendCount, 0);
    const ops = await allOperations(f.db, p.e.id);
    assert.equal(ops[0]!.state, "signed");
    await revokeHostedInvite(f.db, i.id);
    f.state.clock -= 301;
    const j = await f.invite(),
      q = await f.prepare(j);
    assert.equal(
      (await f.post("/redeem", q.auth)).body.error,
      "hosted_sender_unresolved_original",
    );
    assert.equal(f.state.sendCount, 0);
  } finally {
    await f.close();
  }
});
test("an inclusion-time revert charges the full bound and meters actual gas without granting community authority", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    f.state.beforeSend = async () => {
      const hash = await f.wallet.writeContract({
        address: f.directory,
        abi: directoryV3Abi,
        functionName: "configureRegistrar",
        args: ["0x0000000000000000000000000000000000000000", 0n, 100n, 1n],
      });
      await f.local.waitForTransactionReceipt({ hash });
    };
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    await f.mine();
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const op = (await allOperations(f.db, p.e.id))[0]!;
    assert.equal(op.state, "reverted");
    const receipt = JSON.parse(op.receipt!);
    assert.equal(receipt.principal, "0");
    assert(BigInt(receipt.cost) > 0n);
    assert.equal(receipt.chargedBoundWei, op.reservation);
    const budget = await f.db
      .prepare("SELECT spent,reserved FROM spending_budgets WHERE scope=?")
      .bind(`hosted:${f.policy.pilotId}:global`)
      .first<{ spent: string; reserved: string }>();
    assert.equal(budget?.spent, op.reservation);
    assert.equal(budget?.reserved, "0");
    assert.equal(
      await f.local.readContract({
        address: f.directory,
        abi: directoryV3Abi,
        functionName: "isDiscoverable",
        args: [i.profile.communityId],
      }),
      false,
    );
  } finally {
    await f.close();
  }
});
test("real RPC transport outage is unavailable rather than invalid controller and preserves original recovery", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
    await f.mine();
    const before = await allOperations(f.db, p.e.id),
      sends = f.state.sendCount;
    f.state.failRpc = true;
    const status = await f.post("/status", p.auth);
    assert.equal(status.status, 503);
    assert.deepEqual(status.body, {
      error: "enrollment_authentication_unavailable",
    });
    assert.equal((await f.post("/redeem", p.auth)).status, 503);
    assert.equal(f.state.sendCount, sends);
    assert.deepEqual(await allOperations(f.db, p.e.id), before);
    f.state.failRpc = false;
    assert.equal((await f.post("/status", p.auth)).status, 200);
    const after = (await allOperations(f.db, p.e.id))[0]!;
    assert.equal(after.raw, before[0]!.raw);
    assert.equal(after.tx_hash, before[0]!.tx_hash);
    assert.equal(after.nonce, before[0]!.nonce);
    assert.equal(f.state.sendCount, sends);
  } finally {
    f.state.failRpc = false;
    await f.close();
  }
});
test("actual wrong-chain RPC and corrupt stored evidence are unavailable, not invalid wallet proofs", async () => {
  const f = await hostedFixture();
  try {
    const i = await f.invite(),
      p = await f.prepare(i);
    await f.rpc("anvil_setChainId", [6343]);
    assert.deepEqual(await f.post("/redeem", p.auth), {
      status: 503,
      body: { error: "enrollment_authentication_unavailable" },
    });
    assert.equal(f.state.sendCount, 0);
    await f.rpc("anvil_setChainId", [31337]);
    const saved = await f.db
      .prepare("SELECT body FROM hosted_preparations WHERE id=?")
      .bind(p.e.id)
      .first<{ body: string }>();
    assert(saved);
    const broken = JSON.parse(saved.body);
    broken.plan.profile.sourceCommit = "not-a-commit";
    await f.db
      .prepare("UPDATE hosted_preparations SET body=? WHERE id=?")
      .bind(JSON.stringify(broken), p.e.id)
      .run();
    assert.deepEqual(await f.post("/status", p.auth), {
      status: 503,
      body: { error: "enrollment_authentication_unavailable" },
    });
    assert.equal(f.state.sendCount, 0);
    await f.db
      .prepare("UPDATE hosted_preparations SET body=? WHERE id=?")
      .bind(saved.body, p.e.id)
      .run();
    assert.equal((await f.post("/redeem", p.auth)).status, 200);
  } finally {
    await f.close();
  }
});
