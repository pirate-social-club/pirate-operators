import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "../http.ts";
import { createPlan, digest, planFrom } from "../model.ts";
import { qualifyRpcRead } from "../rpc-compatibility.ts";
import { probeCar } from "../filebase.ts";
import { provisionOpenAi } from "../openai.ts";
import {
  state,
  profile,
  intent,
  memoryVault,
} from "./provider-setup-fixtures.ts";

async function prepared() {
  const store = await state(),
    vault = memoryVault(),
    probe = await probeCar(intent);
  store.journal!.plan = createPlan(
    { ...profile, filebaseRpcCheck: "sdk-base64-read-only" },
    intent,
  );
  vault.bootstrap.set("FILEBASE_ACCESS_KEY_ID", "access-token-private");
  vault.bootstrap.set("FILEBASE_SECRET_ACCESS_KEY", "secret-key-private");
  store.journal!.steps = {
    "filebase.account": {
      state: "done",
      receipt: { fingerprint: digest("access-token-private") },
    },
    "filebase.bucket": {
      state: "done",
      receipt: { bucket: store.journal!.plan.names.filebase },
    },
    "filebase.upload": {
      state: "done",
      receipt: { cid: probe.cid, sha256: digest(probe.bytes) },
    },
    "filebase.retrieval": {
      state: "done",
      receipt: { cid: probe.cid, passed: true },
    },
  };
  await store.save();
  return {
    store,
    vault,
    probe: { cid: probe.cid, sha256: digest(probe.bytes) },
  };
}
test("Filebase-only plans need no OpenAI organization and legacy plans keep their old limits", async () => {
  const { openaiOrganization: _unused, ...filebaseOnly } = profile;
  const plan = createPlan(filebaseOnly, intent);
  assert.equal(plan.profile.openaiOrganization, undefined);
  assert.equal(plan.limits.filebaseRpcRead, undefined);
  assert.deepEqual(planFrom(plan), plan);
  const old = createPlan(profile, intent);
  assert.deepEqual(planFrom(old), old);
  const store = await state();
  store.journal!.plan = plan;
  let reads = 0;
  const ctx = new Context(store, {
    async get() {
      reads++;
      return undefined;
    },
    async put() {},
  });
  await assert.rejects(provisionOpenAi(ctx), /openai_organization_required/);
  assert.equal(reads, 0);
  await assert.rejects(
    qualifyRpcRead(ctx, { cid: "unused", sha256: "unused" }),
    /not_authorized/,
  );
});
test("opted-in RPC probe reads only the verified CID and never exports the candidate credential", async () => {
  const f = await prepared();
  let reads = 0;
  const candidate = Buffer.from(
    `access-token-private:secret-key-private:${f.store.journal!.plan.names.filebase}`,
  ).toString("base64");
  const ctx = new Context(f.store, f.vault, async (request) => {
    reads++;
    const url = new URL(request.url);
    assert.equal(url.origin, "https://rpc.filebase.io");
    assert.equal(url.pathname, "/api/v0/pin/ls");
    assert.equal(url.searchParams.get("arg"), f.probe.cid);
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("authorization"), `Bearer ${candidate}`);
    return Response.json({ Keys: { [f.probe.cid]: { Type: "recursive" } } });
  });
  const receipt = await qualifyRpcRead(ctx, f.probe);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.runtimeCredentialReady, false);
  assert.equal(receipt.scopeProof, "not_established");
  assert.equal(receipt.expiryProof, "not_established");
  await qualifyRpcRead(ctx, f.probe);
  assert.equal(reads, 1);
  assert.equal(f.vault.runtime.size, 0);
  const disk = await readFile(join(f.store.directory, "journal.json"), "utf8");
  for (const secret of [
    candidate,
    "access-token-private",
    "secret-key-private",
  ])
    assert(!disk.includes(secret));
});
test("RPC credential rejection is evidence, not a token mint or a retry", async () => {
  const f = await prepared();
  let reads = 0;
  const ctx = new Context(f.store, f.vault, async () => {
    reads++;
    return new Response("secret-bearing response", { status: 401 });
  });
  const receipt = await qualifyRpcRead(ctx, f.probe);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.result, "candidate_rejected");
  assert.equal(receipt.httpStatus, 401);
  await qualifyRpcRead(ctx, f.probe);
  assert.equal(reads, 1);
  assert.equal(f.vault.runtime.size, 0);
  assert(
    !JSON.stringify(f.store.summary()).includes("secret-bearing response"),
  );
});
test("unknown RPC reads have a durable three-attempt bound without any upload or pin operation", async () => {
  const f = await prepared();
  let reads = 0;
  const originalUpload = structuredClone(
    f.store.journal!.steps["filebase.upload"],
  );
  const ctx = new Context(f.store, f.vault, async () => {
    reads++;
    throw Error("private request details");
  });
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      qualifyRpcRead(ctx, f.probe),
      /provider_request_uncertain/,
    );
  await assert.rejects(qualifyRpcRead(ctx, f.probe), /attempts_exhausted/);
  assert.equal(reads, 3);
  assert.deepEqual(f.store.journal!.steps["filebase.upload"], originalUpload);
});
test("RPC probe requires the existing exact S3 proof and account before contacting RPC", async () => {
  const f = await prepared();
  let reads = 0;
  const ctx = new Context(f.store, f.vault, async () => {
    reads++;
    throw Error("must not call");
  });
  await assert.rejects(
    qualifyRpcRead(ctx, { ...f.probe, sha256: "wrong" }),
    /binding_mismatch/,
  );
  f.vault.bootstrap.set("FILEBASE_ACCESS_KEY_ID", "another-account-token");
  await assert.rejects(qualifyRpcRead(ctx, f.probe), /account_changed/);
  assert.equal(reads, 0);
});
test("RPC response parsing cannot echo credentials and cannot pass an unrelated pin", async () => {
  const f = await prepared();
  const ctx = new Context(
    f.store,
    f.vault,
    async () => new Response("secret-key-private invalid JSON"),
  );
  await assert.rejects(qualifyRpcRead(ctx, f.probe), (error) => {
    assert.equal(
      (error as Error).message,
      "rpc_response_invalid_details_withheld",
    );
    return true;
  });
  const other = new Context(f.store, f.vault, async () =>
    Response.json({ Keys: { unrelated: {} } }),
  );
  await assert.rejects(qualifyRpcRead(other, f.probe), /pin_not_confirmed/);
});
