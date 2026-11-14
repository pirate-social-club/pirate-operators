import test from "node:test";
import assert from "node:assert/strict";
import { BlockNotFoundError, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sharedDirectoryFixture } from "./fixtures/shared-directory.ts";
import { prepareSharedRegistration, bindSharedRegistrationTransaction, observeSharedRegistration } from "../packages/community/shared-registration-chain.ts";
import { sharedBinding, sharedDirectoryAbi } from "../packages/community/shared-directory.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { canonical, hashText } from "../packages/community/common.ts";
import { inspectSharedSetup } from "../harness/megaeth/setup-community-shared.ts";
import { verifySharedCommunity } from "../harness/megaeth/verify-community-shared.ts";

// Public disposable LOCAL fixture key only; never used with a provider.
const account = privateKeyToAccount("0x" + "1".repeat(64) as Hex);
const limits = { nonce: 7, gas: 900000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 1n };
async function prepared() {
  const f = await sharedDirectoryFixture(), pin = await preparePin(new TextEncoder().encode(canonical(f.config)), "application/json");
  // Explicit simulated safe tag for these enrollment cases. Existing numeric
  // block fixture behavior and every existing assertion remain unchanged.
  f.client = new Proxy(f.client, { get(target, key) {
    if (key === "getBlock") return (input: Parameters<typeof target.getBlock>[0]) =>
      input?.blockTag === "safe" ? target.getBlock({ blockNumber: f.state.head - 1n }) : target.getBlock(input);
    return Reflect.get(target, key);
  } });
  const plan = prepareSharedRegistration(f.profile, f.config, pin.uri, account.address.toLowerCase() as Hex);
  const raw = await account.signTransaction({ type: "eip1559", chainId: 31337, to: plan.profile.directory,
    data: plan.data, value: 0n, ...limits });
  return { f, plan, raw, operation: await bindSharedRegistrationTransaction(plan, raw, limits) };
}
test("shared enrollment encodes full namespace/install/source binding and exact configuration", async () => {
  const { plan } = await prepared();
  const call = decodeFunctionData({ abi: sharedDirectoryAbi, data: plan.data });
  assert.equal(call.functionName, "registerSharedCommunity");
  if (call.functionName !== "registerSharedCommunity") throw new Error("wrong selector");
  assert.equal(call.args[0].toLowerCase(), plan.profile.registry);
  assert.deepEqual(call.args[2], sharedBinding(plan.profile));
  assert.equal(call.args[3].sha256Digest, hashText(canonical(plan.config)));
  assert.throws(() => prepareSharedRegistration(plan.profile, { ...plan.config, configurationRevision: 2 }, plan.uri, plan.admin));
});
test("original signed transaction refuses different nonce, gas, destination, sender and changed plan", async () => {
  const { plan, raw, operation } = await prepared();
  assert.equal(operation.transactionHash, keccak256(raw));
  for (const changed of [{ ...limits, nonce: 8 }, { ...limits, gas: 900001n }, { ...limits, maxFeePerGas: 0n }])
    await assert.rejects(bindSharedRegistrationTransaction(plan, raw, changed));
  await assert.rejects(bindSharedRegistrationTransaction({ ...plan, data: "0x" }, raw, limits), /registration_plan_changed/);
  const changedRaw = await account.signTransaction({ type: "eip1559", chainId: 31337, to: "0x" + "9".repeat(40) as Hex,
    data: plan.data, value: 0n, ...limits });
  await assert.rejects(bindSharedRegistrationTransaction(plan, changedRaw, limits));
});
test("setup inspection pins the exact current admin and source without claiming issuance permission", async () => {
  const f = await sharedDirectoryFixture(), pin = await preparePin(new TextEncoder().encode(canonical(f.config)), "application/json");
  const plan = prepareSharedRegistration(f.profile, f.config, pin.uri, f.config.controller);
  assert.equal((await inspectSharedSetup(f.client, plan)).issuanceAuthorized, false);
  await assert.rejects(inspectSharedSetup(f.client, { ...plan, admin: "0x" + "9".repeat(40) as Hex }));
});
test("confirmed registration is recovered from the original successful canonical receipt, independently of current controller", async () => {
  const { f, plan, operation } = await prepared();
  const hash = f.state.hash, tx = operation.transactionHash;
  const configEvent = sharedDirectoryAbi.find((item) => item.type === "event" && item.name === "ConfigurationPublished");
  const boundEvent = sharedDirectoryAbi.find((item) => item.type === "event" && item.name === "CommunityBound");
  assert.ok(configEvent?.type === "event" && boundEvent?.type === "event");
  const logs = [
    { address: f.profile.directory, blockHash: hash, blockNumber: 51n, transactionHash: tx, logIndex: 0, transactionIndex: 0, removed: false,
      topics: encodeEventTopics({ abi: sharedDirectoryAbi, eventName: "CommunityBound", args: { communityId: f.profile.communityId } }),
      data: encodeAbiParameters(boundEvent.inputs.filter((i) => !("indexed" in i && i.indexed)), [sharedBinding(f.profile)]) },
    { address: f.profile.directory, blockHash: hash, blockNumber: 51n, transactionHash: tx, logIndex: 1, transactionIndex: 0, removed: false,
      topics: encodeEventTopics({ abi: sharedDirectoryAbi, eventName: "ConfigurationPublished", args: { communityId: f.profile.communityId } }),
      data: encodeAbiParameters(configEvent.inputs.filter((i) => !("indexed" in i && i.indexed)), [1n, plan.config.controller, plan.config.publisher,
        plan.config.operatorPayments, plan.config.learningRecords, hashText(canonical(plan.config)), plan.uri]) },
  ];
  let status = "success", receiptHash = hash;
  const client = new Proxy(f.client, { get(target, key) {
    if (key === "getTransactionReceipt") return async () => ({ status, transactionHash: tx, to: plan.profile.directory,
      from: plan.admin, blockNumber: 51n, blockHash: receiptHash, logs });
    if (key === "readContract") return async () => { throw new Error("current state must not determine consumption"); };
    return Reflect.get(target, key);
  } });
  assert.equal((await observeSharedRegistration(client, operation)).status, "consumed");
  receiptHash = "0x" + "b".repeat(64) as Hex;
  await assert.rejects(observeSharedRegistration(client, operation), /authentication_failed/);
  receiptHash = hash; status = "reverted";
  assert.equal((await observeSharedRegistration(client, operation)).status, "reverted");
});

