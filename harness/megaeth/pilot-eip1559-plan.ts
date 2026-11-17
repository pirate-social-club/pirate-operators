import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  padHex,
  serializeTransaction,
  sha256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { canonical, check } from "../../packages/protocol/index.ts";

export interface PilotAdmission {
  schema: "pirate.pilot-eip1559-selection/1";
  parentPlanSha256: Hex;
  planSha256: Hex;
  source: string;
  wallet: Address;
  walletFundingCapWei: string;
  maxSafeAgeSeconds: string;
  minRegistrarRemainingSeconds: string;
  deadlineMs: number;
  oracle: {
    address: Address;
    proxyRuntimeHash: Hex;
    implementation: Address;
    implementationRuntimeHash: Hex;
  };
}
interface Artifact {
  abi: Abi;
  initcode: Hex;
  runtime: Hex;
  runtimeHash: Hex;
  initcodeHash: Hex;
  abiSha256: Hex;
  artifactSha256: Hex;
  sources: Record<string, { sha256: Hex; keccak256: Hex }>;
  immutableReferences: { start: number; length: number }[];
}
export interface PilotStep {
  kind: string;
  nonce: string;
  from: Address;
  to: Address | null;
  input: Hex;
  value: string;
  gasCeiling: string;
  chainId: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  inputSha256: Hex;
  args: unknown[];
  expectedAddress?: Address;
  expectedRuntimeHash?: Hex;
}
export interface PilotPlan {
  schema: string;
  source: string;
  chainId: 6343;
  roles: Record<string, Address>;
  predicted: { directory: Address; posts: Address };
  artifacts: { CommunityDirectoryV3: Artifact; CommunityPostsV1: Artifact };
  steps: PilotStep[];
  totalBudgetWei: string;
}
export interface PinnedPilot {
  rawPlan: string;
  plan: PilotPlan;
  admission: PilotAdmission;
  pinHash: Hex;
}
export interface Anchor {
  number: string;
  hash: Hex;
  timestampS: string;
}
export interface PilotPreflight {
  anchor: Anchor;
  balanceWei: string;
  latestNonce: number;
  pendingNonce: number;
  estimateGas: string;
  quotes: { l1ExactWei: string; l1SizeWei: string; operatorWei: string };
  observedAtS: string;
}
export interface PilotProof {
  phase: "unknown" | "pending" | "confirmed" | "reverted";
  reason?: string;
  anchor?: Anchor;
  balanceAfterWei?: string;
  receipt?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  postconditions?: unknown;
  proofHash?: Hex;
}
export function uint(value: unknown): bigint {
  check(
    typeof value === "string" && /^(0|[1-9][0-9]*)(?![\s\S])/.test(value),
    "pilot_uint_invalid",
  );
  const n = BigInt(value);
  check(n < 2n ** 256n, "pilot_uint_invalid");
  return n;
}
export const sha = (s: string | Uint8Array) =>
  sha256(typeof s === "string" ? new TextEncoder().encode(s) : s);
