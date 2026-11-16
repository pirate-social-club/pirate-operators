import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, digest } from "../packages/protocol/index.ts";
import { publicationCommandFetch } from "../services/publication-command-api.ts";
import { intentOf } from "../services/operator-tx.ts";
import { publicationCommandFixture } from "./fixtures/publication-command.ts";

// Public disposable test keys, never managed or funded public-chain accounts.
const issuer = privateKeyToAccount(`0x${"71".repeat(32)}`);
const otherIssuer = privateKeyToAccount(`0x${"79".repeat(32)}`);
const now = 1800000000;
const snapshot = (store: Awaited<ReturnType<typeof publicationCommandFixture>>["store"]) =>
  Object.fromEntries(store.entries("").map(({ key, value }) => [key, value]));
async function signedRequest(body: unknown, path: string, source: unknown,
  operator: string, signer = issuer, overrides: Record<string, unknown> = {}, omit: string[] = []) {
  const text = canonical(body);
  const b = body as {commandId?:string;command?:{commandId:string}};
  const id = b.commandId ?? b.command?.commandId;
  const request: Record<string,unknown> = { schema: "pirate.publication.operator-request/1", method: "POST", path,
    chainId: 31337, communityId: (source as {communityId:string}).communityId,
    installationId: "fixture-installation", sourceSha256: digest(source), operator,
    issuedAt: now, expiresAt: now + 60, bodyHash: sha256(new TextEncoder().encode(text)),
    commandId: id, nonce: digest({ schema: "fixture-issuer-nonce/1", id, path }),
    ...overrides };
  for (const name of omit) delete request[name];
  const signature = await signer.signMessage({ message: canonical(request) });
  return new Request("https://operator.example" + path, { method: "POST", body: text,
    headers: { "x-pirate-publication-authorization": canonical({ request, signature }) } });
}

test("authenticated issuer HTTP replay recovers an original allocation without another intent or current cap", async t => {
  const f = await publicationCommandFixture(t);
  const body = { command: f.command, signature: f.job.signature, fee: f.job.fee };
  const rpc = f.scripted();
  const ports = { issuer: { source: f.command.source, issuer: issuer.address,
    operator: f.job.fee.payer }, store: f.store, read: rpc.read, clock: () => now };
  const before = snapshot(f.store), originalRow = f.row();
  const request = await signedRequest(body, "/publication/v1/accept", f.command.source, f.job.fee.payer);
  const response = await publicationCommandFetch(request, ports);
  assert.equal(response?.status, 200);
  const receipt = await response!.json() as { state:string; transactionHash:string };
  assert.equal(receipt.state, "reverted");
  assert.equal(receipt.transactionHash, f.hash);
  assert.equal(f.row().raw, originalRow.raw);
  assert.equal(f.row().hash, originalRow.hash);
  assert.equal(f.row().nonce, originalRow.nonce);
  for (const key of ["op:nonce", `intent:${f.job.kind}:${f.job.ref}`])
    assert.deepEqual(f.store.get(key), before[key]);
  assert.equal(f.store.entries("intent:").length, 1);
  assert.equal(intentOf(f.store, f.job.kind, f.job.ref)?.nonce, 0);
  assert.ok(rpc.calls.every(c => !/send|gasPrice|estimateGas/.test(c.method)));
  t.diagnostic(JSON.stringify({ artifact: "publication-command-http/1",
    commandId: f.command.commandId, originalHash: f.hash, payerNonce: 0,
    originalReconciled: true, newIntents: 0, broadcasts: 0 }));
});

test("issuer authentication rejects another signer, expired envelope and signed-body changes before journal effects", async t => {
  const f = await publicationCommandFixture(t);
  const body = { commandId: f.command.commandId };
  const rpc = f.scripted();
  const ports = { issuer: { source: f.command.source, issuer: issuer.address,
    operator: f.job.fee.payer }, store: f.store, read: rpc.read, clock: () => now };
  const before = snapshot(f.store);
  for (const request of [
    await signedRequest(body, "/publication/v1/reconcile", f.command.source, f.job.fee.payer, otherIssuer),
    await signedRequest(body, "/publication/v1/reconcile", f.command.source, f.job.fee.payer,
      issuer, { issuedAt: now - 60, expiresAt: now }),
    await signedRequest(body, "/publication/v1/reconcile", f.command.source, f.job.fee.payer,
      issuer, { bodyHash: digest("different-body") }),
  ]) {
    await assert.rejects(publicationCommandFetch(request, ports), /publication_/);
    assert.deepEqual(snapshot(f.store), before);
    assert.equal(rpc.calls.length, 0);
  }
});

test("a changed accepted envelope cannot replace the original through authenticated HTTP", async t => {
  const f = await publicationCommandFixture(t), rpc = f.scripted();
  const ports = { issuer: { source: f.command.source, issuer: issuer.address,
    operator: f.job.fee.payer }, selectedFee: f.job.fee,
    store: f.store, read: rpc.read, clock: () => now };
  const before = snapshot(f.store);
  const request = await signedRequest({ command: f.command, signature: "0x1234", fee: f.job.fee },
    "/publication/v1/accept", f.command.source, f.job.fee.payer);
  await assert.rejects(publicationCommandFetch(request, ports), /publication_command_changed/);
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(rpc.calls.length, 0);
});

test("issuer transport explicitly binds the command identity and requires its nonce", async t => {
  const f = await publicationCommandFixture(t), rpc = f.scripted();
  const ports = { issuer: { source: f.command.source, issuer: issuer.address,
    operator: f.job.fee.payer }, store: f.store, read: rpc.read, clock: () => now };
  const before = snapshot(f.store), body = { commandId: f.command.commandId };
  for (const request of [
    await signedRequest(body, "/publication/v1/reconcile", f.command.source, f.job.fee.payer,
      issuer, { commandId: digest("another-command") }),
    await signedRequest(body, "/publication/v1/reconcile", f.command.source, f.job.fee.payer,
      issuer, {}, ["nonce"]),
    await signedRequest(body, "/publication/v1/reconcile", f.command.source, f.job.fee.payer,
      issuer, { nonce: `0x${"00".repeat(32)}` }),
  ]) {
    await assert.rejects(publicationCommandFetch(request, ports), /publication_/);
    assert.deepEqual(snapshot(f.store), before);
    assert.equal(rpc.calls.length, 0);
  }
});
