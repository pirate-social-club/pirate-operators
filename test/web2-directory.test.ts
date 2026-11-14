import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { web2DirectoryFixture, a, h } from "./fixtures/web2-directory.ts";
import {
  directoryV3Abi,
  parseWeb2ProfileDocument,
  validateWeb2Profile,
  web2ProfileDocument,
} from "../packages/community/web2-directory.ts";
import {
  parseWeb2Configuration,
  validateWeb2Configuration,
  advanceWeb2Configuration,
  web2ConfigurationState,
} from "../packages/community/web2-config-manifest.ts";
import { readWeb2Community } from "../packages/community/web2-directory-reader.ts";
import {
  prepareWeb2Registration,
  bindWeb2RegistrationTransaction,
  observeWeb2Registration,
} from "../packages/community/web2-registration-chain.ts";
import { hashText, canonical } from "../packages/community/common.ts";

// Public disposable local fixture account; never funded or sent to a provider.
const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
const limits = {
  nonce: 7,
  gas: 900000n,
  maxFeePerGas: 3n,
  maxPriorityFeePerGas: 1n,
};
async function original() {
  const f = await web2DirectoryFixture(),
    plan = prepareWeb2Registration(
      f.profile,
      f.config,
      f.records[0]!.pin.uri,
      account.address.toLowerCase() as Hex,
      1n,
    );
  const raw = await account.signTransaction({
    type: "eip1559",
    chainId: 31337,
    to: plan.profile.directory,
    data: plan.data,
    value: 0n,
    ...limits,
  });
  const operation = await bindWeb2RegistrationTransaction(plan, raw, limits);
  f.state.originalHash = operation.transactionHash;
  f.state.from = plan.registrar;
  return { f, plan, raw, operation };
}
test("V3 profile needs no registry, TLD or origin and explicitly rejects V2 fallback", async () => {
  const f = await web2DirectoryFixture();
  assert.deepEqual(
    parseWeb2ProfileDocument(web2ProfileDocument(f.profile)),
    f.profile,
  );
  for (const patch of [
    { schema: "pirate.shared-directory/2" },
    { registry: a("2") },
    { directoryAbiSha256: h("f") },
    { communityId: h("f") },
    { sourceCommit: "1".repeat(40) + "\n" },
  ])
    assert.throws(() => validateWeb2Profile({ ...f.profile, ...patch }));
  for (const bad of ["50\n", "050", "50\r\n", "50\u2028"])
    assert.throws(() =>
      parseWeb2ProfileDocument({
        ...web2ProfileDocument(f.profile),
        deploymentBlock: bad,
      }),
    );
});
test("Web2 enrollment encodes stable installation and revisioned origin with bounded registrar selection", async () => {
  const { plan } = await original(),
    decoded = decodeFunctionData({ abi: directoryV3Abi, data: plan.data });
  assert.equal(decoded.functionName, "registerHostedCommunity");
  if (decoded.functionName !== "registerHostedCommunity")
    throw Error("selector");
  assert.equal(decoded.args[0].communityKey, plan.profile.communityKey);
  assert.equal(decoded.args[0].installationId, plan.profile.installationId);
  assert.equal(decoded.args[1].learningRecords, a("0"));
  assert.equal(decoded.args[1].sha256Digest, hashText(canonical(plan.config)));
  assert.equal(decoded.args[2], hashText(plan.config.app.origin));
  assert.equal(decoded.args[3], 1n);
  assert.throws(() =>
    prepareWeb2Registration(
      plan.profile,
      plan.config,
      plan.uri,
      plan.registrar,
      0n,
    ),
  );
  assert.throws(
    () =>
      prepareWeb2Registration(
        plan.profile,
        { ...plan.config, learningRecords: a("9") },
        plan.uri,
        plan.registrar,
        1n,
      ),
    /first_song_learning_disabled/,
  );
  assert.throws(() =>
    prepareWeb2Registration(
      plan.profile,
      { ...plan.config, configurationRevision: 2 },
      plan.uri,
      plan.registrar,
      1n,
    ),
  );
});
test("configuration validates address and rejects unbound HNS fields and alternate identity", async () => {
  const f = await web2DirectoryFixture();
  for (const patch of [
    { registry: a("2") },
    { installationId: h("a") },
    { communityId: h("f") },
  ])
    assert.throws(() =>
      validateWeb2Configuration({ ...f.config, ...patch }, f.profile),
    );
  assert.throws(() =>
    parseWeb2Configuration({
      ...f.config,
      app: { ...f.config.app, origin: "http://community.example" },
    }),
  );
  assert.throws(() =>
    parseWeb2Configuration({
      ...f.config,
      feed: { ...f.config.feed, endpoint: "https://other.example/api/feed" },
    }),
  );
});
test("reader authenticates ordinary Web2 community with no HNS and uses safe only", async () => {
  const f = await web2DirectoryFixture(),
    result = await readWeb2Community(f.client, f.profile, f.transport);
  assert.equal(result.config.communityId, f.profile.communityId);
  assert.equal(result.config.learningRecords, a("0"));
  assert.equal(result.discoverable, true);
  assert.equal(result.hnsVerified, false);
  assert.equal(result.blockNumber, f.state.safe);
});
test("reader accepts revisioned origin A-B-A while preserving community/posts identity", async () => {
  const f = await web2DirectoryFixture(3),
    result = await readWeb2Community(f.client, f.profile, f.transport);
  assert.equal(result.config.configurationRevision, 3);
  assert.equal(result.config.app.origin, f.config.app.origin);
  assert.equal(result.origin.revision, 3n);
  assert.equal(result.config.postsContract, f.config.postsContract);
});
test("reader refuses a hidden manifest origin change through ordinary configure or transfer", async () => {
  const f = await web2DirectoryFixture(2, "hidden-origin");
  await assert.rejects(
    readWeb2Community(f.client, f.profile, f.transport),
    /configuration_origin_mismatch/,
  );
});
test("reader crosses revision 256 with bounded pages and authenticated contiguous history", async () => {
  const f = await web2DirectoryFixture(260),
    result = await readWeb2Community(f.client, f.profile, f.transport);
  assert.equal(result.config.configurationRevision, 260);
  assert.ok(f.state.logRanges.length > 1);
});
for (const [fault, error] of [
  ["chain", "wrong_application_chain"],
  ["code", "directory_binding_changed"],
  ["safe-missing", "Block"],
  ["reorg", "provenance_changed|chain_reorganized"],
  ["gap", "history_conflict|history_missing"],
  ["receipt", "provenance_changed"],
]) {
  test(`Web2 reader refuses ${fault} without stale/legacy fallback`, async () => {
    const f = await web2DirectoryFixture(2, fault);
    await assert.rejects(
      readWeb2Community(f.client, f.profile, f.transport),
      new RegExp(error!),
    );
  });
}
test("configuration history keeps cumulative revocations and immutable post identity", async () => {
  const f = await web2DirectoryFixture(),
    state = web2ConfigurationState();
  const first = parseWeb2Configuration(f.config);
  advanceWeb2Configuration(state, first, 51n);
  const second = parseWeb2Configuration({
    ...f.config,
    configurationRevision: 2,
    publisher: a("7"),
    publisherRevocations: [
      {
        postsContract: f.config.postsContract,
        publisher: f.config.publisher,
        fromBlock: "51",
      },
    ],
  });
  advanceWeb2Configuration(state, second, 52n);
  assert.throws(
    () =>
      advanceWeb2Configuration(
        state,
        { ...second, configurationRevision: 3, publisherRevocations: [] },
        53n,
      ),
    /revocation_removed/,
  );
  assert.throws(
    () =>
      advanceWeb2Configuration(
        state,
        { ...second, configurationRevision: 3, postsContract: a("8") },
        53n,
      ),
    /wrong_configuration_history/,
  );
});
test("recovery consumes original canonical success without consulting current controller or HNS", async () => {
  const { f, operation } = await original(),
    result = await observeWeb2Registration(f.client, operation);
  assert.equal(result.status, "consumed");
  assert.equal(
    result.original.transactionHash,
    keccak256(operation.rawTransaction),
  );
});
test("recovery requires safe inclusion and retains exact original for pending/reverted", async () => {
  const { f, operation } = await original();
  f.state.safe = 50n;
  assert.equal(
    (await observeWeb2Registration(f.client, operation)).status,
    "pending",
  );
  f.state.safe = 51n;
  assert.equal(
    (await observeWeb2Registration(f.client, operation)).status,
    "consumed",
  );
  f.state.receiptStatus = "0x0";
  assert.equal(
    (await observeWeb2Registration(f.client, operation)).status,
    "reverted",
  );
  f.state.receiptMissing = true;
  assert.equal(
    (await observeWeb2Registration(f.client, operation)).status,
    "pending",
  );
});
test("recovery refuses raw A paired with hash B before asking for any receipt", async () => {
  const { f, operation } = await original();
  await assert.rejects(
    observeWeb2Registration(f.client, {
      ...operation,
      transactionHash: h("b"),
    }),
    /original_directory_transaction_mismatch/,
  );
  assert.equal(f.state.queries.length, 0);
});
test("four closed limits cannot overwrite original identity", async () => {
  const { plan, raw } = await original();
  const extra = { ...limits, transactionHash: h("f"), rawTransaction: "0x" };
  const operation = await bindWeb2RegistrationTransaction(plan, raw, extra);
  assert.equal(operation.transactionHash, keccak256(raw));
  assert.equal(operation.rawTransaction, raw);
  assert.equal(Object.isFrozen(operation), true);
});
test("deferred client mutation cannot change reconstructed original operation", async () => {
  const { f, operation } = await original(),
    mutable = { ...operation };
  f.state.mutate = () => {
    mutable.transactionHash = h("b");
    mutable.rawTransaction = "0x";
    mutable.nonce++;
  };
  const result = await observeWeb2Registration(f.client, mutable);
  assert.equal(result.status, "consumed");
  assert.equal(result.original.transactionHash, operation.transactionHash);
  assert.deepEqual(f.state.queries, [operation.transactionHash]);
});
test("recovery refuses mismatching sender, registrar revision and transaction limits", async () => {
  const { f, plan, raw, operation } = await original();
  f.state.from = a("9");
  await assert.rejects(
    observeWeb2Registration(f.client, operation),
    /authentication_failed/,
  );
  await assert.rejects(
    bindWeb2RegistrationTransaction(plan, raw, { ...limits, nonce: 8 }),
    /transaction_mismatch/,
  );
  await assert.rejects(
    bindWeb2RegistrationTransaction(
      { ...plan, registrarRevision: 2n },
      raw,
      limits,
    ),
    /plan_changed/,
  );
});

