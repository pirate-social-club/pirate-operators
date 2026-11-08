import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
} from "viem";
import { readPaymentGuard } from "../packages/rewards/guard-chain.ts";
import {
  mossGuardAbi,
  paymentGuardNonce,
  MOSS_GUARD_IMPLEMENTATION,
  MOSS_GUARD_PROXY,
  MOSS_GUARD_ORCHESTRATOR,
} from "../packages/rewards/moss-guard.ts";
import {
  rewardTestProfile as p,
  rewardHash,
} from "./manual-rewards-fixture.ts";

// Real viem RPC decoding with captured runtime pins; nonce state/history is explicitly simulated.
test("lost hashes recover through bounded historical nonce reads and one exact guard event; missing history, changed accounts and reorgs fail closed", async () => {
  const code = JSON.parse(
    await readFile(
      new URL("./fixtures/moss-6343-guard/runtime.json", import.meta.url),
      "utf8",
    ),
  );
  const raw = paymentGuardNonce(p.programId, p.payoutWallet, "payment_001"),
    nonce = BigInt(raw),
    hash = rewardHash(811);
  let consumed = true,
    changedAccount = false,
    changedImplementation = false,
    doubled = false,
    logsMissing = false,
    reorg = false,
    unavailable = false,
    unexpected = false;
  let wrongReceipt = false;
  let nonceReads = 0,
    blockReads = 0,
    logReads = 0;
  const blockHash = rewardHash(135);
  const event = {
    address: p.payoutWallet,
    topics: encodeEventTopics({
      abi: mossGuardAbi,
      eventName: "NonceInvalidated",
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [nonce]),
    blockNumber: "0x87",
    blockHash,
    transactionHash: hash,
    transactionIndex: "0x0",
    logIndex: "0x1",
    removed: false,
  };
  const client = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          const args = params as unknown[];
          switch (method) {
            case "eth_getBlockByNumber": {
              const n = args[0] === "safe" ? 200n : BigInt(args[0] as string);
              if (n === 135n) blockReads++;
              return {
                number: `0x${n.toString(16)}`,
                hash:
                  reorg && blockReads > 1
                    ? rewardHash(999)
                    : rewardHash(Number(n)),
                timestamp: "0x1",
                transactions: [],
                gasLimit: "0x1",
                gasUsed: "0x0",
                difficulty: "0x0",
                size: "0x1",
              };
            }
            case "eth_getCode": {
              const address = String(args[0]).toLowerCase();
              if (address === p.payoutWallet)
                return changedAccount
                  ? "0x"
                  : `0xef0100${MOSS_GUARD_PROXY.slice(2)}`;
              if (address === MOSS_GUARD_PROXY) return code.proxyCode;
              if (address === MOSS_GUARD_IMPLEMENTATION)
                return changedImplementation ? "0x00" : code.implementationCode;
              throw Error("unexpected code address");
            }
            case "eth_call": {
              const call = args[0] as { to: string; data: string };
              if (call.to.toLowerCase() === MOSS_GUARD_ORCHESTRATOR)
                return encodeAbiParameters(
                  [{ type: "address" }],
                  [MOSS_GUARD_IMPLEMENTATION],
                );
              assert.equal(call.to.toLowerCase(), p.payoutWallet);
              nonceReads++;
              const n = BigInt(args[1] as string);
              if (unavailable && n < 200n)
                throw Error("historical state unavailable");
              const seq = consumed && n >= 135n ? (unexpected ? 2n : 1n) : 0n;
              return encodeAbiParameters([{ type: "uint256" }], [nonce + seq]);
            }
            case "eth_getTransactionReceipt":
              return {
                transactionHash: hash,
                blockHash,
                blockNumber: "0x87",
                transactionIndex: "0x0",
                status: "0x1",
                logs: wrongReceipt ? [] : [event],
              };
            case "eth_getLogs": {
              const filter = args[0] as { fromBlock: string; toBlock: string };
              assert.equal(filter.fromBlock, "0x87");
              assert.equal(filter.toBlock, "0x87");
              logReads++;
              return logsMissing
                ? []
                : doubled
                  ? [event, { ...event, logIndex: "0x2" }]
                  : [event];
            }
            default:
              throw Error(`unexpected RPC ${method}`);
          }
        },
      },
      { retryCount: 0 },
    ),
  });
  const lookup = () => readPaymentGuard(client, p, raw, "101", async () => []);
  const proof = await lookup();
  assert.equal(proof?.transactionHash, hash);
  assert.equal(proof?.blockNumber, "135");
  assert.equal(proof?.logIndex, 1);
  assert.ok(nonceReads < 15, "binary search bounds history work");
  assert.equal(logReads, 1);
  consumed = false;
  assert.equal(await lookup(), null);
  assert.equal(logReads, 1);
  consumed = true;
  changedAccount = true;
  await assert.rejects(lookup(), /changed_or_uninitialized/);
  changedAccount = false;
  changedImplementation = true;
  await assert.rejects(lookup(), /implementation_changed/);
  changedImplementation = false;
  unexpected = true;
  await assert.rejects(lookup(), /unexpected_sequence/);
  unexpected = false;
  await assert.rejects(
    readPaymentGuard(client, p, raw, "136", async () => []),
    /predates_payment/,
  );
  unavailable = true;
  await assert.rejects(lookup(), /historical state unavailable/);
  unavailable = false;
  doubled = true;
  await assert.rejects(lookup(), /event_not_unique/);
  doubled = false;
  logsMissing = true;
  await assert.rejects(lookup(), /event_not_unique/);
  logsMissing = false;
  wrongReceipt = true;
  await assert.rejects(lookup(), /receipt_changed/);
  wrongReceipt = false;
  blockReads = 0;
  reorg = true;
  await assert.rejects(lookup(), /reorged/);
});
