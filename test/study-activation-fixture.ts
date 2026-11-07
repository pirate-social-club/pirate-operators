// Actual entrypoint, SQLite, cryptography and pin codecs; simulated RPC/IPFS only.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  keccak256,
  parseTransaction,
  stringToHex,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { learningV3PublicityPolicy } from "../services/learning-policy-v3.ts";
import {
  retainedLearningOperator,
  retainedResultsV2,
} from "../harness/study-release-profile.ts";
import {
  custodyScope,
  sha256File,
} from "../harness/megaeth/controller-inventory.ts";
import { compileStudyDeployment } from "../harness/megaeth/study-deployment-artifact.ts";
import { studyDeploymentPolicies } from "../harness/megaeth/study-deployment-plan.ts";
import { studyActivationSourceHash } from "../harness/megaeth/study-activation-source.ts";
import {
  activationReadinessScope,
  studyActivationPlan,
  type StudyActivationProfile,
} from "../harness/megaeth/study-activation-plan.ts";
import {
  activationChecks,
  activationMigrations,
  activationEvidenceKinds,
} from "../harness/megaeth/study-activation-readiness.ts";
import {
  studyActivationMain,
  type StudyActivationPorts,
} from "../harness/megaeth/study-activation.ts";
import { readControllerTransaction } from "../harness/megaeth/controller-dispatch-catalog.ts";
import {
  activationDirectoryCode,
  activationV2Code,
} from "./study-activation-contract-fixture.ts";
const artifact = compileStudyDeployment();
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export async function activationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "study-activation-")),
    stateDirectory = join(directory, "controller"),
    pinDirectory = join(directory, "pins");
  const key = `0x${"b".padStart(64, "0")}` as Hex,
    account = privateKeyToAccount(key),
    controller = account.address.toLowerCase() as Hex;
  const state = {
    now: Date.now(),
    active: false,
    chain: 6343,
    nonce: 30,
    pending: false,
    landed: true,
    lostSend: false,
    lostPin: false,
    pinRetained: false,
    keys: 0,
    secrets: 0,
    adds: 0,
    reconciles: 0,
    sends: [] as Hex[],
    code: true,
    grader: true,
    policy: true,
    gas: 100000n,
    price: 2n,
    balance: 100000000000n,
    dataFee: 1n,
    canonical: true,
    wrongPending: false,
    receiptStatus: "success" as "success" | "reverted",
  };
  const oldRaw = await account.signTransaction({
      type: "legacy",
      chainId: 6343,
      nonce: 29,
      to: controller,
      gas: 21000n,
      gasPrice: 1n,
      value: 0n,
    }),
    oldHash = keccak256(oldRaw);
  const inventoryPath = join(directory, "legacy.json"),
    custodyPath = join(directory, "custody.json"),
    readyPath = join(directory, "ready.json"),
    profilePath = join(directory, "profile.json");
  const history = [
    read("docs/deployments/first-song-managed-20261105.configuration.json")
      .configuration,
    read(
      "docs/deployments/first-song-managed-20261105.curated-configuration-plan.json",
    ).profile.manifest,
    read(
      "docs/deployments/learning-results-testnet-20261106.configuration.json",
    ).manifest,
  ].map((x) => ({ ...x, controller }));
  const contract = `0x${"1".repeat(40)}` as Hex,
    manifest = {
      ...history[2],
      configurationRevision: 4,
      learningRecords: contract,
    };
  const manifestBytes = new TextEncoder().encode(canonical(manifest)),
    pin = await preparePin(manifestBytes, "application/json"),
    policies = studyDeploymentPolicies(retainedLearningOperator.publisher);
  writeFileSync(
    inventoryPath,
    JSON.stringify({
      controller,
      communityId: firstSong.directoryProfile.communityId,
      intents: { old: { nonce: 29, raw: oldRaw, hash: oldHash } },
    }),
    { mode: 0o600 },
  );
  const p: StudyActivationProfile = {
    schema: "pirate.study-activation/1",
    chainId: 6343,
    communityId: firstSong.directoryProfile.communityId,
    controller,
    nonce: 30,
    history,
    historyHashes: history.map(hashJson),
    manifestSha256: hashJson(manifest),
    pin,
    contract,
    codeHash: keccak256(artifact.runtime),
    artifactHash: hashJson(artifact),
    sourceHash: studyActivationSourceHash(),
    policies: Object.fromEntries(
      Object.entries(policies).map(([n, x]) => [
        n,
        { sha256: x.sha256, uri: x.uri, effectivePeriod: "6" },
      ]),
    ) as StudyActivationProfile["policies"],
    release: {
      applicationProfile: hashText("application-profile"),
      applicationModule: hashText("application-module"),
      operatorProfile: hashText("operator-profile"),
      operatorModule: hashText("operator-module"),
      operatorTag: "a".repeat(32),
      stateNamespace: "b".repeat(32),
      speechNamespace: "c".repeat(32),
      readerSourceHash: hashText("readers"),
    },
    readiness: { record: readyPath, sha256: "0".repeat(64) },
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
      exclusions: ["synthetic legacy writers quiescent"],
    },
    gas: "1000000",
    maximumGasPriceWei: "10",
    dataFeeReserveWei: "100",
    maximumTotalWei: "10000100",
    notBefore: new Date(state.now - 1000).toISOString(),
    deadline: new Date(state.now + 60000).toISOString(),
  };
  const evidence = Object.fromEntries(
    activationEvidenceKinds.map((kind) => {
      const path = join(directory, kind + "-evidence.json");
      writeFileSync(
        path,
        JSON.stringify({
          kind,
          fixture: "synthetic receipt may predate activation window",
        }),
        { mode: 0o600 },
      );
      return [kind, { path, sha256: sha256File(path) }];
    }),
  );
  const refresh = () => {
    writeFileSync(
      readyPath,
      JSON.stringify({
        schema: "pirate.study-activation-readiness/1",
        scopeHash: activationReadinessScope(p),
        decision: "accept-activation",
        reviewedBy: "independent_reviewer",
        observedAt: new Date(state.now).toISOString(),
        validUntil: p.deadline,
        release: p.release,
        migrations: activationMigrations,
        checks: Object.fromEntries(activationChecks.map((k) => [k, true])),
        evidence,
      }),
      { mode: 0o600 },
    );
    p.readiness.sha256 = sha256File(readyPath);
    writeFileSync(
      custodyPath,
      JSON.stringify({
        schema: "pirate.controller-custody/1",
        scopeHash: custodyScope(p),
        ownerRole: "workspace_coordinator",
        inventoryCompleteForWindow: true,
        quiescentWriters: ["fixture"],
        exclusions: p.custody.exclusions,
        expiresAt: p.deadline,
      }),
      { mode: 0o600 },
    );
    p.custody.sha256 = sha256File(custodyPath);
    writeFileSync(profilePath, JSON.stringify(p), { mode: 0o600 });
  };
  refresh();
  const documents = new Map<string, string>();
  const logs = [] as any[];
  const base = BigInt(firstSong.directoryProfile.deploymentBlock);
  for (const [i, c] of [...history, manifest].entries()) {
    const bytes = canonical(c),
      ipfs = await preparePin(
        new TextEncoder().encode(bytes),
        "application/json",
      );
    documents.set(ipfs.uri.slice(7), bytes);
    logs.push({
      args: {
        communityId: p.communityId,
        revision: BigInt(i + 1),
        controller,
        publisher: c.publisher,
        operatorPayments: c.operatorPayments,
        learningRecords: c.learningRecords,
        sha256Digest: ipfs.sha256,
        uri: ipfs.uri,
      },
      blockNumber: base + 10n + BigInt(i),
      logIndex: i,
      blockHash: hashText("log" + i),
      transactionHash: hashText("tx" + i),
    });
  }
  for (const policy of Object.values(policies))
    documents.set(policy.uri.slice(7), policy.bytes);
  const transactions = new Map<
    Hex,
    { raw: Hex; landed: boolean; status: "success" | "reverted" }
  >();
  const blockHash = (block: bigint) => hashText("block" + block);
  const client = {
    getChainId: async () => state.chain,
    getBlockNumber: async () => base + 100n,
    getBlock: async ({ blockNumber = base + 100n }: any = {}) => ({
      number: blockNumber,
      hash: state.canonical ? blockHash(blockNumber) : hashText("orphan"),
      timestamp: 1794042000n,
    }),
    getCode: async ({ address }: any) =>
      address.toLowerCase() === p.contract
        ? state.code
          ? artifact.runtime
          : "0x"
        : address.toLowerCase() === retainedResultsV2.contract
          ? activationV2Code
          : activationDirectoryCode,
    getLogs: async ({ fromBlock, toBlock }: any) =>
      logs.filter(
        (x) =>
          x.blockNumber >= fromBlock &&
          x.blockNumber <= toBlock &&
          (state.active || x.args.revision <= 3n),
      ),
    readContract: async ({ functionName, args }: any) => {
      if (functionName === "getCommunity") {
        const log = logs[state.active ? 3 : 2];
        return {
          registry: history[2].registry,
          tldHash: hashText(history[2].tld),
          configurationRevision: state.active ? 4n : 3n,
          configuration: { ...log.args },
        };
      }
      if (functionName === "graders") return state.grader;
      if (functionName === "policyFor")
        return state.policy && BigInt(args[1]) >= 6n
          ? p.policies[Number(args[0]) === 1 ? "karaoke" : "study"].sha256
          : `0x${"0".repeat(64)}`;
      return (
        {
          VERSION: 3,
          controller,
          communityId: p.communityId,
          publicityPolicy: learningV3PublicityPolicy,
        } as any
      )[functionName];
    },
    getGasPrice: async () => state.price,
    getTransactionCount: async ({ blockTag }: any) =>
      state.nonce + (blockTag === "pending" && state.pending ? 1 : 0),
    getBalance: async () => state.balance,
    estimateGas: async () => state.gas,
    call: async () => ({
      data: encodeAbiParameters([{ type: "uint256" }], [state.dataFee]),
    }),
    getTransactionReceipt: async ({ hash }: any) => {
      if (hash === oldHash)
        return {
          transactionHash: hash,
          blockNumber: base + 50n,
          blockHash: blockHash(base + 50n),
          status: "success",
        };
      const tx = transactions.get(hash);
      if (!tx?.landed) {
        const e = Error("missing");
        e.name = "TransactionReceiptNotFoundError";
        throw e;
      }
      return {
        transactionHash: hash,
        blockNumber: base + 80n,
        blockHash: blockHash(base + 80n),
        status: tx.status,
      };
    },
    getTransaction: async ({ hash }: any) => {
      const row = transactions.get(hash);
      if (!row) throw Error("missing");
      const tx = parseTransaction(row.raw);
      return {
        hash,
        from: controller,
        nonce: tx.nonce,
        chainId: 6343,
        to: tx.to,
        input: state.wrongPending ? "0x" : tx.data,
        gas: tx.gas,
        gasPrice: tx.gasPrice,
        value: 0n,
        blockHash: null,
      };
    },
    sendRawTransaction: async ({ serializedTransaction: raw }: any) => {
      state.sends.push(raw);
      const hash = keccak256(raw);
      if (!transactions.has(hash)) {
        transactions.set(hash, {
          raw,
          landed: state.landed,
          status: state.receiptStatus,
        });
        if (state.landed) {
          state.nonce++;
          if (state.receiptStatus === "success") state.active = true;
        }
      }
      if (state.lostSend) throw Error("lost response");
      return hash;
    },
  } as unknown as PublicClient;
  const transport = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === "https://rpc.filebase.io") {
      if (url.pathname === "/api/v0/add") {
        state.adds++;
        state.pinRetained = true;
        if (state.lostPin) throw Error("lost pin response");
        return Response.json({ Hash: p.pin.uri.slice(7) });
      }
      if (url.pathname === "/api/v0/pin/ls") {
        state.reconciles++;
        return Response.json({
          Keys: state.pinRetained
            ? { [p.pin.uri.slice(7)]: { Type: "recursive" } }
            : {},
        });
      }
      throw Error("unexpected provider path");
    }
    const cid = url.pathname.slice("/ipfs/".length),
      body = documents.get(cid);
    return body && !(cid === p.pin.uri.slice(7) && !state.pinRetained)
      ? new Response(body)
      : new Response("unavailable", { status: 503 });
  };
  const ports: StudyActivationPorts = {
    artifact,
    client: () => client,
    stateDirectory,
    pinDirectory,
    transport,
    now: () => state.now,
    loadPinSecret: async () => {
      state.secrets++;
      return "synthetic-pin-token";
    },
    loadKey: () => {
      state.keys++;
      const row = readControllerTransaction(
        join(stateDirectory, hashJson(p).slice(2) + ".sqlite"),
        "deployment",
      );
      if (!row || row.raw) throw Error("key before durable unsigned intent");
      return key;
    },
  };
  const run = (extra: string[] = []) =>
    studyActivationMain(["--profile", profilePath, ...extra], ports) as Promise<
      Awaited<ReturnType<typeof studyActivationMain>> & {
        mode?: string;
        state?: string;
        complete?: boolean;
      }
    >;
  const execute = () =>
    run([
      "--execute",
      "--expect-profile",
      hashJson(p),
      "--key-file",
      "/synthetic/never-read",
    ]);
  return {
    directory,
    stateDirectory,
    pinDirectory,
    profile: p,
    profilePath,
    readyPath,
    evidence,
    artifact,
    state,
    ports,
    client,
    transport,
    refresh,
    run,
    execute,
    transactions,
  };
}