test("Web2 evidence binds exact address/controller/community with canonical fields", async () => {
  const { web2EvidenceCommitment } = await import(
    "../packages/community/web2-address-evidence.ts"
  );
  const f = await web2DirectoryFixture();
  const e = {
    schema: "pirate.web2-address-evidence/1",
    chainId: 31337,
    directory: f.profile.directory,
    communityId: f.profile.communityId,
    installationId: f.profile.installationId,
    controller: f.config.controller,
    controllerRevision: "1",
    origin: f.config.app.origin,
    originRevision: "1",
    method: "dns-txt",
    challengeDigest: h("1"),
    observationDigest: h("2"),
    observedAt: "10000",
  };
  const result = web2EvidenceCommitment(f.profile, e);
  assert.equal(result.sha256, hashText(canonical(e)));
  for (const patch of [
    { communityId: h("b") },
    { installationId: h("b") },
    { chainId: 6343 },
    { observedAt: "10000\n" },
    { originRevision: "01" },
    { extra: true },
  ])
    assert.throws(() => web2EvidenceCommitment(f.profile, { ...e, ...patch }));
  for (const patch of [
    { controller: a("9") },
    { origin: "https://new.example" },
    { method: "https" },
    { challengeDigest: h("3") },
  ])
    assert.notEqual(
      web2EvidenceCommitment(f.profile, { ...e, ...patch }).sha256,
      result.sha256,
    );
});
