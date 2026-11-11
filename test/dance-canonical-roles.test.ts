import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import {
  danceAccountCommitment,
  danceSingletonId,
  danceSourceHash,
} from "../packages/dance-chain/wire.ts";
import { observeCanonicalDanceRole } from "../services/dance-canonical-roles.ts";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;

function fixture() {
  const code = "0x6000" as Hex,
    codeHash = keccak256(code);
  const actor = { accountId: "fixture_reviewer", wallet: address(20) };
  const learner = { accountId: "fixture_learner", wallet: address(21) };
  const domain = {
    chainId: 6343n,
    verifier: address(1),
    communityId: word(50),
  };
  const pin = {
    directory: address(2),
    directoryRuntimeHash: codeHash,
    v4: address(3),
    v4RuntimeHash: codeHash,
    posts: address(4),
    postsRuntimeHash: codeHash,
    fixedPublisher: address(5),
    publicityPolicyHash: word(51),
    rulesSha256: word(52),
    termsSha256: word(53),
    rubricSha256: word(54),
    mediaPolicySha256: word(55),
    runtimeCodeHash: codeHash,
    deploymentBlock: 3n,
  };
  const source: DanceCanonicalSource = {
    schema: "pirate.dance-verdict/1",
    domain,
    pin,
    sourceHash: danceSourceHash(domain, pin),
    capturePolicy: address(6),
    capturePolicyRuntimeHash: codeHash,
  };
  const safe = {
    number: 40n,
    hash: word(60),
    timestamp: 1100n,
    transactions: [],
  };
  const config: CommunityConfig = {
    schema: "pirate.community-config/1",
    chainId: 6343,
    directory: pin.directory,
    communityId: domain.communityId,
    registry: address(7),
    tld: "fixture",
    configurationRevision: 2,
    postsContract: pin.posts,
    controller: address(8),
    publisher: pin.fixedPublisher,
    operatorPayments: address(9),
    learningRecords: pin.v4,
    app: {
      label: "fixture",
      tokenGeneration: "0",
      origin: "https://fixture.example",
      httpsAlias: null,
      hnsIngress: "none",
    },
    feed: { endpoint: "https://fixture.example/feed", signingKeyId: "fixture" },
    policies: {
      admission: { version: "fixture", sha256: word(58) },
      moderationSigner: address(10),
    },
    publisherRevocations: [],
  };
  const identities = [actor, learner].map((s) => {
    const account = danceAccountCommitment(domain, s.accountId, s.wallet);
    return { ...s, account, group: danceSingletonId(domain, account) };
  });
  const fault = {
    chainId: 6343,
    anchorChanged: false,
    missingCanonicalRead: false,
    codeChanged: false,
    revision: 2n,
    rules: 0n,
    groupEpoch: 2n,
    delegateExpiry: 1300n,
  };
  const stateReads: string[] = [];
  const requireAnchor = (kind: string, input: Record<string, unknown>) => {
    assert.equal(input.blockHash, safe.hash);
    assert.equal(input.requireCanonical, true);
    assert.equal(input.blockNumber, undefined);
    stateReads.push(kind);
    if (fault.missingCanonicalRead)
      throw Error("fixture_hash_block_unsupported");
  };
  const client = {
    getChainId: async () => fault.chainId,
    async getBlock(input: Record<string, unknown>) {
      if (input.blockTag === "safe") return safe;
      assert.equal(input.blockNumber, safe.number);
      return fault.anchorChanged ? { ...safe, hash: word(61) } : safe;
    },
    async getCode(input: Record<string, unknown>) {
      requireAnchor("code", input);
      return fault.codeChanged ? "0x6001" : code;
    },
    async readContract(input: {
      functionName: string;
      address: Address;
      args?: readonly unknown[];
    }) {
      requireAnchor(input.functionName, input);
      switch (input.functionName) {
        case "sourceHash":
          return source.sourceHash;
        case "communityId":
          return domain.communityId;
        case "VERSION":
          return 1;
        case "capturePolicy":
          return source.capturePolicy;
        case "capturePolicyRuntimeHash":
          return source.capturePolicyRuntimeHash;
        case "getCommunity":
          assert.equal(input.address, pin.directory);
          assert.deepEqual(input.args, [domain.communityId]);
          return {
            registry: config.registry,
            configurationRevision: fault.revision,
            configuration: {
              controller: config.controller,
              publisher: config.publisher,
              learningRecords: config.learningRecords,
              operatorPayments: config.operatorPayments,
            },
          };
        case "ownerContext":
          return [5n, 2n, config.controller, address(22), 1000n, 1400n];
        case "rulesEpoch":
          return fault.rules;
        case "reviewerRoles":
          assert.deepEqual(input.args, [actor.wallet]);
          return [7n, 5n, fault.delegateExpiry, true];
        case "identities": {
          const s = identities.find((s) => s.account === input.args?.[0])!;
          assert.ok(s);
          return [s.wallet, 3n, s.group, 2n, true];
        }
        case "groups":
          assert.ok(identities.some((s) => s.group === input.args?.[0]));
          return [fault.groupEpoch, 1n, 0n, word(0), true];
        default:
          throw Error("fixture_unexpected_call");
      }
    },
  } as unknown as PublicClient;
  return {
    fault,
    stateReads,
    safe,
    observe: () =>
      observeCanonicalDanceRole({ client, source, config, actor, learner }),
  };
}

test("Dance role and identity observations address every state read by one canonical block hash", async () => {
  const f = fixture(),
    result = await f.observe();
  assert.deepEqual(result.anchor, { number: f.safe.number, hash: f.safe.hash });
  assert.equal(result.owner.epoch, 5);
  assert.equal(result.actor.identityEpoch, 3);
  assert.equal(result.learner.groupEpoch, 2);
  assert.deepEqual(result.reviewer, {
    roleEpoch: 7,
    ownerEpoch: 5,
    expiresAtMs: 1300000,
  });
  assert.equal(f.stateReads.filter((kind) => kind === "code").length, 5);
  assert.equal(f.stateReads.filter((kind) => kind === "identities").length, 2);
  assert.equal(f.stateReads.filter((kind) => kind === "groups").length, 2);
  f.fault.delegateExpiry = f.safe.timestamp;
  assert.equal((await f.observe()).reviewer, null);
});

test("Dance role read refuses unsupported hash reads, reorgs, stale directory, and stale group state", async () => {
  for (const [overrides, reason] of [
    [{ missingCanonicalRead: true }, /fixture_hash_block_unsupported/],
    [{ anchorChanged: true }, /dance_authority_anchor_changed/],
    [{ codeChanged: true }, /dance_historical_runtime_changed/],
    [{ revision: 3n }, /dance_canonical_authority_changed/],
    [{ rules: 1n }, /dance_canonical_authority_changed/],
    [{ groupEpoch: 3n }, /dance_canonical_group_changed/],
    [{ chainId: 1 }, /dance_canonical_source_changed/],
  ] as const) {
    const f = fixture();
    Object.assign(f.fault, overrides);
    await assert.rejects(f.observe(), reason);
    if ("missingCanonicalRead" in overrides) assert.ok(f.stateReads.length > 0);
  }
});
