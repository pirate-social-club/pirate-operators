import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, type PublicClient, type Hex } from "viem";
import {
  observeRootRegistration,
  rootRegistrationAbi,
  rootRegistrationData,
  storyTestnet,
} from "../packages/community/registration-chain.ts";
import { registrationLogs } from "./fixtures/registration-receipt.ts";

const hash = `0x${"1".repeat(64)}` as Hex,
  blockHash = `0x${"2".repeat(64)}` as Hex,
  otherHash = `0x${"4".repeat(64)}` as Hex,
  signer = "0x1111111111111111111111111111111111111111",
  recipient = "0x2222222222222222222222222222222222222222",
  uri = "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy",
  input = {
    recipient,
    contentSha256: hash,
    metadata: { uri, sha256: hash },
    nftMetadata: { uri, sha256: hash },
  } as const;
function fixture() {
  const receipt = {
    status: "success",
    transactionHash: hash,
    blockNumber: 100n,
    blockHash,
    logs: registrationLogs(hash, blockHash, recipient, uri),
  };
  let calls = 0;
  const client = {
    getChainId: async () => 1315,
    getBlockNumber: async () => 101n,
    getTransactionReceipt: async () => {
      calls++;
      return receipt;
    },
    getTransaction: async () => ({
      hash,
      chainId: 1315,
      from: signer,
      to: storyTestnet.workflow,
      value: 0n,
      input: rootRegistrationData(input),
      blockNumber: 100n,
      blockHash,
    }),
    getBlock: async () => ({ hash: blockHash }),
    readContract: async () => {
      throw Error("historical state is unavailable");
    },
  };
  return { receipt, client, calls: () => calls };
}
const observe = (client: ReturnType<typeof fixture>["client"]) =>
  observeRootRegistration(
    client as unknown as PublicClient,
    hash,
    signer,
    input,
  );

test("canonical receipt proves initial delivery and metadata after archival state is pruned", async () => {
  const f = fixture();
  const result = await observe(f.client);
  assert.equal(result?.recipient, recipient);
  assert.equal(result?.tokenId, "1");
  assert.equal(result?.metadataUri, uri);
  assert.equal(f.calls(), 2, "re-read canonical receipt before accepting");
});

for (const [name, mutate] of Object.entries({
  missing_delivery: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs.pop();
  },
  missing_mint: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs.shift();
  },
  extra_transfer: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs.push({ ...r.logs[2]!, logIndex: 3 });
  },
  ambiguous_registration: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs.push({ ...r.logs[1]!, logIndex: 3 });
  },
  wrong_uri: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[1] = registrationLogs(
      hash,
      blockHash,
      recipient,
      uri + "changed",
    )[1]!;
  },
  removed: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.removed = true;
  },
  foreign_transaction: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.transactionHash = otherHash;
  },
  foreign_block: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[1]!.blockHash = otherHash;
  },
  foreign_height: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[0]!.blockNumber = 99n;
  },
  reversed_delivery: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.logIndex = 0;
  },
  duplicate_index: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[1]!.logIndex = 0;
  },
  malformed_transfer: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.topics = [r.logs[2]!.topics[0]!];
  },
  wrong_nft: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.address = recipient;
  },
  wrong_token: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.topics = encodeEventTopics({
      abi: rootRegistrationAbi,
      eventName: "Transfer",
      args: { from: storyTestnet.workflow, to: recipient, tokenId: 2n },
    });
  },
  wrong_recipient: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[2]!.topics = encodeEventTopics({
      abi: rootRegistrationAbi,
      eventName: "Transfer",
      args: { from: storyTestnet.workflow, to: signer, tokenId: 1n },
    });
  },
  wrong_intermediate: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[0]!.topics = encodeEventTopics({
      abi: rootRegistrationAbi,
      eventName: "Transfer",
      args: {
        from: "0x0000000000000000000000000000000000000000",
        to: signer,
        tokenId: 1n,
      },
    });
  },
  missing_zero_origin: (r: ReturnType<typeof fixture>["receipt"]) => {
    r.logs[0]!.topics = encodeEventTopics({
      abi: rootRegistrationAbi,
      eventName: "Transfer",
      args: { from: signer, to: storyTestnet.workflow, tokenId: 1n },
    });
  },
}))
  test(`receipt recovery rejects ${name}`, async () => {
    const f = fixture();
    mutate(f.receipt);
    await assert.rejects(observe(f.client));
  });

test("canonical block and a second receipt must still agree after confirmation", async () => {
  const f = fixture();
  f.client.getBlock = async () => ({ hash: otherHash });
  await assert.rejects(
    observe(f.client),
    /registration_receipt_binding_mismatch/,
  );
  const g = fixture();
  let n = 0;
  g.client.getTransactionReceipt = async () => ({
    ...g.receipt,
    blockHash: ++n === 1 ? blockHash : otherHash,
  });
  await assert.rejects(
    observe(g.client),
    /registration_receipt_binding_mismatch/,
  );
  const h = fixture();
  let m = 0;
  h.client.getTransactionReceipt = async () => ({
    ...h.receipt,
    logs:
      ++m === 1
        ? h.receipt.logs
        : registrationLogs(hash, blockHash, signer, uri),
  });
  await assert.rejects(
    observe(h.client),
    /registration_receipt_binding_mismatch/,
  );
});
