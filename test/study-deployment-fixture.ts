// Simulated public RPC and IPFS; real codecs, private SQLite and signatures.
import { mkdtempSync, writeFileSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  keccak256,
  parseTransaction,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { digest } from "../packages/protocol/index.ts";
import { hashJson } from "../packages/community/common.ts";
import { learningV3PublicityPolicy } from "../services/learning-policy-v3.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { compileStudyDeployment } from "../harness/megaeth/study-deployment-artifact.ts";
import {
  studyDeploymentPlan,
  studyDeploymentPolicies,
  type StudyDeploymentProfile,
} from "../harness/megaeth/study-deployment-plan.ts";
import {
  custodyScope,
  sha256File,
} from "../harness/megaeth/controller-inventory.ts";
import { getContractAddress } from "viem";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import {
  registerControllerOperation,
  markControllerOperationPrepared,
} from "../harness/megaeth/controller-dispatch-catalog.ts";
import { runStudyDeploymentOperation } from "../harness/megaeth/study-deployment-runner.ts";
const artifactV3 = compileStudyDeployment();
const artifactV4 = compileStudyDeployment(undefined, 4);
export async function studyDeploymentFixture(version: 3 | 4 = 3) {
  const artifact = version === 4 ? artifactV4 : artifactV3;
  const directory = mkdtempSync(join(tmpdir(), "study-deployment-"));
  chmodSync(directory, 0o700);
  const key = `0x${"b".padStart(64, "0")}` as Hex;
  const account = privateKeyToAccount(key),
    nonce = 25;
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
    inventoryPath = join(directory, "legacy.json"),
    custodyPath = join(directory, "custody.json");
  writeFileSync(
    inventoryPath,
    JSON.stringify({
      controller: account.address,
      communityId: digest("community"),
      intents: {
        old: { nonce: 24, raw: oldRaw, hash: oldHash, settled: true },
      },
    }),
    { mode: 0o600 },
  );
  const policyDocuments = studyDeploymentPolicies(`0x${"d".repeat(40)}`);
  const profile: StudyDeploymentProfile = {
    schema:
      version === 4 ? "pirate.study-deployment/2" : "pirate.study-deployment/1",
    ...(version === 4 ? { communityOrigin: firstSong.origin } : {}),
    chainId: 6343,
    directory: `0x${"a".repeat(40)}`,
    directoryCodeHash: keccak256("0x6000"),
    registry: `0x${"b".repeat(40)}`,
    configurationRevision: version === 4 ? "5" : "3",
    resultsV2: {
      contract: `0x${"c".repeat(40)}`,
      codeHash: keccak256("0x6000"),
    },
    communityId: digest("community"),
    controller: account.address,
    contract: getContractAddress({
      from: account.address,
      nonce: BigInt(nonce),
    }),
    grader: `0x${"d".repeat(40)}`,
    publicityPolicy:
      version === 4 ? learningV4PublicityPolicy : learningV3PublicityPolicy,
    sourceHash: artifact.sourceHash,
    artifactHash: hashJson(artifact),
    nonce,
    policies: {
      karaoke: {
        sha256: policyDocuments.karaoke.sha256,
        uri: policyDocuments.karaoke.uri,
        effectivePeriod: "100",
      },
      study: {
        sha256: policyDocuments.study.sha256,
        uri: policyDocuments.study.uri,
        effectivePeriod: "100",
      },
    },
    gas: {
      deploy: "10000000",
      karaoke_grader: "500000",
      study_grader: "500000",
      karaoke_policy: "500000",
      study_policy: "500000",
    },
    maximumGasPriceWei: "10",
    dataFeeReserveWei: "100",
    maximumTotalWei: "120000500",
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
        "All other controller writers are quiescent for this fixture",
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
        quiescentWriters: ["fixture"],
        exclusions: profile.custody.exclusions,
      }),
      { mode: 0o600 },
    );
    profile.custody.sha256 = sha256File(custodyPath);
  };
  refreshCustody();
  const transactions = new Map<
    Hex,
    { raw: Hex; status: "success" | "reverted"; landed: boolean }
  >();
  const state = {
    chain: 6343,
    stage: 0,
    consumed: 0,
    pending: false,
    landed: true,
    lostResponse: false,
    receiptStatus: "success" as "success" | "reverted",
    predecessorCode: "0x6000" as Hex,
    v3Code: artifact.runtime,
    directoryRevision: version === 4 ? 5n : 3n,
    canonical: true,
    gas: 100000n,
    price: 2n,
    balance: 1000000000n,
    dataFee: 1n,
    keyReads: 0,
    sends: [] as Hex[],
    policyBytes: true,
    identity: true,
    wrongPending: false,
  };
  const receipt = (
    hash: Hex,
    block: bigint,
    tx?: { raw: Hex; status: "success" | "reverted" },
  ) => ({
    transactionHash: hash,
    blockNumber: block,
    blockHash: digest("block-" + block),
    status: tx?.status ?? "success",
    contractAddress:
      tx && !parseTransaction(tx.raw).to ? profile.contract : null,
  });
  const rpc = {
    getChainId: async () => state.chain,
    getBlockNumber: async () => 200n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: state.canonical ? digest("block-" + blockNumber) : digest("orphan"),
      timestamp: 1800000000n,
    }),
    getCode: async ({ address }: { address: string }) =>
      address.toLowerCase() === profile.contract.toLowerCase()
        ? state.stage
          ? state.v3Code
          : "0x"
        : state.predecessorCode,
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      if (functionName === "getCommunity")
        return {
          registry: profile.registry,
          configurationRevision: state.directoryRevision,
          configuration: {
            controller: profile.controller,
            learningRecords: profile.resultsV2.contract,
          },
        };
      if (functionName === "graders")
        return Number(args?.[1]) === 1 ? state.stage >= 2 : state.stage >= 3;
      if (functionName === "policyFor")
        return Number(args?.[0]) === 1 && state.stage >= 4
          ? profile.policies.karaoke.sha256
          : Number(args?.[0]) === 2 && state.stage >= 5
            ? profile.policies.study.sha256
            : `0x${"0".repeat(64)}`;
      return (
        {
          VERSION: version,
          communityOrigin: profile.communityOrigin,
          controller: state.identity ? account.address : profile.grader,
          communityId: profile.communityId,
          publicityPolicy: profile.publicityPolicy,
        } as Record<string, unknown>
      )[functionName];
    },
    getGasPrice: async () => state.price,
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      nonce +
      state.consumed +
      (blockTag === "pending" && state.pending ? 1 : 0),
    getBalance: async () => state.balance,
    estimateGas: async () => state.gas,
    call: async () => ({
      data: encodeAbiParameters([{ type: "uint256" }], [state.dataFee]),
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (hash === oldHash) return receipt(hash, 100n);
      const tx = transactions.get(hash);
      if (!tx?.landed) {
        const e = new Error("missing");
        e.name = "TransactionReceiptNotFoundError";
        throw e;
      }
      return receipt(hash, 180n, tx);
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const row = transactions.get(hash);
      if (!row) throw Error("missing");
      const tx = parseTransaction(row.raw);
      return {
        hash,
        from: profile.controller,
        nonce: tx.nonce,
        chainId: 6343,
        to: tx.to ?? null,
        input: state.wrongPending ? "0x" : tx.data,
        gas: tx.gas,
        gasPrice: tx.gasPrice,
        value: 0n,
        blockHash: null,
      };
    },
    sendRawTransaction: async ({
      serializedTransaction: raw,
    }: {
      serializedTransaction: Hex;
    }) => {
      state.sends.push(raw);
      const hash = keccak256(raw),
        tx = parseTransaction(raw);
      if (!transactions.has(hash)) {
        if (tx.nonce !== nonce + state.consumed) throw Error("wrong_nonce");
        transactions.set(hash, {
          raw,
          landed: state.landed,
          status: state.receiptStatus,
        });
        if (state.landed) {
          state.consumed++;
          if (state.receiptStatus === "success") state.stage++;
        }
      }
      if (state.lostResponse) throw Error("simulated_lost_response");
      return hash;
    },
  };
  const client = rpc as unknown as PublicClient;
  const transport = async (request: Request) => {
    const policy = Object.values(policyDocuments).find((p) =>
      request.url.endsWith(p.uri.slice(7)),
    );
    return new Response(state.policyBytes && policy ? policy.bytes : "changed");
  };
  const loadKey = () => {
    state.keyReads++;
    return key;
  };
  const open = async (index = state.stage) => {
    const operation = studyDeploymentPlan(profile, artifact).operations[index];
    const path = join(directory, operation.profileHash.slice(2) + ".sqlite");
    const lease = new ActivationJournal(
      join(directory, "dispatch-custody.sqlite"),
    );
    try {
      await registerControllerOperation(client, operation, lease, path);
    } catch (error) {
      lease.close();
      throw error;
    }
    const journal = new ActivationJournal(path);
    return {
      operation,
      path,
      journal,
      lease,
      run: (key = loadKey) =>
        runStudyDeploymentOperation(
          client,
          profile,
          artifact,
          operation,
          journal,
          key,
          (row) =>
            markControllerOperationPrepared(lease, path, row, "deployment"),
          () => Date.now(),
          transport,
        ),
      close: () => {
        journal.close();
        lease.close();
      },
    };
  };
  return {
    directory,
    key,
    account,
    oldRaw,
    oldHash,
    inventoryPath,
    profile,
    artifact,
    state,
    client,
    transport,
    loadKey,
    refreshCustody,
    open,
    files: () => readdirSync(directory).sort(),
    transactions,
  };
}
