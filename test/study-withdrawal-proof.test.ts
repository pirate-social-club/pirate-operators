/** Actual viem cryptography and serialization, simulated read-only chain data.
 * No provider, actual deployment or public transaction is used. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV4Abi,
  resultsV4Domain,
} from "../packages/protocol/learning-results-v4.ts";
import { revocationTypes } from "../packages/protocol/learning-results.ts";
import {
  observeStudyWithdrawal,
  type OriginalStudyWithdrawal,
  type StudyWithdrawalSource,
} from "../services/study-withdrawal-proof.ts";
const h = (n: string) => digest(n) as Hex;
async function fixture() {
  const learner = accounts[5].address.toLowerCase() as Address;
  const sender = accounts[2].address.toLowerCase() as Address;
  const contract = `0x${"44".repeat(20)}` as Address;
  const code = "0x6001600055" as Hex;
  const source: StudyWithdrawalSource = {
    target: { version: 4, chainId: 6343, contract },
    communityId: h("fixture-community"),
    runtimeCodeHash: keccak256(code),
  };
  const signature = await accounts[5].signTypedData({
    domain: resultsV4Domain(6343, contract),
    types: revocationTypes,
    primaryType: "Revocation",
    message: { learner, nonce: 3n },
  });
  const data = encodeFunctionData({
    abi: resultsV4Abi,
    functionName: "revoke",
    args: [learner, 3n, signature],
  });
  const raw = await accounts[2].signTransaction({
    type: "legacy",
    chainId: 6343,
    nonce: 7,
    to: contract,
    gas: 100000n,
    gasPrice: 1n,
    value: 0n,
    data,
  });
  const hash = keccak256(raw);
  const original: OriginalStudyWithdrawal = {
    nonce: "3",
    data,
    transaction: { raw, hash, nonce: 7, sender },
  };
  const anchor = {
    number: 100n,
    hash: h("safe"),
    timestamp: 1000n,
    transactions: [] as Hex[],
  };
  const block = {
    number: 90n,
    hash: h("receipt"),
    timestamp: 900n,
    transactions: [hash],
  };
  const receipt = {
    status: "success",
    transactionHash: hash,
    blockNumber: 90n,
    blockHash: block.hash,
    transactionIndex: 0,
    logs: [
      {
        address: contract,
        blockNumber: 90n,
        blockHash: block.hash,
        transactionHash: hash,
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
        topics: encodeEventTopics({
          abi: resultsV4Abi,
          eventName: "Revoked",
          args: { learner },
        }),
        data: encodeAbiParameters(
          parseAbiParameters("uint64 nonce,uint64 revokedAt"),
          [3n, 900n],
        ),
      },
    ],
  };
  let missing = false,
    chainId = 6343,
    revokedAt = 900n,
    nextNonce = 4n;
  const reads: Record<string, unknown>[] = [];
  const canonical = (a: Record<string, unknown>) => {
    reads.push(a);
    assert.equal(a.blockHash, anchor.hash);
    assert.equal(a.requireCanonical, true);
    assert.equal("blockNumber" in a, false);
  };
  const methods = {
    async getChainId() {
      return chainId;
    },
    async getBlock(a: { blockTag?: string; blockNumber?: bigint }) {
      return a.blockTag === "safe" || a.blockNumber === 100n
        ? structuredClone(anchor)
        : structuredClone(block);
    },
    async getCode(a: Record<string, unknown>) {
      canonical(a);
      return code;
    },
    async readContract(a: Record<string, unknown>) {
      canonical(a);
      switch (a.functionName) {
        case "VERSION":
          return 4;
        case "communityId":
          return source.communityId;
        case "revokedAt":
          return revokedAt;
        case "nextNonce":
          return nextNonce;
        default:
          throw Error("unexpected contract read");
      }
    },
    async getTransactionReceipt() {
      if (missing)
        throw Object.assign(Error("not found"), {
          name: "TransactionReceiptNotFoundError",
        });
      return structuredClone(receipt);
    },
    async getTransaction() {
      return {
        hash,
        to: contract,
        from: sender,
        input: data,
        nonce: 7,
        chainId: 6343,
        blockNumber: 90n,
        blockHash: block.hash,
        transactionIndex: 0,
      };
    },
  };
  const proof = () =>
    observeStudyWithdrawal({
      client: methods as unknown as PublicClient,
      source,
      learner,
      original,
    });
  return {
    source,
    original,
    learner,
    methods,
    proof,
    receipt,
    anchor,
    block,
    reads,
    code,
    state: (r: bigint, n: bigint) => {
      revokedAt = r;
      nextNonce = n;
    },
    missing: () => {
      missing = true;
    },
    wrongChain: () => {
      chainId = 1;
    },
  };
}

test("a retained signed revoke requires its canonical owned event and hash-pinned safe state", async () => {
  const f = await fixture();
  const proof = await f.proof();
  assert.ok(proof);
  assert.equal(proof.kind, "success");
  assert.equal(proof.revokedAtS, 900);
  assert.equal(proof.issuanceFloorS, 900);
  assert.equal(proof.original?.receipt?.status, "success");
  assert.equal(proof.original?.transactionHash, f.original.transaction.hash);
  assert.equal(f.reads.length, 5);
  const { proofHash, ...body } = proof;
  assert.equal(proofHash, digest(body));
});

test("canonical revert records a separate prospective floor while preserving the exact reverted outcome", async () => {
  const f = await fixture();
  f.receipt.status = "reverted";
  f.receipt.logs = [];
  f.state(0n, 0n);
  const proof = await f.proof();
  assert.ok(proof);
  assert.equal(proof.kind, "reverted");
  assert.equal(proof.revokedAtS, 0);
  assert.equal(proof.issuanceFloorS, 900);
  assert.equal(proof.original?.receipt?.status, "reverted");
  assert.equal(proof.nextNonce, "0");
});

test("safe nonce coverage resolves authority without inventing an original receipt or success", async () => {
  const f = await fixture();
  f.missing();
  const proof = await f.proof();
  assert.ok(proof);
  assert.equal(proof.kind, "authority_covered");
  assert.equal(proof.original?.receipt, undefined);
  assert.equal(proof.original?.transactionHash, f.original.transaction.hash);
  f.state(0n, 0n);
  assert.equal(await f.proof(), null);
});

for (const fault of [
  "chain",
  "runtime",
  "raw",
  "receipt_hash",
  "unsafe",
  "event_bytes",
  "event_topic",
  "event_position",
  "foreign_extra_log",
  "malformed_extra_log",
  "revert_log",
  "anchor",
  "nonce_range",
] as const) {
  test(`withdrawal proof remains pending for ${fault} without accepting replacement facts`, async () => {
    const f = await fixture();
    if (fault === "chain") f.wrongChain();
    if (fault === "nonce_range") f.state(900n, 1n << 64n);
    if (fault === "runtime") f.source.runtimeCodeHash = h("wrong-runtime");
    if (fault === "raw")
      f.original.transaction.raw = (f.original.transaction.raw + "00") as Hex;
    if (fault === "receipt_hash")
      f.receipt.transactionHash = h("wrong-receipt");
    if (fault === "unsafe") f.receipt.blockNumber = 101n;
    if (fault === "event_bytes")
      f.receipt.logs[0].data = (f.receipt.logs[0].data + "00") as Hex;
    if (fault === "event_topic")
      f.receipt.logs[0].topics.push(h("extra-topic"));
    if (fault === "event_position") f.receipt.logs[0].logIndex = 2;
    if (fault === "foreign_extra_log" || fault === "malformed_extra_log")
      f.receipt.logs.push({
        ...f.receipt.logs[0],
        address: accounts[0].address,
        topics: f.receipt.logs[0].topics,
        logIndex: fault === "malformed_extra_log" ? -1 : 1,
      });
    if (fault === "revert_log") f.receipt.status = "reverted";
    if (fault === "anchor") {
      const get = f.methods.getBlock;
      let calls = 0;
      f.methods.getBlock = async (a) => {
        const x = await get(a);
        return a.blockNumber === 100n && ++calls > 0
          ? { ...x, hash: h("changed-anchor") }
          : x;
      };
    }
    assert.equal(await f.proof(), null);
  });
}

test("actual viem transport serializes canonical hash reads with no numeric fallback", async () => {
  const f = await fixture(),
    reads: { method: string; params: unknown[] }[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        const a = (params ?? []) as unknown[];
        if (method === "eth_chainId") return "0x18c7";
        if (method === "eth_getBlockByNumber")
          return {
            number: "0x64",
            hash: f.anchor.hash,
            timestamp: "0x3e8",
            transactions: [],
          };
        if (method === "eth_getCode") {
          reads.push({ method, params: a });
          return f.code;
        }
        if (method === "eth_call") {
          reads.push({ method, params: a });
          const call = a[0] as { data: Hex };
          const decoded = decodeFunctionData({
            abi: resultsV4Abi,
            data: call.data,
          });
          switch (decoded.functionName) {
            case "VERSION":
              return encodeFunctionResult({
                abi: resultsV4Abi,
                functionName: "VERSION",
                result: 4,
              });
            case "communityId":
              return encodeFunctionResult({
                abi: resultsV4Abi,
                functionName: "communityId",
                result: f.source.communityId,
              });
            case "revokedAt":
              return encodeFunctionResult({
                abi: resultsV4Abi,
                functionName: "revokedAt",
                result: 900n,
              });
            case "nextNonce":
              return encodeFunctionResult({
                abi: resultsV4Abi,
                functionName: "nextNonce",
                result: 4n,
              });
          }
        }
        throw Error("unexpected fixture RPC method " + method);
      },
    }),
  });
  const proof = await observeStudyWithdrawal({
    client,
    source: f.source,
    learner: f.learner,
  });
  assert.ok(proof);
  assert.equal(proof.kind, "observed");
  assert.equal(reads.length, 5);
  for (const read of reads)
    assert.deepEqual(read.params[1], {
      blockHash: f.anchor.hash,
      requireCanonical: true,
    });
});
