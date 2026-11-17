import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Hex,
} from "viem";
import { check } from "../../packages/protocol/index.ts";
import {
  pilotSpendWindow,
  pilotTransaction,
  pilotUnsigned,
  uint,
  type Anchor,
  type PinnedPilot,
  type PilotPreflight,
  type PilotProof,
} from "./pilot-eip1559-plan.ts";
import { verifyPilotRaw, type PilotOriginal } from "./pilot-eip1559-journal.ts";

export interface PilotRpc {
  request(method: string, params: unknown[]): Promise<unknown>;
}
const METHODS = [
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_estimateGas",
  "eth_call",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_sendRawTransaction",
];
export function boundedPilotRpc(
  url: string,
  deadlineMs: number,
  maxBytes = 1048576,
): PilotRpc {
  const parsed = new URL(url);
  check(
    ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      Number.isSafeInteger(deadlineMs) &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 2097152,
    "pilot_rpc_configuration_invalid",
  );
  let sequence = 0;
  return {
    async request(method, params) {
      check(
        METHODS.includes(method) && Date.now() < deadlineMs,
        "pilot_rpc_scope_expired",
      );
      const id = ++sequence,
        controller = new AbortController(),
        timer = setTimeout(
          () => controller.abort(),
          Math.min(25000, deadlineMs - Date.now()),
        );
      try {
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        check(response.ok && response.body, "pilot_rpc_unavailable");
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            check(
              size <= maxBytes && Date.now() < deadlineMs,
              "pilot_rpc_response_bound",
            );
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        check(
          body.jsonrpc === "2.0" &&
            body.id === id &&
            !body.error &&
            Object.hasOwn(body, "result") &&
            Date.now() < deadlineMs,
          "pilot_rpc_unavailable",
        );
        return body.result;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
const hex = (n: bigint) => ("0x" + n.toString(16)) as Hex;
function quantity(value: unknown) {
  check(
    typeof value === "string" &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)(?![\s\S])/.test(value),
    "pilot_rpc_quantity_invalid",
  );
  return BigInt(value);
}
function object(value: unknown): Record<string, unknown> {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "pilot_rpc_object_invalid",
  );
  return value as Record<string, unknown>;
}
function block(value: unknown) {
  const b = object(value);
  check(
    typeof b.hash === "string" &&
      /^0x[0-9a-f]{64}(?![\s\S])/.test(b.hash) &&
      Array.isArray(b.transactions) &&
      b.transactions.every(
        (x) => typeof x === "string" && /^0x[0-9a-f]{64}(?![\s\S])/.test(x),
      ),
    "pilot_block_invalid",
  );
  return {
    number: String(quantity(b.number)),
    hash: b.hash as Hex,
    timestampS: String(quantity(b.timestamp)),
    transactions: b.transactions as Hex[],
    baseFeePerGas: b.baseFeePerGas,
  };
}
const at = (a: Anchor) => ({ blockHash: a.hash, requireCanonical: true });
const eq = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
async function safe(p: PinnedPilot, rpc: PilotRpc, nowMs: number) {
  check(
    quantity(await rpc.request("eth_chainId", [])) === 6343n,
    "pilot_wrong_chain",
  );
  const a = block(await rpc.request("eth_getBlockByNumber", ["safe", false])),
    now = BigInt(Math.floor(nowMs / 1000));
  check(
    now >= uint(a.timestampS) &&
      now - uint(a.timestampS) <= uint(p.admission.maxSafeAgeSeconds),
    "pilot_safe_stale",
  );
  return a;
}
async function finish(
  p: PinnedPilot,
  rpc: PilotRpc,
  a: Anchor,
  clock: () => number,
  fresh = true,
) {
  const again = block(
    await rpc.request("eth_getBlockByNumber", [hex(uint(a.number)), false]),
  );
  check(
    again.number === a.number &&
      again.hash === a.hash &&
      again.timestampS === a.timestampS &&
      quantity(await rpc.request("eth_chainId", [])) === 6343n,
    "pilot_anchor_changed",
  );
  const now = BigInt(Math.floor(clock() / 1000));
  if (fresh)
    check(
      now >= uint(a.timestampS) &&
        now - uint(a.timestampS) <= uint(p.admission.maxSafeAgeSeconds),
      "pilot_safe_stale",
    );
}
async function call(
  rpc: PilotRpc,
  address: string,
  abi: Abi,
  name: string,
  args: unknown[],
  anchor: Anchor,
) {
  const data = encodeFunctionData({ abi, functionName: name, args }),
    raw = await rpc.request("eth_call", [{ to: address, data }, at(anchor)]);
  check(
    typeof raw === "string" && /^0x(?:[0-9a-f]{2})*(?![\s\S])/.test(raw),
    "pilot_call_invalid",
  );
  return decodeFunctionResult({ abi, functionName: name, data: raw as Hex });
}
async function contracts(
  p: PinnedPilot,
  rpc: PilotRpc,
  a: Anchor,
  completed: number,
) {
  const d = p.plan.artifacts.CommunityDirectoryV3,
    b = p.plan.artifacts.CommunityPostsV1,
    expected = p.plan.predicted,
    code = async (address: string, bytes: Hex | null) => {
      const raw = await rpc.request("eth_getCode", [address, at(a)]);
      check(
        typeof raw === "string" &&
          raw.toLowerCase() === (bytes ?? "0x").toLowerCase(),
        "pilot_runtime_changed",
      );
    };
  await code(expected.directory, completed >= 1 ? d.runtime : null);
  await code(expected.posts, completed >= 2 ? b.runtime : null);
  const observed: Record<string, unknown> = {};
  if (completed >= 1) {
    for (const name of [
      "admin",
      "pendingAdmin",
      "web2Verifier",
      "namespaceVerifier",
      "listingAuthority",
    ])
      observed[name] = await call(rpc, expected.directory, d.abi, name, [], a);
    check(
      eq(observed.admin, p.admission.wallet) &&
        eq(observed.pendingAdmin, "0x" + "0".repeat(40)),
      "pilot_admin_changed",
    );
    const roles =
      completed >= 3
        ? [
            p.plan.roles.verifier_issuer,
            p.admission.wallet,
            p.plan.roles.verifier_issuer,
          ]
        : [p.admission.wallet, p.admission.wallet, p.admission.wallet];
    check(
      ["web2Verifier", "namespaceVerifier", "listingAuthority"].every(
        (name, i) => eq(observed[name], roles[i]!),
      ),
      "pilot_roles_changed",
    );
    const r = object(
      await call(rpc, expected.directory, d.abi, "registrarPermission", [], a),
    );
    observed.registrar = JSON.parse(
      JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)),
    );
    check(
      eq(
        r.account,
        completed >= 4 ? p.plan.roles.registrar_funder! : "0x" + "0".repeat(40),
      ) &&
        r.revision === (completed >= 4 ? 1n : 0n) &&
        r.validUntil ===
          (completed >= 4 ? uint(p.plan.steps[3]!.args[1]) : 0n) &&
        r.totalLimit === (completed >= 4 ? 1n : 0n) &&
        r.totalRegistered === 0n,
      "pilot_registrar_changed",
    );
  }
  if (completed >= 2)
    check(
      eq(
        await call(rpc, expected.posts, b.abi, "directory", [], a),
        expected.directory,
      ),
      "pilot_posts_directory_changed",
    );
  return observed;
}
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
const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export async function pilotPreflight(
  p: PinnedPilot,
  rpc: PilotRpc,
  index: number,
  clock: () => number,
): Promise<PilotPreflight> {
  pilotSpendWindow(p, clock());
  const tx = pilotTransaction(p, index),
    a = await safe(p, rpc, clock());
  await contracts(p, rpc, a, index);
  check(
    quantity(a.baseFeePerGas) <= tx.maxFeePerGas,
    "pilot_base_fee_over_ceiling",
  );
  const [balance, latest, pending] = await Promise.all([
    rpc.request("eth_getBalance", [p.admission.wallet, at(a)]),
    rpc.request("eth_getTransactionCount", [p.admission.wallet, "latest"]),
    rpc.request("eth_getTransactionCount", [p.admission.wallet, "pending"]),
  ]);
  check(
    quantity(latest) === BigInt(index) && quantity(pending) === BigInt(index),
    "pilot_nonce_changed",
  );
  const balanceWei = quantity(balance);
  check(
    balanceWei > 0n && balanceWei <= uint(p.admission.walletFundingCapWei),
    "pilot_wallet_funding_fuse",
  );
  const o = p.admission.oracle,
    proxy = await rpc.request("eth_getCode", [o.address, at(a)]),
    implementation = await rpc.request("eth_getStorageAt", [
      o.address,
      implementationSlot,
      at(a),
    ]),
    code = await rpc.request("eth_getCode", [o.implementation, at(a)]);
  check(
    typeof proxy === "string" &&
      keccak256(proxy as Hex) === o.proxyRuntimeHash &&
      typeof code === "string" &&
      keccak256(code as Hex) === o.implementationRuntimeHash &&
      eq(implementation, "0x" + o.implementation.slice(2).padStart(64, "0")),
    "pilot_oracle_identity_changed",
  );
  const unsigned = pilotUnsigned(p, index),
    quotes = {
      l1ExactWei: String(
        await call(rpc, o.address, oracleAbi, "getL1Fee", [unsigned], a),
      ),
      l1SizeWei: String(
        await call(
          rpc,
          o.address,
          oracleAbi,
          "getL1FeeUpperBound",
          [BigInt((unsigned.length - 2) / 2)],
          a,
        ),
      ),
      operatorWei: String(
        await call(rpc, o.address, oracleAbi, "getOperatorFee", [tx.gas], a),
      ),
    };
  const q =
    uint(quotes.l1ExactWei) > uint(quotes.l1SizeWei)
      ? uint(quotes.l1ExactWei)
      : uint(quotes.l1SizeWei);
  // Affordability observation only. Quotes are NEVER a total-charge cap.
  check(
    balanceWei >= tx.gas * tx.maxFeePerGas + q + uint(quotes.operatorWei),
    "pilot_balance_insufficient",
  );
  const estimate = quantity(
    await rpc.request("eth_estimateGas", [
      {
        from: p.admission.wallet,
        to: tx.to,
        data: tx.data,
        value: "0x0",
        nonce: hex(BigInt(index)),
        gas: hex(tx.gas),
        maxFeePerGas: hex(tx.maxFeePerGas),
        maxPriorityFeePerGas: "0x0",
      },
      at(a),
    ]),
  );
  check(estimate > 0n && estimate <= tx.gas, "pilot_gas_ceiling_exceeded");
  await finish(p, rpc, a, clock);
  pilotSpendWindow(p, clock(), a);
  return {
    anchor: { number: a.number, hash: a.hash, timestampS: a.timestampS },
    balanceWei: String(balanceWei),
    latestNonce: index,
    pendingNonce: index,
    estimateGas: String(estimate),
    quotes,
    observedAtS: String(Math.floor(clock() / 1000)),
  };
}
export async function pilotReceipt(
  p: PinnedPilot,
  rpc: PilotRpc,
  row: PilotOriginal,
  clock: () => number,
): Promise<PilotProof> {
  check(
    row.raw &&
      row.hash &&
      (await verifyPilotRaw(p, row.index, row.raw)) === row.hash,
    "pilot_original_changed",
  );
  const receiptValue = await rpc.request("eth_getTransactionReceipt", [
    row.hash,
  ]);
  if (receiptValue === null)
    return { phase: "unknown", reason: "original_receipt_absent" };
  const r = object(receiptValue),
    tx = pilotTransaction(p, row.index),
    b = block(
      await rpc.request("eth_getBlockByNumber", [r.blockNumber, false]),
    ),
    t = object(await rpc.request("eth_getTransactionByHash", [row.hash])),
    s = await safe(p, rpc, clock());
  const index = quantity(r.transactionIndex),
    status = quantity(r.status);
  check(
    (status === 0n || status === 1n) &&
      r.transactionHash === row.hash &&
      t.hash === row.hash &&
      eq(r.from, p.admission.wallet) &&
      eq(t.from, p.admission.wallet) &&
      (tx.to
        ? eq(r.to, tx.to) && eq(t.to, tx.to)
        : r.to === null && t.to === null) &&
      r.blockHash === b.hash &&
      t.blockHash === b.hash &&
      t.blockNumber === r.blockNumber &&
      t.transactionIndex === r.transactionIndex &&
      quantity(t.nonce) === BigInt(row.index) &&
      t.input === tx.data &&
      quantity(t.value) === 0n &&
      quantity(t.type) === 2n &&
      quantity(t.chainId) === 6343n &&
      quantity(t.gas) === tx.gas &&
      quantity(t.maxFeePerGas) === tx.maxFeePerGas &&
      quantity(t.maxPriorityFeePerGas) === 0n &&
      Array.isArray(t.accessList) &&
      t.accessList.length === 0 &&
      index <= BigInt(Number.MAX_SAFE_INTEGER) &&
      b.transactions[Number(index)] === row.hash &&
      quantity(r.blockNumber) === uint(b.number),
    "pilot_original_receipt_changed",
  );
  check(
    quantity(r.gasUsed) <= tx.gas &&
      quantity(r.effectiveGasPrice) <= tx.maxFeePerGas,
    "pilot_receipt_fee_invalid",
  );
  if (uint(s.number) < uint(b.number))
    return { phase: "pending", receipt: r, transaction: t };
  if (row.index < 2 && status === 1n)
    check(
      eq(r.contractAddress, p.plan.steps[row.index]!.expectedAddress!),
      "pilot_created_address_changed",
    );
  const postconditions =
    status === 1n ? await contracts(p, rpc, b, row.index + 1) : null;
  const balanceAfterWei = String(
    quantity(await rpc.request("eth_getBalance", [p.admission.wallet, at(b)])),
  );
  check(
    uint(balanceAfterWei) <= uint(row.preflight.balanceWei),
    "pilot_unexplained_wallet_credit",
  );
  await finish(p, rpc, b, clock, false);
  await finish(p, rpc, s, clock);
  return {
    phase: status === 1n ? "confirmed" : "reverted",
    anchor: { number: b.number, hash: b.hash, timestampS: b.timestampS },
    balanceAfterWei,
    receipt: r,
    transaction: t,
    postconditions,
  };
}
