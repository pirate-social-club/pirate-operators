import { getAddress, type Address, type Hex } from "viem";
import { digest } from "../../packages/protocol/index.ts";
import { veryScopeForPool } from "../../packages/protocol/very-reward-scope.ts";
import { CONTEXT_ID, FROM, TO } from "../../packages/very/proof.ts";

export class AttesterError extends Error {}
export function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new AttesterError(reason);
}
export function exactObject(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_input",
  );
  requireValue(
    Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    "invalid_input",
  );
  return value as Record<string, unknown>;
}
export function address(value: unknown): Address {
  requireValue(
    typeof value === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(value) &&
      BigInt(value) !== 0n,
    "invalid_address",
  );
  return getAddress(value.toLowerCase());
}
export function bytes32(value: unknown): Hex {
  requireValue(
    typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
    "invalid_bytes32",
  );
  return value.toLowerCase() as Hex;
}
export interface AttesterConfig {
  chainId: 31337 | 84532;
  pool: Address;
  drawingId: string;
  poolCodeHash: Hex;
  attester: Address;
  appId: string;
}
export function configuration(value: unknown): AttesterConfig {
  const v = exactObject(value, [
    "chainId",
    "pool",
    "drawingId",
    "poolCodeHash",
    "attester",
    "appId",
  ]);
  requireValue(v.chainId === 31337 || v.chainId === 84532, "testnet_only");
  requireValue(
    typeof v.drawingId === "string" &&
      /^(0|[1-9][0-9]{0,77})$/.test(v.drawingId) &&
      BigInt(v.drawingId) < 1n << 256n,
    "invalid_drawing",
  );
  requireValue(
    typeof v.appId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        v.appId,
      ),
    "invalid_app_id",
  );
  return {
    chainId: v.chainId,
    pool: address(v.pool),
    drawingId: v.drawingId,
    poolCodeHash: bytes32(v.poolCodeHash),
    attester: address(v.attester),
    appId: v.appId.toLowerCase(),
  };
}
export function context(config: AttesterConfig) {
  return veryScopeForPool({
    chainId: BigInt(config.chainId),
    pool: config.pool,
    drawingId: BigInt(config.drawingId),
  });
}
export function configurationHash(config: AttesterConfig) {
  return digest({
    ...config,
    mapping: "pirate-very-reward-scope/1",
    assurance: "testnet-hosted-broad-window-app-origin-unproven/1",
    proof: {
      context: CONTEXT_ID,
      type: "3",
      from: FROM,
      to: TO,
      expiryLowerBound: FROM,
    },
    verifier: "https://verify.very.org/api/v1/verify",
  });
}
export interface Challenge {
  id: Hex;
  claimant: Address;
  binding: string;
  expiresAt: number;
  scope: Hex;
  configHash: Hex;
}
export interface Permit {
  nullifier: Hex;
  expiresAt: string;
  signature: Hex;
}
export const authenticationTypes = {
  VeryAuthentication: [
    { name: "scope", type: "bytes32" },
    { name: "configHash", type: "bytes32" },
    { name: "claimant", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "binding", type: "uint128" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;
export function authentication(config: AttesterConfig, challenge: Challenge) {
  return {
    domain: {
      name: "Pirate Very Attester",
      version: "1",
      chainId: config.chainId,
      verifyingContract: config.pool,
    },
    types: authenticationTypes,
    primaryType: "VeryAuthentication" as const,
    message: {
      scope: challenge.scope,
      configHash: challenge.configHash,
      claimant: challenge.claimant,
      nonce: challenge.id,
      binding: BigInt(challenge.binding),
      expiresAt: BigInt(challenge.expiresAt),
    },
  };
}
