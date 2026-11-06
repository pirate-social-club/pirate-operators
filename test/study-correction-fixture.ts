// Fake public RPC; real codecs, signatures and read-only private journal parser.
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { digest } from "../packages/protocol/index.ts";
import {
  packStudyOutcomes,
  resultsV3Abi,
  resultCommitment,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import { learningV3PublicityPolicy } from "../services/learning-policy-v3.ts";
import {
  custodyScope,
  sha256File,
} from "../harness/megaeth/controller-inventory.ts";
import {
  correctionIntent,
  type StudyCorrectionProfile,
} from "../harness/megaeth/study-correction-plan.ts";
import type { TxStore } from "../services/operator-tx.ts";
import { studyResultFixture } from "./study-result-fixture.ts";

export async function correctionFixture() {
  const directory = mkdtempSync(join(tmpdir(), "study-correction-"));
  const key = `0x${"b".padStart(64, "0")}` as Hex,
    account = privateKeyToAccount(key);
  const { result, outcomes } = studyResultFixture().bundle;
  const prior = {
    result: JSON.parse(
      JSON.stringify(result, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ),
    outcomes,
    commitment: resultCommitment(result, outcomes),
    transactionHash: digest("prior-tx"),
    blockNumber: "100",
    blockHash: digest("block-100"),
    logIndex: 3,
  };
  const oldRaw = await account.signTransaction({
    type: "legacy",
    chainId: 6343,
    nonce: 24,
    to: account.address,
    data: "0x",
    gas: 21000n,
    gasPrice: 1n,
    value: 0n,
  });
  const oldHash = keccak256(oldRaw),
    inventoryPath = join(directory, "deployment.json"),
    custodyPath = join(directory, "custody.json");
  writeFileSync(
    inventoryPath,
    JSON.stringify({
      controller: account.address,
      communityId: result.song.communityId,
      intents: {
        old: { nonce: 24, raw: oldRaw, hash: oldHash, settled: true },
      },
    }),
    { mode: 0o600 },
  );
  const revised = unpackStudyOutcomes(outcomes, result.linesTotal);
  revised[0].status = "correct";
  const profile: StudyCorrectionProfile = {
    schema: "pirate.study-correction/1",
    chainId: 6343,
    directory: `0x${"a".repeat(40)}`,
    registry: `0x${"b".repeat(40)}`,
    contract: `0x${"c".repeat(40)}`,
    directoryCodeHash: keccak256("0x6000"),
    codeHash: keccak256("0x6000"),
    communityId: result.song.communityId,
    controller: account.address,
    publicityPolicy: learningV3PublicityPolicy,
    configurationRevision: "4",
    previous: prior,
    operation: {
      kind: "correct",
      outcomes: packStudyOutcomes(revised),
      status: 1,
    },
    nonce: 25,
    gas: "500000",
    maximumGasPriceWei: "10",
    dataFeeReserveWei: "100",
    maximumTotalWei: "5000100",
    notBefore: new Date(Date.now() - 1000).toISOString(),
    deadline: new Date(Date.now() + 60000).toISOString(),
    inventory: [
      {
        path: inventoryPath,
        sha256: sha256File(inventoryPath),
        format: "deploy-results-v2-custom",
      },
    ],
    custody: {
      record: custodyPath,
      sha256: "0".repeat(64),
      ownerRole: "workspace_coordinator",
      exclusions: [
        "All other signers and chains; no other writer may use this controller during the window",
      ],
    },
  };
  const refreshCustody = () => {
    writeFileSync(
      custodyPath,
      JSON.stringify({
        schema: "pirate.controller-custody/1",
        scopeHash: custodyScope(profile),
        ownerRole: "workspace_coordinator",
        inventoryCompleteForWindow: true,
        quiescentWriters: ["fixture-only"],
        exclusions: profile.custody.exclusions,
      }),
      { mode: 0o600 },
    );
    profile.custody.sha256 = sha256File(custodyPath);
  };
  refreshCustody();
  const event = resultsV3Abi.find(
    (item) => item.type === "event" && item.name === "ResultPublished",
  )!;
  const topics = encodeEventTopics({
    abi: resultsV3Abi,
    eventName: "ResultPublished",
    args: {
      sessionId: result.sessionId,
      learner: result.learner,
      revision: result.revision,
    },
  });
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !("indexed" in input && input.indexed)),
    [result, outcomes, prior.commitment, account.address],
  );
  const state = {
    chain: 6343,
    current: prior.commitment,
    latestNonce: 25,
    pendingNonce: 25,
    code: "0x6000" as Hex,
    version: 3,
    directoryRevision: 4n,
    canonical: true,
    sends: [] as Hex[],
    lostResponse: false,
    landed: false,
    dataFee: 1n,
    gas: 100000n,
    balance: 100000000n,
    receiptStatus: "success",
    keyReads: 0,
  };
  const receipt = (hash: Hex, block: bigint) => ({
    transactionHash: hash,
    blockNumber: block,
    blockHash: digest("block-" + block),
    status: state.receiptStatus,
    logs:
      hash === prior.transactionHash
        ? [{ address: profile.contract, topics, data, logIndex: 3 }]
        : [],
  });
  const rpc = {
    getChainId: async () => state.chain,
    getBlockNumber: async () => 200n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: state.canonical ? digest("block-" + blockNumber) : digest("orphan"),
    }),
    getCode: async () => state.code,
    readContract: async ({ functionName }: { functionName: string }) =>
      ({
        VERSION: state.version,
        controller: account.address,
        communityId: profile.communityId,
        publicityPolicy: profile.publicityPolicy,
        commitments: state.current,
        getCommunity: {
          registry: profile.registry,
          configurationRevision: state.directoryRevision,
          configuration: {
            learningRecords: profile.contract,
            controller: profile.controller,
          },
        },
      })[functionName as "VERSION"],
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      blockTag === "latest" ? state.latestNonce : state.pendingNonce,
    getGasPrice: async () => 2n,
    estimateGas: async () => state.gas,
    getBalance: async () => state.balance,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === prior.transactionHash) return receipt(hash, 100n);
      if (hash === oldHash) return receipt(hash, 50n);
      if (state.landed && state.sends.some((raw) => keccak256(raw) === hash))
        return receipt(hash, 180n);
      const error = new Error("missing");
      error.name = "TransactionReceiptNotFoundError";
      throw error;
    },
    call: async () => ({
      data: encodeAbiParameters([{ type: "uint256" }], [state.dataFee]),
    }),
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      state.sends.push(serializedTransaction);
      if (state.landed) {
        state.current = correctionIntent(profile).commitment;
        state.latestNonce = 26;
        state.pendingNonce = 26;
      }
      if (state.lostResponse) throw Error("simulated_lost_response");
      return keccak256(serializedTransaction);
    },
    getTransaction: async () => ({
      hash: keccak256(state.sends.at(-1)!),
      from: profile.controller,
      nonce: 25,
      chainId: 6343,
      to: profile.contract,
      input: correctionIntent(profile).data,
      gas: BigInt(profile.gas),
      gasPrice: 2n,
      value: 0n,
      blockHash: null,
    }),
  };
  let entries = new Map<string, unknown>();
  const journal: TxStore = {
    get: <T>(key: string) => structuredClone(entries.get(key)) as T | undefined,
    set: (key, value) => {
      entries.set(key, structuredClone(value));
    },
    delete: (key) => {
      entries.delete(key);
    },
    entries: (prefix) =>
      [...entries]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: (fn) => {
      const before = structuredClone(entries);
      try {
        return fn();
      } catch (error) {
        entries = before;
        throw error;
      }
    },
  };
  return {
    directory,
    inventoryPath,
    profile,
    state,
    journal,
    client: rpc as unknown as PublicClient,
    refreshCustody,
    loadKey: () => {
      state.keyReads++;
      return key;
    },
    files: () => readdirSync(directory).sort(),
  };
}