// Same enrollment events for an explicitly selected transaction hash. This
// adversarial RPC fixture must not turn a different transaction into the original.
function matchingEnrollmentReceipt(fixture: Awaited<ReturnType<typeof prepared>>, transactionHash: Hex) {
  const { f, plan } = fixture, blockHash = f.state.hash;
  const configEvent = sharedDirectoryAbi.find((item) => item.type === "event" && item.name === "ConfigurationPublished");
  const boundEvent = sharedDirectoryAbi.find((item) => item.type === "event" && item.name === "CommunityBound");
  assert.ok(configEvent?.type === "event" && boundEvent?.type === "event");
  const common = { address: f.profile.directory, blockHash, blockNumber: 51n, transactionHash, transactionIndex: 0, removed: false };
  return { status: "success" as const, transactionHash, to: plan.profile.directory, from: plan.admin, blockNumber: 51n, blockHash,
    logs: [
      { ...common, logIndex: 0,
        topics: encodeEventTopics({ abi: sharedDirectoryAbi, eventName: "CommunityBound", args: { communityId: f.profile.communityId } }),
        data: encodeAbiParameters(boundEvent.inputs.filter((i) => !("indexed" in i && i.indexed)), [sharedBinding(f.profile)]) },
      { ...common, logIndex: 1,
        topics: encodeEventTopics({ abi: sharedDirectoryAbi, eventName: "ConfigurationPublished", args: { communityId: f.profile.communityId } }),
        data: encodeAbiParameters(configEvent.inputs.filter((i) => !("indexed" in i && i.indexed)), [1n, plan.config.controller, plan.config.publisher,
          plan.config.operatorPayments, plan.config.learningRecords, hashText(canonical(plan.config)), plan.uri]) },
    ],
  };
}

