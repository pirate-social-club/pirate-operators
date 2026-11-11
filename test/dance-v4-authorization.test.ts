import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { ensureCommunityIdentity } from "../packages/community/accounts.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceSourceHash } from "../packages/dance-chain/wire.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { capturedDanceAuthorization } from "../services/dance-v4-authorization.ts";
import { communityRuntime } from "./community-runtime.ts";

const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;

test("Dance keeps the exact captured V4 sign-in and fences local withdrawal during and after chain reads", async () => {
  const f = await communityRuntime({ v4: true });
  try {
    const communityId = word(1),
      accountId = "learner_fixture",
      wallet = addr(5);
    const now = 1_800_000_000,
      authorizationId = word(7);
    await ensureCommunityIdentity(f.db, {
      communityId,
      origin: "https://community.example",
    });
    await f.db.batch([
      f.db
        .prepare(
          "INSERT INTO community_accounts(account_id,author_id,created_at) VALUES(?,?,0)",
        )
        .bind(accountId, word(8)),
      f.db
        .prepare(
          "INSERT INTO credential_bindings(binding_id,account_id,namespace,network,subject,created_at) VALUES(?,?,'moss',6343,?,0)",
        )
        .bind("fixture_binding", accountId, wallet),
      ...[authorizationId, word(9)].map((id, i) =>
        f.db
          .prepare(
            `INSERT INTO learning_authorizations
          (authorization_id,account_id,subject,sign_in_json,message,signature,policy_hash,policy_version,issued_at,state,created_at,updated_at)
          VALUES(?,?,?,'{}','fixture','fixture',?,1,?,'recorded',0,0)`,
          )
          .bind(id, accountId, wallet, word(10), now - 10 + i),
      ),
      f.db.prepare(
        "CREATE TABLE dance_transaction_guards (guard_id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1))",
      ),
    ]);
    const code = "0x60006000f3",
      runtime = keccak256(code);
    const domain = { chainId: 6343n, verifier: addr(12), communityId };
    const pin = {
      directory: addr(13),
      directoryRuntimeHash: runtime,
      v4: addr(14),
      v4RuntimeHash: runtime,
      posts: addr(15),
      postsRuntimeHash: runtime,
      fixedPublisher: addr(16),
      publicityPolicyHash: word(17),
      rulesSha256: word(18),
      termsSha256: word(19),
      rubricSha256: word(20),
      mediaPolicySha256: word(21),
      deploymentBlock: 10n,
      runtimeCodeHash: runtime,
    };
    const source: DanceCanonicalSource = {
      schema: "pirate.dance-verdict/1",
      domain,
      pin,
      sourceHash: danceSourceHash(domain, pin),
      capturePolicy: addr(22),
      capturePolicyRuntimeHash: runtime,
    };
    const queried: string[] = [];
    let revokeDuring = false,
      anchorChanged = false,
      onchainRevoked = 0n;
    const withdraw = () =>
      f.db
        .prepare(
          `INSERT INTO learning_settings(account_id,public_results_withdrawn_at,last_withdrawn_at)
       VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET public_results_withdrawn_at=excluded.public_results_withdrawn_at,last_withdrawn_at=excluded.last_withdrawn_at`,
        )
        .bind(accountId, now * 1000, now * 1000)
        .run();
    const clear = () =>
      f.db
        .prepare("DELETE FROM learning_settings WHERE account_id=?")
        .bind(accountId)
        .run();
    const client = {
      getChainId: async () => 6343,
      getCode: async () => code,
      getBlock: async ({ blockTag }: { blockTag?: string }) => ({
        number: 100n,
        hash: !blockTag && anchorChanged ? word(901) : word(900),
        timestamp: BigInt(now),
        transactions: [],
      }),
      async readContract(input: {
        functionName: string;
        address: string;
        blockNumber: bigint;
        args?: string[];
      }) {
        const { functionName, address, blockNumber, args } = input;
        assert.equal(blockNumber, 100n);
        switch (functionName) {
          case "sourceHash":
            return source.sourceHash;
          case "communityId":
            return communityId;
          case "VERSION":
            return 1;
          case "capturePolicy":
            return source.capturePolicy;
          case "capturePolicyRuntimeHash":
            return source.capturePolicyRuntimeHash;
          case "authorizationLearner":
            assert.equal(address, pin.v4);
            queried.push(args![0]);
            return wallet;
          case "authorizationIssuedAt":
            assert.equal(args![0], authorizationId);
            if (revokeDuring) await withdraw();
            return BigInt(now - 10);
          case "authorizedSince":
            return BigInt(now - 20);
          case "revokedAt":
            return onchainRevoked;
        }
        throw Error("unexpected_fixture_call");
      },
    } as unknown as PublicClient;
    const authorize = capturedDanceAuthorization({ db: f.db, source, client });
    const fact = { accountId, wallet, authorizationId, atMs: now * 1000 };
    const fence = await authorize(fact);
    assert.deepEqual(queried, [authorizationId]);
    const store = new DanceStore(f.db);
    await store.assert([fence]);
    await withdraw();
    await assert.rejects(store.assert([fence]), /dance_fence_changed/);
    const alreadyRead = queried.length;
    await assert.rejects(
      authorize(fact),
      /dance_capture_authorization_changed/,
    );
    assert.equal(queried.length, alreadyRead);

    await clear();
    revokeDuring = true;
    await assert.rejects(
      authorize(fact),
      /dance_capture_authorization_changed/,
    );
    revokeDuring = false;
    await clear();
    onchainRevoked = BigInt(now - 10);
    await assert.rejects(
      authorize(fact),
      /dance_capture_authorization_changed/,
    );
    onchainRevoked = 0n;
    anchorChanged = true;
    await assert.rejects(authorize(fact), /dance_authorization_anchor_changed/);
  } finally {
    await f.dispose();
  }
});
