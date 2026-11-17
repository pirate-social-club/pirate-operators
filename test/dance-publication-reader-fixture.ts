/** Scripted ABI read transport + actual local D1. Not a deployed-chain,
 * signature-verifier, provider-readiness or production journal implementation. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { Miniflare } from "miniflare";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult,
  keccak256, stringToHex, type Address, type Hex } from "viem";
import { canonical, hashText, object } from "../packages/community/common.ts";
import { directoryInstanceId } from "../packages/community/shared-identity.ts";
import { directoryV3Abi, directoryV3Build, directoryV3Runtime } from "../packages/community/generated/directory-v3.ts";
import { validateWeb2Profile, web2Binding } from "../packages/community/web2-directory.ts";
import { UNREGISTERED_OWNER_POLICY_VERSION, UNREGISTERED_OWNER_POLICY_HASH } from "../packages/community/owner-policy.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import { danceAccountCommitment, danceCaptureHash, danceSourceHash,
  type DanceCapture, type DanceDecision } from "../packages/dance-chain/v2/wire.ts";
import { publicationConsentAbi } from "../packages/protocol/generated/publication-consent-v1.ts";
import { learningResultsV5Abi } from "../packages/protocol/generated/learning-results-v5.ts";
import { parsePublicationGrant, preparePublicationGrant, preparePublicationWithdrawal } from "../packages/protocol/publication-consent.ts";
import type { BoundPublicationGrantV1, ConsentCommandReceiptV1, ConsentSourceV1,
  GrantWireV1, PreparedConsentCommandV1 } from "../packages/protocol/publication-runtime-v1.ts";
import type { DancePublicationSourceV2 } from "../services/dance-publication-source.ts";
import type { DancePublicationJournal, readDancePublicationAdmission } from "../services/dance-publication-reader.ts";

export const hex = (n: number): Hex => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const addr = (n: number): Address => ("0x" + n.toString(10).padStart(40, "0")) as Address;
const zero = hex(0);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
export type Lease = "owner" | "reviewer" | "learner-grant" | "reviewer-grant";
export async function publicationReaderFixture(options: {
  lease?: Lease; ttl?: bigint; ownerReviewer?: boolean; startOffset?: bigint;
} = {}) {
  const mf = new Miniflare({ modules: true,
    script: "export default { fetch() { return new Response('unused D1 qualification fixture'); } }",
    d1Databases: ["DB"], d1Persist: false });
  try {
    const native = await mf.getD1Database("DB");
    const guard = readFileSync(new URL("../packages/dance/schema.sql", import.meta.url), "utf8")
      .match(/CREATE TABLE dance_transaction_guards[^;]*;/);
    assert.ok(guard, "use the actual accepting-batch guard schema");
    await native.prepare(guard[0]).run();
    for (const sql of [
      "CREATE TABLE publication_test_bindings(capture_hash TEXT,account_id TEXT,purpose TEXT,binding_json TEXT,configuration_revision TEXT,owner_epoch TEXT,PRIMARY KEY(capture_hash,account_id,purpose))",
      "CREATE TABLE publication_test_permissions(account_id TEXT,purpose TEXT,generation TEXT,denied INTEGER CHECK(denied IN(0,1)),PRIMARY KEY(account_id,purpose))",
      "CREATE TABLE publication_test_commands(command_id TEXT PRIMARY KEY,command_json TEXT,receipt_json TEXT)",
      "CREATE TABLE publication_test_acceptance(id TEXT PRIMARY KEY)",
    ]) await native.prepare(sql).run();
    let heldBatch: ReturnType<typeof deferred> | undefined;
    let batchEntered: ReturnType<typeof deferred> | undefined;
    // Observations/gating only. Native statements, SQL, bindings, results and
    // the accepting db.batch are forwarded unchanged; no SQL clock rewriting.
    const db = new Proxy(native, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const gate = heldBatch;
        if (gate) { heldBatch = undefined; batchEntered!.resolve(); await gate.promise; }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as unknown as D1Database;
    const store = new DanceStore(db), base = BigInt(Math.floor(await store.now() / 1000));
    const startedAt = base + (options.startOffset ?? 0n);
    const expires = (kind: Lease) => base + (options.lease === kind ? options.ttl ?? 30n : 300n);
    const state = { now: startedAt, reads: [] as string[], fenceReads: 0, receiptReads: 0,
      grantsDisabled: false, registryReplaced: false,
      hook: undefined as ((key: string) => Promise<void>) | undefined };
    const config: Web2CommunityConfig = {
      schema: "pirate.community-config/4", chainId: 31337, directory: addr(1),
      communityKey: hex(2), communityId: directoryInstanceId(31337, hex(2)),
      installationId: hex(3), configurationRevision: 1, postsContract: addr(4),
      controller: addr(5), publisher: addr(6), operatorPayments: addr(9),
      learningRecords: addr(10),
      app: { label: "Scripted Dance reader qualification", origin: "https://dance.invalid" },
      feed: { endpoint: "https://dance.invalid/api/feed", signingKeyId: "scripted" },
      policies: { admission: { version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH }, moderationSigner: addr(11) },
      publisherRevocations: [],
    };
    const profile = validateWeb2Profile({ schema: "pirate.web2-directory/3",
      chainId: 31337, directory: config.directory, communityKey: config.communityKey,
      communityId: config.communityId, installationId: config.installationId,
      directoryCodeHash: directoryV3Build.runtimeCodeHash,
      directoryAbiSha256: directoryV3Build.abiSha256, sourceCommit: "1".repeat(40),
      deploymentBlock: 1n });
    // Non-Directory bytecode is an explicitly scripted peer observation, not
    // a selected deployment. The reader still hashes every exact returned byte.
    const peerCode = "0x6000" as Hex, peerHash = keccak256(peerCode);
    const domain = { chainId: 31337n, communityId: config.communityId, verifier: addr(12) };
    const pin = { directory: config.directory, directoryRuntimeHash: profile.directoryCodeHash,
      consentRegistry: config.learningRecords, consentRegistryRuntimeHash: peerHash,
      posts: config.postsContract, postsRuntimeHash: peerHash,
      executionRule: keccak256(stringToHex("directory-current-publisher/1")),
      learnerConsentPolicyHash: hex(20), reviewerConsentPolicyHash: hex(21),
      publicityPolicyHash: hex(22), rulesSha256: hex(23), termsSha256: hex(24),
      rubricSha256: hex(25), mediaPolicySha256: hex(26), deploymentBlock: 1n,
      runtimeCodeHash: peerHash };
    const selected: DancePublicationSourceV2 = { version: 2, domain, pin,
      sourceHash: danceSourceHash(domain, pin), capturePolicy: addr(13),
      capturePolicyRuntimeHash: peerHash };
    const source: ConsentSourceV1 = { schema: "pirate.publication-source/1", resultsVersion: 5,
      chainId: 31337, communityId: config.communityId, installationId: config.installationId,
      directory: config.directory, directoryRuntimeHash: pin.directoryRuntimeHash,
      registry: config.learningRecords, registryRuntimeHash: peerHash, releaseSelectionSha256: hex(27) };
    const owner = { epoch: 7n, wallet: addr(8) };
    const reviewerWallet = options.ownerReviewer ? owner.wallet : addr(14);
    function binding(accountId: string, wallet: Address, purpose: GrantWireV1["purpose"], nonce: number, end: bigint) {
      const grant: GrantWireV1 = { learner: wallet, communityId: config.communityId,
        purpose, publicationTarget: domain.verifier, publicationTargetRuntimeHash: peerHash,
        permissionRevision: "1", policyHash: purpose === "dance-verdict" ? pin.learnerConsentPolicyHash : pin.reviewerConsentPolicyHash,
        withdrawalEpoch: "0", nonce: hex(nonce), issuedAt: String(base - 10n),
        validAfter: String(base - 10n), expiresAt: String(end), submitBefore: String(base + 1n) };
      const b: BoundPublicationGrantV1 = { schema: "pirate.bound-publication-grant/1",
        source: structuredClone(source), grantId: preparePublicationGrant(31337n, source.registry, grant, "0x").digest,
        grant, recordedAtS: String(base - 5n), boundAtS: String(startedAt), localFenceGeneration: "4" };
      return { accountId, binding: b };
    }
    const learner = binding("private-learner", addr(7), "dance-verdict", 30, expires("learner-grant"));
    const reviewer = binding("private-reviewer", reviewerWallet, "dance-review-attribution", 31, expires("reviewer-grant"));
    const capture: DanceCapture = { captureId: hex(32),
      accountCommitment: danceAccountCommitment(domain, learner.accountId, learner.binding.grant.learner),
      learner: learner.binding.grant.learner, identityEpoch: 1n, groupId: hex(33), groupEpoch: 1n,
      publicationGrantId: learner.binding.grantId, reservedAtMs: startedAt * 1000n,
      song: { chainId: domain.chainId, posts: pin.posts, communityId: domain.communityId,
        postId: hex(34), revision: 1n, manifestSha256: hex(35), audioSha256: hex(36) },
      rulesSha256: pin.rulesSha256, termsSha256: pin.termsSha256,
      rubricSha256: pin.rubricSha256, mediaPolicySha256: pin.mediaPolicySha256,
      referenceSelection: { present: false, id: zero, revision: 0n, epoch: 0n,
        segmentLayoutSha256: zero, segmentId: zero, startSample: 0n, durationSamples: 0n },
      offer: { present: false, offerIdCommitment: zero, inputHash: zero,
        sourceHash: zero, opensAtMs: 0n, cutoffAtMs: 0n } };
    const decision: DanceDecision = { submissionId: hex(37), verdict: 1,
      reviewerAccountCommitment: danceAccountCommitment(domain, reviewer.accountId, reviewerWallet),
      reviewerWallet, reviewerPublicationGrantId: reviewer.binding.grantId,
      reviewerIdentityEpoch: 1n, reviewerGroupId: hex(38), reviewerGroupEpoch: 1n,
      expectedOwnerEpoch: owner.epoch, expectedReviewerRoleEpoch: options.ownerReviewer ? owner.epoch : 9n,
      expectedMediaEpoch: 1n, intentAcceptedAtMs: startedAt * 1000n,
      expectedConfigurationRevision: 1n, expectedRulesEpoch: 1n, reviewerConsentHash: hex(39) };
    const captureHash = danceCaptureHash(domain, capture), subjects = [learner, reviewer];
    for (const item of subjects) {
      await db.prepare("INSERT INTO publication_test_bindings VALUES(?,?,?,?,?,?)")
        .bind(captureHash, item.accountId, item.binding.grant.purpose, canonical(item.binding), "1", "7").run();
      await db.prepare("INSERT INTO publication_test_permissions VALUES(?,?,?,0)")
        .bind(item.accountId, item.binding.grant.purpose, item.binding.localFenceGeneration).run();
    }
    const journal: DancePublicationJournal = { db,
      async acceptanceFences(input) {
        state.fenceReads++;
        return input.grants.map(item => ({
          sql: "EXISTS(SELECT 1 FROM publication_test_bindings b JOIN publication_test_permissions p ON p.account_id=b.account_id AND p.purpose=b.purpose WHERE b.capture_hash=? AND b.account_id=? AND b.purpose=? AND b.binding_json=? AND b.configuration_revision=? AND b.owner_epoch=? AND p.generation=? AND p.denied=0)",
          values: [input.captureHash, item.accountId, item.binding.grant.purpose,
            canonical(item.binding), input.configurationRevision, input.ownerEpoch, item.binding.localFenceGeneration],
        }));
      },
      async reconcileOriginal(command) {
        state.receiptReads++;
        const receipt = await db.prepare("SELECT receipt_json FROM publication_test_commands WHERE command_id=? AND command_json=?")
          .bind(command.commandId, canonical(command)).first<string>("receipt_json");
        assert.ok(receipt, "recover only the immutable original command row");
        return JSON.parse(receipt) as ConsentCommandReceiptV1;
      },
    };
    const anchor = { number: 50n, hash: hex(40), timestamp: base, transactions: [] };
    const context = [owner.epoch, 1n, config.controller, owner.wallet, base - 10n, expires("owner")] as const;
    const role = [9n, owner.epoch, expires("reviewer"), true] as const;
    const client = createPublicClient({ cacheTime: 0, transport: custom({
      async request({ method, params }) {
        const reached = async (key: string) => { state.reads.push(key); await state.hook?.(key); };
        if (method === "eth_chainId") { await reached("chain"); return "0x7a69"; }
        if (method === "eth_getBlockByNumber") {
          assert.ok(params?.[0] === "safe" || params?.[0] === "0x" + anchor.number.toString(16));
          await reached(params?.[0] === "safe" ? "block:safe" : "block:finish");
          return { number: "0x" + anchor.number.toString(16), hash: anchor.hash, parentHash: hex(41),
            timestamp: "0x" + anchor.timestamp.toString(16), transactions: [] };
        }
        if (method === "eth_getCode") {
          assert.deepEqual(params?.[1], { blockHash: anchor.hash, requireCanonical: true });
          await reached("code:" + String(params?.[0]));
          return params?.[0] === profile.directory ? directoryV3Runtime : peerCode;
        }
        assert.equal(method, "eth_call", "scripted transport refuses sends and every unplanned method");
        const tx = object(params?.[0]), data = tx.data as Hex;
        assert.deepEqual(params?.[1], { blockHash: anchor.hash, requireCanonical: true });
        if (tx.to === domain.verifier) {
          const c = decodeFunctionData({ abi: danceVerdictsAbi, data });
          await reached("call:" + c.functionName);
          switch (c.functionName) {
            case "VERSION": return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: 2 });
            case "sourceHash": return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: selected.sourceHash });
            case "communityId": return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: domain.communityId });
            case "capturePolicy": return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: selected.capturePolicy });
            case "capturePolicyRuntimeHash": return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: peerHash });
            case "ownerContext": return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: context });
            case "reviewerRoles":
              assert.deepEqual(c.args, [reviewerWallet]);
              return encodeFunctionResult({ abi: danceVerdictsAbi, functionName: c.functionName, result: role });
          }
        } else if (tx.to === profile.directory) {
          const c = decodeFunctionData({ abi: directoryV3Abi, data });
          assert.deepEqual(c.args, [domain.communityId]); await reached("call:" + c.functionName);
          switch (c.functionName) {
            case "getBinding": return encodeFunctionResult({ abi: directoryV3Abi, functionName: c.functionName, result: web2Binding(profile) });
            case "getOrigin": return encodeFunctionResult({ abi: directoryV3Abi, functionName: c.functionName,
              result: { sha256Digest: hashText(config.app.origin), revision: 1n, controllerRevision: 1n } });
            case "getCommunity": return encodeFunctionResult({ abi: directoryV3Abi, functionName: c.functionName, result: {
              registry: addr(15), tldHash: hex(42), configurationRevision: 1n,
              configuration: { controller: config.controller, publisher: config.publisher,
                operatorPayments: config.operatorPayments, learningRecords: config.learningRecords,
                sha256Digest: hashText(canonical(config)), uri: "ipfs://scripted-configuration" },
              verificationRevision: 0n, verification: { configurationRevision: 0n, hnsHeight: 0n,
                hnsBlockHash: zero, observedAt: 0n, validUntil: 0n, evidenceSha256: zero },
              listingRevision: 0n, listed: false } });
          }
        } else if (tx.to === source.registry) {
          assert.equal(state.registryReplaced, false, "original recovery must not query a replaced registry");
          const c = decodeFunctionData({ abi: learningResultsV5Abi, data });
          await reached("registry:" + c.functionName);
          switch (c.functionName) {
            case "VERSION": return encodeFunctionResult({ abi: learningResultsV5Abi, functionName: c.functionName, result: 5 });
            case "consentVersion": return encodeFunctionResult({ abi: learningResultsV5Abi, functionName: c.functionName, result: 1 });
            case "communityId": return encodeFunctionResult({ abi: learningResultsV5Abi, functionName: c.functionName, result: domain.communityId });
            case "directory": return encodeFunctionResult({ abi: learningResultsV5Abi, functionName: c.functionName, result: profile.directory });
            case "directoryRuntimeHash": return encodeFunctionResult({ abi: learningResultsV5Abi, functionName: c.functionName, result: pin.directoryRuntimeHash });
          }
          const p = decodeFunctionData({ abi: publicationConsentAbi, data });
          if (p.functionName === "checkGrant" || p.functionName === "grantOf" || p.functionName === "purpose") {
            const item = subjects.find(item => p.args[0] === (p.functionName === "purpose" ?
              keccak256(stringToHex(item.binding.grant.purpose)) : item.binding.grantId));
            assert.ok(item, "only the original learner/reviewer grant IDs and purposes may be queried");
            const b = item.binding, g = parsePublicationGrant(b.grant);
            await reached("grant:" + p.functionName + ":" + g.purpose);
            if (p.functionName === "checkGrant") {
              assert.deepEqual(p.args, [b.grantId, g.learner, keccak256(stringToHex(g.purpose)),
                domain.verifier, g.policyHash, startedAt]);
              // Explicit anchor-time RPC bytes, NOT a permission port or chain
              // execution claim. The regression makes this observation stale.
              return encodeFunctionResult({ abi: publicationConsentAbi, functionName: p.functionName,
                result: state.grantsDisabled ? [false, 1] : [true, 0] });
            }
            if (p.functionName === "grantOf") return encodeFunctionResult({ abi: publicationConsentAbi, functionName: p.functionName, result: [g, base - 5n] });
            return encodeFunctionResult({ abi: publicationConsentAbi, functionName: p.functionName, result: [1n, {
              target: domain.verifier, runtimeHash: peerHash, policyHash: g.policyHash,
              maxGrantDurationSeconds: 600n, maxSubmissionDelaySeconds: 60n, enabled: !state.grantsDisabled }] });
          }
        }
        assert.fail("unplanned scripted ABI call");
      },
    }, { retryCount: 0 }) });
    const fresh = { client, selected, profile, config, caller: config.publisher, owner,
      clock: { now: () => state.now, maxSafeBlockAgeSeconds: 600n }, db, journal,
      releaseSelectionSha256: source.releaseSelectionSha256,
      original: { kind: "review" as const, capture, decision, learner, reviewer },
    } satisfies Parameters<typeof readDancePublicationAdmission>[0];
    return { db, native, store, base, startedAt, expires, fresh, state, journal, capture, learner, reviewer,
      advanceSafe(time: bigint) {
        assert.ok(time >= anchor.timestamp);
        anchor.number += 1n; anchor.hash = hex(80 + Number(anchor.number));
        anchor.timestamp = time;
      },
      holdRead(key: string, occurrence = 1) {
        const entered = deferred(), gate = deferred(); let seen = 0;
        state.hook = async name => { if (name === key && ++seen === occurrence) {
          entered.resolve(); await gate.promise;
        } };
        return { entered: entered.promise, release: gate.resolve };
      },
      holdNextBatch() {
        assert.equal(heldBatch, undefined);
        heldBatch = deferred(); batchEntered = deferred();
        return { entered: batchEntered.promise, release: heldBatch.resolve };
      },
      async command(action: "grant" | "withdraw" = "grant"): Promise<PreparedConsentCommandV1> {
        const prepared = action === "grant" ?
          preparePublicationGrant(31337n, source.registry, learner.binding.grant, "0x") :
          preparePublicationWithdrawal(31337n, source.registry, { learner: capture.learner,
            communityId: domain.communityId, purpose: "dance-verdict", expectedEpoch: "0",
            nonce: hex(43), submitBefore: String(base + 1n) }, "0x");
        const context = { schema: "pirate.publication-command/1" as const, commandId: hex(action === "grant" ? 44 : 45),
          requestId: "original-" + action, accountId: learner.accountId, source: structuredClone(source),
          digest: prepared.digest, preparedAtMs: Number(base * 1000n), localFenceGeneration: "4" };
        return action === "grant" ? { ...context, action, message: learner.binding.grant } :
          { ...context, action, message: { learner: capture.learner, communityId: domain.communityId,
            purpose: "dance-verdict", expectedEpoch: "0", nonce: hex(43), submitBefore: String(base + 1n) } };
      },
      async retain(command: PreparedConsentCommandV1, receipt: ConsentCommandReceiptV1) {
        await db.prepare("INSERT INTO publication_test_commands VALUES(?,?,?) ON CONFLICT(command_id) DO UPDATE SET receipt_json=excluded.receipt_json WHERE command_json=excluded.command_json")
          .bind(command.commandId, canonical(command), canonical(receipt)).run();
      },
      async originals() { return (await db.prepare("SELECT * FROM publication_test_commands ORDER BY command_id").all()).results; },
      async accepted() { return (await db.prepare("SELECT id FROM publication_test_acceptance ORDER BY id").all()).results; },
      async guards() { return db.prepare("SELECT count(*) AS n FROM dance_transaction_guards").first<number>("n"); },
      close: () => mf.dispose(),
    };
  } catch (error) { await mf.dispose(); throw error; }
}
export async function waitForRealD1Expiry(db: D1Database, exclusiveEndMs: number) {
  const began = Date.now();
  for (;;) {
    const now = await db.prepare("SELECT " + DANCE_DB_NOW + " AS n").first<number>("n");
    assert.ok(typeof now === "number" && Number.isSafeInteger(now));
    if (now >= exclusiveEndMs) return now;
    assert.ok(Date.now() - began < 20000, "real D1 clock did not reach the expiry boundary");
    // Scheduling only; actual DB observation, never elapsed timer, releases admission.
    await pause(20);
  }
}