export const equalAddress = (
  a: string | null | undefined,
  b: string | null | undefined,
) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const hexBytes = (s: unknown): s is Hex =>
  typeof s === "string" && /^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(s);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function pilotPlan(
  rawPlan: string,
  selection: PilotAdmission,
): PinnedPilot {
  const a = structuredClone(selection),
    p = JSON.parse(rawPlan) as PilotPlan;
  check(
    a.schema === "pirate.pilot-eip1559-selection/1" &&
      sha(rawPlan) === a.planSha256 &&
      /^0x[0-9a-f]{64}(?![\s\S])/.test(a.parentPlanSha256) &&
      /^[0-9a-f]{40}(?![\s\S])/.test(a.source) &&
      p.schema === "pirate.unsigned-pilot-deployment/1" &&
      p.chainId === 6343 &&
      p.source === a.source &&
      equalAddress(p.roles.admin_deployer, a.wallet),
    "pilot_plan_pin_changed",
  );
  check(
    uint(a.walletFundingCapWei) > 0n &&
      uint(a.walletFundingCapWei) <= 1000000000000000n &&
      uint(a.walletFundingCapWei) <= uint(p.totalBudgetWei) &&
      uint(a.maxSafeAgeSeconds) > 0n &&
      uint(a.maxSafeAgeSeconds) <= 900n &&
      uint(a.minRegistrarRemainingSeconds) > 0n &&
      Number.isSafeInteger(a.deadlineMs),
    "pilot_fuse_invalid",
  );
  check(
    Object.keys(p.roles).sort().join() ===
      "admin_deployer,community_publisher,registrar_funder,verifier_issuer" &&
      new Set(Object.values(p.roles).map((x) => x.toLowerCase())).size === 4 &&
      Object.values(p.roles).every(
        (x) => /^0x[0-9a-fA-F]{40}(?![\s\S])/.test(x) && BigInt(x) > 0n,
      ),
    "pilot_roles_invalid",
  );
  const d = p.artifacts.CommunityDirectoryV3,
    b = p.artifacts.CommunityPostsV1;
  for (const artifact of [d, b]) {
    check(
      hexBytes(artifact.initcode) &&
        hexBytes(artifact.runtime) &&
        keccak256(artifact.initcode) === artifact.initcodeHash &&
        keccak256(artifact.runtime) === artifact.runtimeHash &&
        sha(JSON.stringify(artifact.abi)) === artifact.abiSha256 &&
        Object.keys(artifact.sources).length > 0,
      "pilot_artifact_pin_changed",
    );
    for (const [path, pin] of Object.entries(artifact.sources))
      check(
        path.startsWith("contracts/") &&
          !path.includes("..") &&
          /^0x[0-9a-f]{64}(?![\s\S])/.test(pin.sha256) &&
          /^0x[0-9a-f]{64}(?![\s\S])/.test(pin.keccak256),
        "pilot_source_pin_invalid",
      );
  }
  check(
    d.immutableReferences.length === 0 &&
      b.immutableReferences.length === 2 &&
      equalAddress(
        getContractAddress({ from: a.wallet, nonce: 0n }),
        p.predicted.directory,
      ) &&
      equalAddress(
        getContractAddress({ from: a.wallet, nonce: 1n }),
        p.predicted.posts,
      ),
    "pilot_prediction_changed",
  );
  for (const r of b.immutableReferences)
    check(
      r.length === 32 &&
        Number.isSafeInteger(r.start) &&
        r.start >= 0 &&
        b.runtime
          .slice(2 + r.start * 2, 2 + (r.start + r.length) * 2)
          .toLowerCase() ===
          padHex(p.predicted.directory, { size: 32 }).slice(2).toLowerCase(),
      "pilot_posts_immutable_changed",
    );
  const kinds = [
    "deploy_directory_v3",
    "deploy_posts_v1",
    "set_verification_roles",
    "configure_registrar",
  ];
  check(p.steps.length === 4, "pilot_four_steps_only");
  const expectedArgs = [
    [a.wallet],
    [p.predicted.directory],
    [p.roles.verifier_issuer, a.wallet, p.roles.verifier_issuer],
    [p.roles.registrar_funder, p.steps[3]!.args[1], "1", "0"],
  ];
  const expected = [
    encodeDeployData({ abi: d.abi, bytecode: d.initcode, args: [a.wallet] }),
    encodeDeployData({
      abi: b.abi,
      bytecode: b.initcode,
      args: [p.predicted.directory],
    }),
    encodeFunctionData({
      abi: d.abi,
      functionName: "setVerificationRoles",
      args: [p.roles.verifier_issuer, a.wallet, p.roles.verifier_issuer],
    }),
    encodeFunctionData({
      abi: d.abi,
      functionName: "configureRegistrar",
      args: [p.roles.registrar_funder, uint(p.steps[3]!.args[1]), 1n, 0n],
    }),
  ];
  let execution = 0n;
  for (const [i, s] of p.steps.entries()) {
    check(
      s.kind === kinds[i] &&
        s.nonce === String(i) &&
        s.chainId === 6343 &&
        equalAddress(s.from, a.wallet) &&
        s.value === "0" &&
        s.maxFeePerGas === "2000000" &&
        s.maxPriorityFeePerGas === "0" &&
        s.gasCeiling === ["300000000", "100000000", "5000000", "5000000"][i] &&
        s.input === expected[i] &&
        canonical(s.args) === canonical(expectedArgs[i]) &&
        sha(
          new Uint8Array(
            s.input
              .slice(2)
              .match(/../g)!
              .map((x) => parseInt(x, 16)),
          ),
        ) === s.inputSha256 &&
        (i < 2 ? s.to === null : equalAddress(s.to, p.predicted.directory)),
      "pilot_step_changed",
    );
    if (i < 2)
      check(
        equalAddress(
          s.expectedAddress,
          i === 0 ? p.predicted.directory : p.predicted.posts,
        ) &&
          s.expectedRuntimeHash === (i === 0 ? d.runtimeHash : b.runtimeHash),
        "pilot_deployment_pin_changed",
      );
    execution += uint(s.gasCeiling) * uint(s.maxFeePerGas);
  }
  check(
    execution <= uint(a.walletFundingCapWei),
    "pilot_execution_exceeds_fuse",
  );
  return freeze({
    rawPlan,
    plan: p,
    admission: a,
    pinHash: sha(
      canonical({
        selection: { ...a, deadlineMs: 0 },
        planSha256: sha(rawPlan),
      }),
    ),
  });
}
export function pilotTransaction(p: PinnedPilot, index: number) {
  check(
    Number.isInteger(index) && index >= 0 && index < 4,
    "pilot_four_steps_only",
  );
  const s = p.plan.steps[index]!;
  return {
    type: "eip1559" as const,
    chainId: 6343,
    nonce: index,
    to: s.to ?? undefined,
    data: s.input,
    value: 0n,
    gas: uint(s.gasCeiling),
    maxFeePerGas: uint(s.maxFeePerGas),
    maxPriorityFeePerGas: 0n,
    accessList: [],
  };
}
export const pilotUnsigned = (p: PinnedPilot, index: number) =>
  serializeTransaction(pilotTransaction(p, index));
/** Applies to every new signature/first send. Expiry never blocks receipt-only recovery. */
export function pilotSpendWindow(
  p: PinnedPilot,
  nowMs: number,
  anchor?: Anchor,
) {
  check(Number.isSafeInteger(nowMs) && nowMs >= 0, "pilot_clock_invalid");
  check(nowMs < p.admission.deadlineMs, "pilot_execution_deadline_reached");
  const nowS = BigInt(Math.floor(nowMs / 1000));
  if (anchor)
    check(
      nowS >= uint(anchor.timestampS) &&
        nowS - uint(anchor.timestampS) <= uint(p.admission.maxSafeAgeSeconds),
      "pilot_safe_stale",
    );
  check(
    uint(p.plan.steps[3]!.args[1]) >=
      nowS + uint(p.admission.minRegistrarRemainingSeconds),
    "pilot_registrar_window_stale",
  );
}
