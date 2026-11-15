import type { Address, Hex } from "viem";
import { bytes32, exact, insist, integer, object } from "./common.ts";
import { address } from "./manifest-core.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import { ownerOnly } from "./owner-policy.ts";

export interface OwnerAuthorization {
  schema:
    | "pirate.owner-publishing-authorization/1"
    | "pirate.owner-publishing-authorization/2";
  communityId: string;
  ownerWallet: string;
  policy: { version: string; sha256: string };
  validFrom: number;
  expiresAt: number;
}
export interface SignedOwnerAuthorization {
  authorization: OwnerAuthorization;
  signature: Hex;
}
/** Strict wire parser, shared by releases and runtime. No signature rewriting. */
export function ownerAuthorizationRecord(
  value: unknown,
): SignedOwnerAuthorization {
  const signed = object(value);
  exact(signed, ["authorization", "signature"]);
  const a = object(signed.authorization),
    policy = object(a.policy);
  exact(a, [
    "schema",
    "communityId",
    "ownerWallet",
    "policy",
    "validFrom",
    "expiresAt",
  ]);
  exact(policy, ["version", "sha256"]);
  insist(
    a.schema === "pirate.owner-publishing-authorization/1" ||
      a.schema === "pirate.owner-publishing-authorization/2",
    "unknown_owner_authorization_schema",
  );
  const authorization: OwnerAuthorization = {
    schema: a.schema,
    communityId: bytes32(a.communityId),
    ownerWallet: address(a.ownerWallet),
    policy: { version: String(policy.version), sha256: bytes32(policy.sha256) },
    validFrom: integer(a.validFrom, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(a.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    typeof policy.version === "string" &&
      ownerOnly(authorization.policy) &&
      authorization.validFrom < authorization.expiresAt,
    "owner_authorization_scope_mismatch",
    409,
  );
  insist(
    typeof signed.signature === "string" &&
      (a.schema === "pirate.owner-publishing-authorization/1"
        ? /^0x[0-9a-f]{130}(?![\s\S])/.test(signed.signature)
        : /^0x(?:[0-9a-fA-F]{2}){1,16384}(?![\s\S])/.test(signed.signature)),
    "invalid_owner_authorization_signature",
  );
  return { authorization, signature: signed.signature as Hex };
}

export function ownerAuthorizationTypedData(
  authorization: OwnerAuthorization,
  config: Pick<
    CommunityConfig,
    "schema" | "chainId" | "directory" | "communityId"
  >,
) {
  insist(
    authorization.schema === "pirate.owner-publishing-authorization/2" &&
      config.schema === "pirate.community-config/4" &&
      config.chainId === 6343 &&
      authorization.communityId === config.communityId,
    "owner_authorization_scope_mismatch",
    409,
  );
  return {
    domain: {
      name: "Pirate Owner Publishing Authorization",
      version: "2",
      chainId: config.chainId,
      verifyingContract: config.directory as Address,
    },
    primaryType: "OwnerPublishingAuthorization" as const,
    types: {
      OwnerPublishingAuthorization: [
        { name: "schema", type: "string" },
        { name: "communityId", type: "bytes32" },
        { name: "ownerWallet", type: "address" },
        { name: "policyVersion", type: "string" },
        { name: "policySha256", type: "bytes32" },
        { name: "validFrom", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    message: {
      schema: authorization.schema,
      communityId: authorization.communityId as Hex,
      ownerWallet: authorization.ownerWallet as Address,
      policyVersion: authorization.policy.version,
      policySha256: authorization.policy.sha256 as Hex,
      validFrom: BigInt(authorization.validFrom),
      expiresAt: BigInt(authorization.expiresAt),
    },
  };
}