test("recovery refuses raw A/hash B and a matching enrollment receipt for another transaction", async () => {
  const fixture = await prepared(), { f, plan, operation } = fixture;
  const rawB = await account.signTransaction({ type: "eip1559", chainId: 31337, to: plan.profile.directory,
    data: plan.data, value: 0n, ...limits, nonce: limits.nonce + 1 });
  const hashB = keccak256(rawB), queried: Hex[] = [];
  assert.notEqual(hashB, operation.transactionHash);
  const receiptB = matchingEnrollmentReceipt(fixture, hashB);
  const client = new Proxy(f.client, { get(target, key) {
    if (key === "getTransactionReceipt") return async (input: Parameters<typeof target.getTransactionReceipt>[0]) => {
      queried.push(input.hash);
      return receiptB;
    };
    return Reflect.get(target, key);
  } });
  await assert.rejects(observeSharedRegistration(client, { ...operation, transactionHash: hashB }), /original_directory_transaction_mismatch/);
  assert.deepEqual(queried, []);
  // Even a correct original journal must refuse an RPC returning B for query A.
  await assert.rejects(observeSharedRegistration(client, operation), /directory_receipt_authentication_failed/);
  assert.deepEqual(queried, [operation.transactionHash]);
});

test("only four primitive limits survive binding; extra fields and mutations cannot replace the original", async () => {
  const { plan, raw, operation } = await prepared();
  const mutablePlan = structuredClone(plan);
  const poisoned = { ...limits, schema: "untrusted-schema", plan: { ...plan, admin: "0x" + "9".repeat(40) },
    rawTransaction: "0x", transactionHash: "0x" + "b".repeat(64), extra: true };
  const pending = bindSharedRegistrationTransaction(mutablePlan, raw, poisoned);
  // The signature recovery await must not permit either input to change the
  // validated limits, signer, original bytes or nested configuration snapshot.
  poisoned.nonce++;
  poisoned.gas++;
  mutablePlan.admin = "0x" + "9".repeat(40) as Hex;
  mutablePlan.config.app.origin = "https://changed.example";
  const rebound = await pending;
  assert.deepEqual(rebound, operation);
  assert.deepEqual(Object.keys(rebound).sort(), ["schema", "plan", "rawTransaction", "transactionHash",
    "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas"].sort());
  assert.equal("extra" in rebound, false);
  assert.ok(Object.isFrozen(rebound) && Object.isFrozen(rebound.plan) && Object.isFrozen(rebound.plan.config.app));
});

test("recovery queries and returns one immutable original despite mutation during a deferred client read", async () => {
  const fixture = await prepared(), { f, operation } = fixture;
  const mutable = structuredClone(operation), queried: Hex[] = [];
  let arrived!: () => void, release!: (chainId: number) => void;
  const atRead = new Promise<void>((resolve) => { arrived = resolve; });
  const chainId = new Promise<number>((resolve) => { release = resolve; });
  const receipt = matchingEnrollmentReceipt(fixture, operation.transactionHash);
  const client = new Proxy(f.client, { get(target, key) {
    if (key === "getChainId") return () => { arrived(); return chainId; };
    if (key === "getTransactionReceipt") return async (input: Parameters<typeof target.getTransactionReceipt>[0]) => {
      queried.push(input.hash); return receipt;
    };
    return Reflect.get(target, key);
  } });
  const pending = observeSharedRegistration(client, mutable);
  await atRead;
  mutable.transactionHash = "0x" + "b".repeat(64) as Hex;
  mutable.rawTransaction = "0x";
  mutable.nonce++;
  mutable.gas++;
  mutable.plan.admin = "0x" + "9".repeat(40) as Hex;
  mutable.plan.profile.communityId = "0x" + "e".repeat(64) as Hex;
  mutable.plan.profile.registryCodeHash = "0x" + "f".repeat(64) as Hex;
  mutable.plan.config.publisher = "0x" + "9".repeat(40) as Hex;
  mutable.plan.config.app.origin = "https://changed.example";
  mutable.plan.data = "0x";
  release(31337);
  const result = await pending;
  assert.equal(result.status, "consumed");
  assert.deepEqual(queried, [operation.transactionHash]);
  assert.deepEqual(result.original, operation);
  assert.notStrictEqual(result.original, mutable);
  for (const value of [result.original, result.original.plan, result.original.plan.profile, result.original.plan.config,
    result.original.plan.config.app, result.original.plan.config.feed, result.original.plan.config.policies,
    result.original.plan.config.policies.admission, result.original.plan.config.publisherRevocations])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => { result.original.plan.config.app.origin = "https://changed.example"; }, TypeError);
});

