import {
  encodeAbiParameters,
  keccak256,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const POOL_SCOPE_DOMAIN = "pirate-pool-registration/1";
export const VERY_SCOPE_DOMAIN = "pirate-very-external-nullifier/1";
export const VERY_NULLIFIER_DOMAIN = "pirate-very-reward-nullifier/1";
export const VERY_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const UINT256_LIMIT = 1n << 256n;
const UINT160_LIMIT = 1n << 160n;

export interface RewardPoolContext {
  chainId: bigint;
  pool: Address;
  drawingId: bigint;
}

function uint256(value: bigint, label: string, nonzero = false) {
  if (
    typeof value !== "bigint" ||
    value < (nonzero ? 1n : 0n) ||
    value >= UINT256_LIMIT
  )
    throw new Error(`invalid_${label}`);
}

function scopeBytes(scope: Hex): Hex {
  if (typeof scope !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(scope))
    throw new Error("invalid_reward_scope");
  return scope.toLowerCase() as Hex;
}

function positiveDecimal(value: string, limit: bigint, label: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,76}$/.test(value))
    throw new Error(`invalid_${label}`);
  const parsed = BigInt(value);
  if (parsed >= limit) throw new Error(`invalid_${label}`);
  return parsed;
}

/** Recompute and compare with the configured deployed pool's scope(). No I/O. */
export function rewardPoolScope(context: RewardPoolContext): Hex {
  uint256(context.chainId, "chain_id", true);
  uint256(context.drawingId, "drawing_id");
  if (
    typeof context.pool !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(context.pool) ||
    BigInt(context.pool) === 0n
  )
    throw new Error("invalid_pool_address");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        POOL_SCOPE_DOMAIN,
        context.chainId,
        context.pool.toLowerCase() as Address,
        context.drawingId,
      ],
    ),
  );
}

export function expectedVeryScopeSignal(externalNullifier: string): string {
  positiveDecimal(externalNullifier, UINT160_LIMIT, "very_external_nullifier");
  return (
    BigInt(sha256(stringToHex(externalNullifier))) % VERY_SCALAR_FIELD
  ).toString(10);
}

/** Version 1 mapping; wallet and challenge are deliberately not inputs. */
export function veryScopeForPool(context: RewardPoolContext) {
  const scope = rewardPoolScope(context);
  const domainHash = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }],
      [VERY_SCOPE_DOMAIN, scope],
    ),
  );
  const numeric = BigInt(domainHash) & (UINT160_LIMIT - 1n);
  if (numeric === 0n) throw new Error("zero_very_scope");
  const externalNullifier = numeric.toString(10);
  return {
    scope,
    externalNullifier,
    expectedScopeSignal: expectedVeryScopeSignal(externalNullifier),
  };
}

/** Call only after independently validating the proof. Hashing is not verification. */
export function veryRewardNullifier(scope: Hex, verifiedSubject: string): Hex {
  const subject = positiveDecimal(
    verifiedSubject,
    VERY_SCALAR_FIELD,
    "very_subject",
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }],
      [VERY_NULLIFIER_DOMAIN, scopeBytes(scope), subject],
    ),
  );
}
