import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { rewardChain } from "../packages/rewards/chain.ts";
import { rewardVeryProvider } from "../packages/rewards/very-provider.ts";
import { boundSubject, queryFor } from "../packages/rewards/very-proof.ts";
import { encrypt, decrypt } from "../packages/rewards/very-transport.ts";
import { proofFixture } from "./very-fixture.ts";
import {
  rewardHash,
  rewardTestProfile as profile,
} from "./manual-rewards-fixture.ts";

test("reward proof binds the program, fresh challenge and current credential expiry before hosted verification", async () => {
  const scope = "1000001",
    challenge = "17",
    expiresAt = 1794071100123;
  const proof = JSON.parse(proofFixture(scope, challenge));
  proof.publicSignals[5] = String(Math.ceil(expiresAt / 1000));
  assert.equal(
    queryFor(scope, challenge, expiresAt).options.expiredAtLowerBound,
    proof.publicSignals[5],
  );
  assert.equal(
    boundSubject(JSON.stringify(proof), scope, challenge, expiresAt),
    "12345",
  );
  for (const index of [2, 3, 4, 5]) {
    const changed = structuredClone(proof);
    changed.publicSignals[index] = "0";
    assert.throws(() =>
      boundSubject(JSON.stringify(changed), scope, challenge, expiresAt),
    );
  }
  const key = Buffer.alloc(32, 19);
  let verifies = 0,
    valid = false;
  const provider = rewardVeryProvider(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sessions")) {
      const launch = JSON.parse(decrypt(JSON.parse(String(init?.body)), key));
      assert.equal(JSON.parse(launch.idpQuery).options.pseudonym, challenge);
      return Response.json({ sessionId: "fixture_session" });
    }
    if (url.includes("/session/"))
      return Response.json({
        status: "completed",
        response: encrypt(JSON.stringify(proof), key),
      });
    assert.equal(url, "https://verify.very.org/api/v1/verify");
    verifies++;
    return Response.json({ status: valid ? "valid" : "invalid" });
  });
  const intent = await provider.open(
    "fixture",
    scope,
    challenge,
    key,
    expiresAt,
  );
  await assert.rejects(
    provider.subject(intent.id, key, scope, challenge, expiresAt),
    /verifier_rejected/,
  );
  valid = true;
  assert.equal(
    await provider.subject(intent.id, key, scope, challenge, expiresAt),
    "12345",
  );
  await assert.rejects(
    provider.subject(intent.id, key, scope, "18", expiresAt),
    /proof_binding_mismatch/,
  );
  assert.equal(verifies, 2);
});

test("RPC reconciliation uses the exact token event despite a relayer sender, and rejects ambiguity, failure and reorg", async () => {
  const original = globalThis.fetch,
    hash = rewardHash(800),
    blockHash = rewardHash(801),
    recipient = `0x${"55".repeat(20)}` as `0x${string}`;
  let duplicate = false,
    failed = false,
    reorg = false,
    safe = 102n;
  const event = {
    address: profile.token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: profile.payoutWallet as `0x${string}`, to: recipient },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [180000n]),
    blockHash,
    blockNumber: "0x65",
    transactionHash: hash,
    transactionIndex: "0x0",
    logIndex: "0x2",
    removed: false,
  };
  globalThis.fetch = async (_input, init) => {
    const rpc = JSON.parse(String(init?.body));
    let result: unknown;
    switch (rpc.method) {
      case "eth_chainId":
        result = "0x18c7";
        break;
      case "eth_call":
        result = encodeAbiParameters([{ type: "uint8" }], [6]);
        break;
      case "eth_getTransactionReceipt":
        result = {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockNumber: "0x65",
          blockHash,
          from: `0x${"99".repeat(20)}`,
          to: `0x${"aa".repeat(20)}`,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logs: duplicate ? [event, { ...event, logIndex: "0x3" }] : [event],
          logsBloom: `0x${"00".repeat(256)}`,
          status: failed ? "0x0" : "0x1",
          type: "0x2",
        };
        break;
      case "eth_getBlockByNumber": {
        const n = rpc.params[0] === "safe" ? safe : BigInt(rpc.params[0]);
        result = {
          number: `0x${n.toString(16)}`,
          hash: reorg ? rewardHash(802) : blockHash,
          timestamp: "0x1",
          transactions: [],
          gasLimit: "0x1",
          gasUsed: "0x1",
          size: "0x1",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          baseFeePerGas: "0x1",
        };
        break;
      }
      default:
        throw Error(`unexpected RPC ${rpc.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  };
  try {
    const chain = rewardChain(),
      expected = {
        sender: profile.payoutWallet,
        recipient,
        amountAtomic: "180000",
      };
    const transfer = await chain.transfer(profile, hash, expected);
    assert.equal(transfer?.sender, profile.payoutWallet);
    assert.equal(transfer?.logIndex, 2);
    await assert.rejects(
      chain.transfer(profile, hash, { ...expected, amountAtomic: "180001" }),
      /reward_payment_transfer_not_unique/,
    );
    duplicate = true;
    await assert.rejects(
      chain.transfer(profile, hash, expected),
      /reward_payment_transfer_not_unique/,
    );
    duplicate = false;
    safe = 100n;
    assert.equal(await chain.transfer(profile, hash, expected), null);
    safe = 102n;
    failed = true;
    await assert.rejects(
      chain.transfer(profile, hash, expected),
      /reward_transaction_failed_or_changed/,
    );
    failed = false;
    reorg = true;
    await assert.rejects(
      chain.transfer(profile, hash, expected),
      /reward_transaction_reorged/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