test("adjacent setup inspection checks and returns its reconstructed plan across deferred reads", async () => {
  const f = await sharedDirectoryFixture(), pin = await preparePin(new TextEncoder().encode(canonical(f.config)), "application/json");
  const originalPlan = prepareSharedRegistration(f.profile, f.config, pin.uri, f.config.controller), mutable = structuredClone(originalPlan);
  let arrived!: () => void, release!: (chainId: number) => void;
  const atRead = new Promise<void>((resolve) => { arrived = resolve; });
  const chainId = new Promise<number>((resolve) => { release = resolve; });
  const client = new Proxy(f.client, { get(target, key) {
    if (key === "getChainId") return () => { arrived(); return chainId; };
    return Reflect.get(target, key);
  } });
  const pending = inspectSharedSetup(client, mutable);
  await atRead;
  mutable.admin = "0x" + "9".repeat(40) as Hex;
  mutable.profile.communityId = "0x" + "e".repeat(64) as Hex;
  mutable.config.publisher = "0x" + "9".repeat(40) as Hex;
  mutable.config.feed.endpoint = "https://changed.example/api/feed";
  mutable.data = "0x";
  release(31337);
  const result = await pending;
  assert.deepEqual(result.plan, originalPlan);
  assert.notStrictEqual(result.plan, mutable);
  assert.ok(Object.isFrozen(result.plan) && Object.isFrozen(result.plan.config.feed));
  assert.equal(result.issuanceAuthorized, false);
});

test("adjacent verification keeps the verified and returned identity on one snapshot across deferred reads", async () => {
  const f = await sharedDirectoryFixture(), original = structuredClone(f.profile), mutable = structuredClone(original);
  let arrived!: () => void, release!: (chainId: number) => void;
  const atRead = new Promise<void>((resolve) => { arrived = resolve; });
  const chainId = new Promise<number>((resolve) => { release = resolve; });
  const client = new Proxy(f.client, { get(target, key) {
    if (key === "getChainId") return () => { arrived(); return chainId; };
    return Reflect.get(target, key);
  } });
  const pending = verifySharedCommunity(client, mutable, f.transport);
  await atRead;
  mutable.communityId = "0x" + "b".repeat(64) as Hex;
  mutable.registry = "0x" + "9".repeat(40) as Hex;
  mutable.hostingOrigin = "https://changed.example";
  mutable.namespaceId = "0x" + "e".repeat(64) as Hex;
  release(31337);
  const result = await pending;
  assert.deepEqual(result.profile, original);
  assert.notStrictEqual(result.profile, mutable);
  assert.equal(result.config.communityId, original.communityId);
  assert.ok(Object.isFrozen(result.profile));
  assert.equal(result.directoryVerified, true);
  assert.equal(result.issuanceAuthorized, false);
});

