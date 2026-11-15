import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import type { PublicClient, Hex } from "viem";
import { authenticateWeb2Enrollment } from "../deploy/linux/web2-profile-authority.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";

test("Web2 installation authenticates the original safe enrollment and refuses changed source, configuration or stale evidence", { timeout: 120000 }, async t => {
  const f = await installationAuthorityFixture(); t.after(f.close);
  const original = await authenticateWeb2Enrollment(f.authority, f.draft);
  assert.equal(original.transactionHash, f.chain.original.transactionHash);
  assert.equal(original.configurationRevision, 1);
  assert.equal((await f.chain.client.getTransactionReceipt({ hash: original.transactionHash })).status, "success");
  const safe = await f.chain.client.getBlock({ blockNumber: BigInt(original.safeBlock) });
  f.setNow(safe.timestamp + 600n);
  assert.equal((await authenticateWeb2Enrollment(f.authority, f.draft)).transactionHash, original.transactionHash);
  f.setNow(safe.timestamp + 601n);
  await assert.rejects(authenticateWeb2Enrollment(f.authority, f.draft), /install_directory_unavailable/);
  f.setNow(BigInt(Math.floor(Date.now() / 1000)));
  await assert.rejects(authenticateWeb2Enrollment({ ...f.authority,
    deployment: { ...f.authority.deployment, sourceCommit: "0".repeat(40) } }, f.draft), /unadmitted_install_deployment/);

  const wrong = structuredClone(f.draft);
  const deploymentBlock = await f.chain.client.getBlock({ blockNumber: f.chain.profile.deploymentBlock });
  assert(deploymentBlock.transactions[0]);
  wrong.enrollment.operations[0]!.transactionHash = deploymentBlock.transactions[0];
  await assert.rejects(authenticateWeb2Enrollment(f.authority, wrong));

  const snapshot = await f.chain.rpc("evm_snapshot");
  await f.chain.nextRevision(); // real non-role app-label change with new CID/event
  await assert.rejects(authenticateWeb2Enrollment(f.authority, f.draft), /install_current_authority_changed/);
  assert.equal(await f.chain.rpc("evm_revert", [snapshot]), true);
  assert.equal((await authenticateWeb2Enrollment(f.authority, f.draft)).transactionHash, original.transactionHash);
  const code = await f.chain.client.getCode({ address: f.draft.deployment.posts.address }); assert(code);
  await f.chain.rpc("anvil_setCode", [f.draft.deployment.posts.address, "0x60006000fd"]);
  await f.chain.rpc("anvil_mine", ["0x40", "0x0"]);
  await assert.rejects(authenticateWeb2Enrollment(f.authority, f.draft), /install_posts_source_changed/);
  await mkdir(".local/linux-web2-installation", { recursive: true });
  await writeFile(".local/linux-web2-installation/chain-authority.json", JSON.stringify({ original,
    source: f.authority.deployment, exactExpiryChecked: true, nonRoleRevisionRefused: true,
    actualSnapshotRevertChecked: true, changedPostsCodeRefused: true }) + "\n");
});

test("Web2 installation owns its draft and original transaction before deferred RPC reads", { timeout: 120000 }, async t => {
  const f = await installationAuthorityFixture(); t.after(f.close);
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { resume = resolve; });
  const client: PublicClient = { ...f.authority.client, async getTransaction(args) {
    entered(); await paused; return f.authority.client.getTransaction(args);
  } };
  const input = structuredClone(f.draft), expected = input.enrollment.operations[0]!.transactionHash;
  const pending = authenticateWeb2Enrollment({ ...f.authority, client }, input);
  await reading;
  input.enrollment.operations[0]!.transactionHash = `0x${"f".repeat(64)}` as Hex;
  input.configuration.app.label = "mutated while awaiting RPC";
  resume();
  const result = await pending;
  assert.equal(result.transactionHash, expected);
  assert.equal(result.configurationRevision, 1);
  assert.equal((await authenticateWeb2Enrollment(f.authority, f.draft)).transactionHash, expected);
});
