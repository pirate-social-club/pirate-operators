// Actual private-file journal and public disposable fixture signatures.
// RPC wire facts are scripted; no public RPC, EVM or funds are used.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  decodeFunctionData,
  encodeDeployData,
  encodeFunctionData,
  encodeFunctionResult,
  getContractAddress,
  keccak256,
  padHex,
  parseTransaction,
  sha256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical } from "../../packages/protocol/index.ts";
import {
  pilotPlan,
  pilotTransaction,
  sha,
  type PilotAdmission,
  type PilotPlan,
} from "../../harness/megaeth/pilot-eip1559-plan.ts";
import {
  openPilotJournal,
  type PilotJournal,
  type PilotState,
} from "../../harness/megaeth/pilot-eip1559-journal.ts";
import { pilotRunner } from "../../harness/megaeth/pilot-eip1559-runner.ts";
import type { PilotRpc } from "../../harness/megaeth/pilot-eip1559-reader.ts";

const account = privateKeyToAccount(`0x${"71".repeat(32)}`),
  hex = (n: bigint) => ("0x" + n.toString(16)) as Hex;
const address = (n: number) =>
  ("0x" + n.toString(16).padStart(40, "0")) as Address;
const oracleAbi = [
  {
    type: "function",
    name: "getL1Fee",
    stateMutability: "view",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getL1FeeUpperBound",
    stateMutability: "view",
    inputs: [{ name: "size", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getOperatorFee",
    stateMutability: "view",
    inputs: [{ name: "gas", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
export async function pilotExecutionFixture(
  t: TestContext,
  window: {
    registrarRemainingSeconds?: bigint;
    minRegistrarRemainingSeconds?: bigint;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pilot-type2-")),
    parent = await readFile(
      new URL("./pilot-unsigned-parent.json", import.meta.url),
      "utf8",
    ),
    p = JSON.parse(parent) as PilotPlan,
    startedMs = Date.now(),
    nowS = BigInt(Math.floor(startedMs / 1000)),
    validUntil = nowS + (window.registrarRemainingSeconds ?? 604800n),
    deployer = account.address.toLowerCase() as Address;
  p.roles = {
    admin_deployer: deployer,
    registrar_funder: address(2),
    verifier_issuer: address(3),
    community_publisher: address(4),
  };
  p.predicted = {
    directory: getContractAddress({ from: deployer, nonce: 0n }),
    posts: getContractAddress({ from: deployer, nonce: 1n }),
  };
  const d = p.artifacts.CommunityDirectoryV3,
    b = p.artifacts.CommunityPostsV1;
  for (const r of b.immutableReferences) {
    const start = 2 + r.start * 2;
    b.runtime = (b.runtime.slice(0, start) +
      padHex(p.predicted.directory, { size: 32 }).slice(2) +
      b.runtime.slice(start + 64)) as Hex;
  }
  b.runtimeHash = keccak256(b.runtime);
  const args = [
    [deployer],
    [p.predicted.directory],
    [p.roles.verifier_issuer, deployer, p.roles.verifier_issuer],
    [p.roles.registrar_funder, String(validUntil), "1", "0"],
  ];
  const inputs = [
    encodeDeployData({ abi: d.abi, bytecode: d.initcode, args: [deployer] }),
    encodeDeployData({
      abi: b.abi,
      bytecode: b.initcode,
      args: [p.predicted.directory],
    }),
    encodeFunctionData({
      abi: d.abi,
      functionName: "setVerificationRoles",
      args: [p.roles.verifier_issuer, deployer, p.roles.verifier_issuer],
    }),
    encodeFunctionData({
      abi: d.abi,
      functionName: "configureRegistrar",
      args: [p.roles.registrar_funder, validUntil, 1n, 0n],
    }),
  ];
  for (const [i, s] of p.steps.entries()) {
    s.from = deployer;
    s.to = i < 2 ? null : p.predicted.directory;
    s.input = inputs[i]!;
    s.args = args[i]!;
    s.inputSha256 = sha(
      new Uint8Array(
        s.input
          .slice(2)
          .match(/../g)!
          .map((x) => parseInt(x, 16)),
      ),
    );
    if (i < 2) {
      s.expectedAddress = i === 0 ? p.predicted.directory : p.predicted.posts;
      s.expectedRuntimeHash = i === 0 ? d.runtimeHash : b.runtimeHash;
    }
  }
  const rawPlan = JSON.stringify(p),
    selection: PilotAdmission = {
      schema: "pirate.pilot-eip1559-selection/1",
      parentPlanSha256: sha(parent),
      planSha256: sha(rawPlan),
      source: p.source,
      wallet: deployer,
      walletFundingCapWei: "1000000000000000",
      maxSafeAgeSeconds: "900",
      minRegistrarRemainingSeconds: String(
        window.minRegistrarRemainingSeconds ?? 1n,
      ),
      deadlineMs: startedMs + 3600000,
      oracle: {
        address: address(40),
        proxyRuntimeHash: keccak256("0x6000"),
        implementation: address(41),
        implementationRuntimeHash: keccak256("0x6001"),
      },
    },
    pinned = pilotPlan(rawPlan, selection);
  let journal = await openPilotJournal(directory, pinned),
    runner: ReturnType<typeof pilotRunner>,
    signCalls = 0,
    loseSign = false,
    loseSend = false,
    badCode = false,
    orphan = false,
    balance = BigInt(selection.walletFundingCapWei),
    nonce = 0;
  let currentMs = startedMs,
    writeAdvance: { method: "beginSigning" | "attempted"; ms: number } | null =
      null;
  const clockAdvances: { method: string; index: number; ms: number }[] = [];
  const sent: Hex[] = [],
    beforeSendSnapshots: PilotState[] = [],
    blocks = new Map<
      string,
      {
        number: Hex;
        hash: Hex;
        timestamp: Hex;
        transactions: Hex[];
        baseFeePerGas: Hex;
        completed: number;
        balance: bigint;
      }
    >(),
    receipts = new Map<Hex, unknown>(),
    transactions = new Map<Hex, unknown>();
  let safe = {
    number: "0x64" as Hex,
    hash: sha("fixture-block-100"),
    timestamp: hex(nowS),
    transactions: [] as Hex[],
    baseFeePerGas: "0xf4240" as Hex,
    completed: 0,
    balance,
  };
  blocks.set(safe.number, safe);
  const encode = (abi: Abi, name: string, result: unknown) =>
    encodeFunctionResult({ abi, functionName: name, result } as never);
  const rpc: PilotRpc = {
    async request(method, params) {
      if (method === "eth_chainId") return "0x18c7";
      if (method === "eth_getBlockByNumber") {
        const block =
          params[0] === "safe" ? safe : blocks.get(String(params[0]));
        if (!block) return null;
        return { ...block, hash: orphan ? sha("fixture-reorg") : block.hash };
      }
      if (method === "eth_getTransactionCount") return hex(BigInt(nonce));
      if (method === "eth_getTransactionReceipt")
        return receipts.get(params[0] as Hex) ?? null;
      if (method === "eth_getTransactionByHash")
        return transactions.get(params[0] as Hex) ?? null;
      if (method === "eth_sendRawTransaction") {
        const raw = params[0] as Hex;
        beforeSendSnapshots.push(
          JSON.parse(await readFile(join(directory, "pilot.json"), "utf8")),
        );
        sent.push(raw);
        if (loseSend) {
          loseSend = false;
          throw Error("fixture send ACK lost");
        }
        return keccak256(raw);
      }
      const anchor = params[params.length - 1] as {
        blockHash: Hex;
        requireCanonical: boolean;
      };
      assert.equal(anchor.requireCanonical, true);
      const block = [...blocks.values()].find(
        (b) => b.hash === anchor.blockHash,
      );
      assert.ok(block);
      if (method === "eth_getBalance")
        return hex(block === safe ? balance : block.balance);
      if (method === "eth_getStorageAt")
        return (
          "0x" + selection.oracle.implementation.slice(2).padStart(64, "0")
        );
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_getCode") {
        const a = String(params[0]).toLowerCase();
        if (a === selection.oracle.address) return "0x6000";
        if (a === selection.oracle.implementation) return "0x6001";
        if (badCode) return "0x6002";
        if (a === p.predicted.directory.toLowerCase())
          return block.completed >= 1 ? d.runtime : "0x";
        if (a === p.predicted.posts.toLowerCase())
          return block.completed >= 2 ? b.runtime : "0x";
        assert.fail("unplanned code read");
      }
      assert.equal(method, "eth_call");
      const tx = params[0] as { to: string; data: Hex };
      if (tx.to.toLowerCase() === selection.oracle.address) {
        const call = decodeFunctionData({ abi: oracleAbi, data: tx.data });
        return encode(
          oracleAbi,
          call.functionName,
          call.functionName === "getOperatorFee" ? 0n : 100n,
        );
      }
      if (tx.to.toLowerCase() === p.predicted.posts.toLowerCase())
        return encode(b.abi, "directory", p.predicted.directory);
      const call = decodeFunctionData({ abi: d.abi, data: tx.data }),
        roles = block.completed >= 3,
        values: Record<string, unknown> = {
          admin: deployer,
          pendingAdmin: address(0),
          web2Verifier: roles ? p.roles.verifier_issuer : deployer,
          namespaceVerifier: deployer,
          listingAuthority: roles ? p.roles.verifier_issuer : deployer,
          registrarPermission: {
            account:
              block.completed >= 4 ? p.roles.registrar_funder : address(0),
            revision: block.completed >= 4 ? 1n : 0n,
            validUntil: block.completed >= 4 ? validUntil : 0n,
            totalLimit: block.completed >= 4 ? 1n : 0n,
            totalRegistered: 0n,
          },
        };
      assert.ok(call.functionName in values);
      return encode(d.abi, call.functionName, values[call.functionName]);
    },
  };
  const clock = () => currentMs;
  async function afterWrite(
    method: "beginSigning" | "attempted",
    index: number,
  ) {
    if (writeAdvance?.method !== method) return;
    const advance = writeAdvance.ms;
    writeAdvance = null;
    const durable = JSON.parse(
      await readFile(join(directory, "pilot.json"), "utf8"),
    ) as PilotState;
    assert.equal(
      durable.records[index]!.phase,
      method === "beginSigning" ? "signing" : "attempted",
    );
    clockAdvances.push({ method, index, ms: advance });
    currentMs += advance;
  }
  const journalAtBoundary = (): PilotJournal => {
    const inner = journal;
    return {
      ...inner,
      async beginSigning(index: number) {
        const row = await inner.beginSigning(index);
        await afterWrite("beginSigning", index);
        return row;
      },
      async attempted(index: number) {
        const row = await inner.attempted(index);
        await afterWrite("attempted", index);
        return row;
      },
    };
  };
  runner = pilotRunner(pinned, journalAtBoundary(), rpc, clock);
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    sent,
    beforeSendSnapshots,
    cap: () => BigInt(selection.walletFundingCapWei),
    runner: () => runner,
    journal: () => journal,
    clockMs: clock,
    deadlineMs: () => selection.deadlineMs,
    advanceAfterWrite(method: "beginSigning" | "attempted", ms: number) {
      assert.ok(Number.isSafeInteger(ms) && ms > 0);
      assert.equal(writeAdvance, null);
      writeAdvance = { method, ms };
    },
    signCalls: () => signCalls,
    signer: {
      address: deployer,
      async signTransaction(tx: ReturnType<typeof pilotTransaction>) {
        signCalls++;
        const raw = await account.signTransaction(tx);
        if (loseSign) {
          loseSign = false;
          throw Error("fixture signer response lost");
        }
        return raw;
      },
    },
    loseSignerResponse() {
      loseSign = true;
    },
    loseSendResponse() {
      loseSend = true;
    },
    balance(value: bigint) {
      balance = value;
    },
    wrongCode(value: boolean) {
      badCode = value;
    },
    reorg(value: boolean) {
      orphan = value;
    },
    receiptMissing(index: number) {
      const hash = journal.snapshot().records[index]!.hash!;
      assert.ok(receipts.has(hash));
      receipts.delete(hash);
    },
    receiptContradiction(index: number) {
      const hash = journal.snapshot().records[index]!.hash!,
        r = receipts.get(hash) as Record<string, unknown>;
      assert.ok(r);
      receipts.set(hash, {
        ...r,
        blockHash: sha("contradictory-original-block"),
      });
    },
    async restart() {
      await journal.close();
      journal = await openPilotJournal(directory, pinned);
      runner = pilotRunner(pinned, journalAtBoundary(), rpc, clock);
    },
    mine(index: number) {
      const row = journal.snapshot().records[index]!;
      assert.ok(row.raw && row.hash);
      const tx = parseTransaction(row.raw);
      assert.ok(tx.type === "eip1559");
      const number = hex(101n + BigInt(index)),
        hash = sha("fixture-mined-" + index),
        gasUsed = 21000n,
        gasPrice = 1000000n;
      balance -= gasUsed * gasPrice + 10n;
      nonce = index + 1;
      safe = {
        number,
        hash,
        timestamp: hex(nowS),
        transactions: [row.hash],
        baseFeePerGas: "0xf4240",
        completed: index + 1,
        balance,
      };
      blocks.set(number, safe);
      transactions.set(row.hash, {
        hash: row.hash,
        from: deployer,
        to: tx.to ?? null,
        input: tx.data,
        nonce: hex(BigInt(index)),
        value: "0x0",
        type: "0x2",
        chainId: "0x18c7",
        gas: hex(tx.gas!),
        maxFeePerGas: hex(tx.maxFeePerGas!),
        maxPriorityFeePerGas: "0x0",
        accessList: [],
        blockHash: hash,
        blockNumber: number,
        transactionIndex: "0x0",
      });
      receipts.set(row.hash, {
        transactionHash: row.hash,
        from: deployer,
        to: tx.to ?? null,
        blockHash: hash,
        blockNumber: number,
        transactionIndex: "0x0",
        status: "0x1",
        contractAddress:
          index < 2
            ? index === 0
              ? p.predicted.directory
              : p.predicted.posts
            : null,
        gasUsed: hex(gasUsed),
        effectiveGasPrice: hex(gasPrice),
        l1Fee: "0xa",
        operatorFee: "0x0",
        logs: [],
      });
    },
    async artifact(label: string) {
      const path = ".local/pilot-eip1559-journal/" + label + ".json",
        bytes =
          canonical({
            schema: "pirate.pilot-local-fixture/1",
            planSha256: sha(rawPlan),
            parentSha256: sha(parent),
            boundary: "real durable journal/signatures; scripted RPC",
            state: journal.snapshot(),
            sent: sent.map((raw) => keccak256(raw)),
            signCalls,
            clockMs: currentMs,
            deadlineMs: selection.deadlineMs,
            clockAdvances,
          }) + "\n";
      await mkdir(".local/pilot-eip1559-journal", { recursive: true });
      await writeFile(path, bytes);
      t.diagnostic(
        JSON.stringify({
          artifact: path,
          fileSha256: sha256(new TextEncoder().encode(bytes)),
        }),
      );
    },
  };
}