test("original recovery waits for the safe block and accepts its exact inclusive boundary for success and revert", async () => {
  const fixture = await prepared(), { f, operation } = fixture;
  let safeNumber = 50n, status: "success" | "reverted" = "success", safeReads = 0;
  const client = new Proxy(f.client, { get(target, key) {
    if (key === "getBlockNumber") return async () => { throw new Error("latest_must_not_confirm"); };
    if (key === "getBlock") return (input: Parameters<typeof target.getBlock>[0]) => {
      if (input?.blockTag === "safe") { safeReads++; return target.getBlock({ blockNumber: safeNumber }); }
      return target.getBlock(input);
    };
    if (key === "getTransactionReceipt") return async (input: Parameters<typeof target.getTransactionReceipt>[0]) => {
      assert.equal(input.hash, operation.transactionHash);
      return { ...matchingEnrollmentReceipt(fixture, operation.transactionHash), status };
    };
    return Reflect.get(target, key);
  } });
  for (const result of ["success", "reverted"] as const) {
    status = result; safeNumber = 50n;
    const pending = await observeSharedRegistration(client, operation);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.original, operation);
    safeNumber = 51n;
    const confirmed = await observeSharedRegistration(client, operation);
    assert.equal(confirmed.status, status === "success" ? "consumed" : "reverted");
    assert.deepEqual(confirmed.original, operation);
  }
  assert.equal(safeReads, 4);
});

test("missing unsupported or null safe confirmation refuses without latest fallback or a different original", async () => {
  const fixture = await prepared(), { f, operation } = fixture;
  for (const fault of ["missing", "unsupported", "null", "missing-number"] as const) {
    const failure = fault === "missing" ? new BlockNotFoundError({}) : new Error("safe_tag_unsupported");
    const client = new Proxy(f.client, { get(target, key) {
      if (key === "getBlockNumber") return async () => { throw new Error("latest_fallback_forbidden"); };
      if (key === "getBlock") return async (input: Parameters<typeof target.getBlock>[0]) => {
        if (input?.blockTag === "safe") {
          if (fault === "missing" || fault === "unsupported") throw failure;
          if (fault === "missing-number") return { ...await target.getBlock({ blockNumber: 99n }), number: undefined };
          return { ...await target.getBlock({ blockNumber: 99n }), hash: null };
        }
        return target.getBlock(input);
      };
      if (key === "getTransactionReceipt") return async (input: Parameters<typeof target.getTransactionReceipt>[0]) => {
        assert.equal(input.hash, operation.transactionHash);
        return matchingEnrollmentReceipt(fixture, operation.transactionHash);
      };
      return Reflect.get(target, key);
    } });
    if (fault === "null" || fault === "missing-number") await assert.rejects(observeSharedRegistration(client, operation), /directory_safe_block_unavailable/);
    else await assert.rejects(observeSharedRegistration(client, operation), (error) => error === failure);
    assert.equal(operation.transactionHash, keccak256(operation.rawTransaction));
  }
});

test("both original receipt and safe confirmation block must remain canonical before success or revert returns", async () => {
  const fixture = await prepared(), { f, operation } = fixture;
  for (const status of ["success", "reverted"] as const) for (const changed of ["receipt", "safe"] as const) {
    let receiptReads = 0;
    const client = new Proxy(f.client, { get(target, key) {
      if (key === "getTransactionReceipt") return async () => ({ ...matchingEnrollmentReceipt(fixture, operation.transactionHash), status });
      if (key === "getBlock") return async (input: Parameters<typeof target.getBlock>[0]) => {
        if (input?.blockTag === "safe") return target.getBlock({ blockNumber: 99n });
        const block = await target.getBlock(input);
        if (input?.blockNumber === 51n) receiptReads++;
        if ((changed === "receipt" && input?.blockNumber === 51n && receiptReads > 1) ||
          (changed === "safe" && input?.blockNumber === 99n)) return { ...block, hash: "0x" + "b".repeat(64) as Hex };
        return block;
      };
      return Reflect.get(target, key);
    } });
    await assert.rejects(observeSharedRegistration(client, operation), /directory_chain_reorganized/);
  }
});
