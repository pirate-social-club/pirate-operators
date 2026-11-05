import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import {
  bytes32,
  canonical,
  exact,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import { address, httpsOrigin } from "./manifest-core.ts";
import type { CreatorConnectionBody } from "./creator-service.ts";

export const creatorServiceOrigin =
  "https://pirate-wallet-test.piratesocialclub.workers.dev";
export const creatorOperator =
  "0xe80513f6f72a375ef3fc279f74e904ba4ab244554abbd468559a13a811a82ea6";
export interface CreatorBindingPayload {
  schema: "pirate.creator-binding/1";
  network: "sui-ika-testnet";
  serviceOrigin: string;
  communityId: `0x${string}`;
  communityOrigin: string;
  connectionId: string;
  requestId: string;
  accountRef: `0x${string}`;
  state: string;
  credentialRef: `0x${string}`;
  suiAddress: `0x${string}`;
  dWalletId: `0x${string}`;
  capabilityId: `0x${string}`;
  shareId: `0x${string}`;
  evmAddress: `0x${string}`;
  operatorFunded: true;
  verifiedAt: number;
  expiresAt: number;
}
export async function verifyCreatorReceipt(
  input: unknown,
  expected: Omit<CreatorConnectionBody, "verifierHash"> & {
    communityId: string;
    communityOrigin: string;
    requestId: string;
  },
  now = Date.now(),
  // Explicit alternate key for isolated cryptographic fixtures, never taken
  // from a request or a binding response. Production uses the pinned operator.
  operatorAddress = creatorOperator,
  allowExpiredForRecovery = false,
) {
  const receipt = object(input);
  exact(receipt, ["payload", "signature"]);
  const p = object(receipt.payload);
  exact(p, [
    "schema",
    "network",
    "serviceOrigin",
    "communityId",
    "communityOrigin",
    "connectionId",
    "requestId",
    "accountRef",
    "state",
    "credentialRef",
    "suiAddress",
    "dWalletId",
    "capabilityId",
    "shareId",
    "evmAddress",
    "operatorFunded",
    "verifiedAt",
    "expiresAt",
  ]);
  insist(
    p.schema === "pirate.creator-binding/1" &&
      p.network === "sui-ika-testnet" &&
      p.operatorFunded === true,
    "invalid_creator_binding",
  );
  insist(
    httpsOrigin(p.serviceOrigin) === creatorServiceOrigin &&
      httpsOrigin(p.communityOrigin) === expected.communityOrigin &&
      bytes32(p.communityId) === expected.communityId &&
      p.connectionId === expected.connectionId &&
      p.requestId === expected.requestId &&
      bytes32(p.accountRef) === expected.accountRef &&
      p.state === expected.state,
    "creator_receipt_scope_mismatch",
    403,
  );
  const payload: CreatorBindingPayload = {
    schema: "pirate.creator-binding/1",
    network: "sui-ika-testnet",
    serviceOrigin: creatorServiceOrigin,
    communityId: bytes32(p.communityId),
    communityOrigin: expected.communityOrigin,
    connectionId: expected.connectionId,
    requestId: expected.requestId,
    accountRef: bytes32(p.accountRef),
    state: expected.state,
    credentialRef: bytes32(p.credentialRef),
    suiAddress: bytes32(p.suiAddress),
    dWalletId: bytes32(p.dWalletId),
    capabilityId: bytes32(p.capabilityId),
    shareId: bytes32(p.shareId),
    evmAddress: address(p.evmAddress),
    operatorFunded: true,
    verifiedAt: integer(p.verifiedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(p.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    payload.verifiedAt <= now &&
      payload.expiresAt > payload.verifiedAt &&
      payload.expiresAt <= payload.verifiedAt + 300_000,
    "invalid_creator_receipt_lifetime",
    409,
  );
  // Validate exact canonical fields before verifying. No unknown field or
  // normalization is permitted to change what the native operator signed.
  insist(canonical(payload) === canonical(p), "noncanonical_creator_receipt");
  const signature = text(receipt.signature, 1024);
  try {
    await verifyPersonalMessageSignature(
      new TextEncoder().encode(canonical(payload)),
      signature,
      { address: operatorAddress },
    );
  } catch {
    insist(false, "invalid_creator_receipt_signature", 403);
  }
  insist(
    allowExpiredForRecovery ||
      (payload.verifiedAt > now - 300_000 && payload.expiresAt > now),
    "creator_receipt_expired",
    409,
  );
  return { payload, signature };
}
