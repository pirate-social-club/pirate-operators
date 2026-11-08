import { recoverMessageAddress } from "viem";
import { bytes32, exact, hashJson, insist, integer, object } from "./common.ts";
import { address } from "./manifest-core.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import { unregisteredOwner } from "./owner-policy.ts";

/**
 * Controller-signed authority for owner-only publishing under the unregistered
 * owner policy. One authorization covers a bounded window; it is not per song.
 * The controller, the publisher and the owner wallet are distinct roles.
 */
export interface OwnerAuthorization {
  schema: "pirate.owner-publishing-authorization/1";
  communityId: string;
  ownerWallet: string;
  policy: { version: string; sha256: string };
  validFrom: number;
  expiresAt: number;
}
export interface SignedOwnerAuthorization {
  authorization: OwnerAuthorization;
  signature: `0x${string}`;
}

export async function validateOwnerAuthorization(
  value: unknown,
  config: CommunityConfig,
): Promise<SignedOwnerAuthorization> {
  const signed = object(value);
  exact(signed, ["authorization", "signature"]);
  const a = object(signed.authorization);
  exact(a, [
    "schema",
    "communityId",
    "ownerWallet",
    "policy",
    "validFrom",
    "expiresAt",
  ]);
  const policy = object(a.policy);
  exact(policy, ["version", "sha256"]);
  const authorization: OwnerAuthorization = {
    schema: "pirate.owner-publishing-authorization/1",
    communityId: bytes32(a.communityId),
    ownerWallet: address(a.ownerWallet),
    policy: { version: String(policy.version), sha256: bytes32(policy.sha256) },
    validFrom: integer(a.validFrom, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(a.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    a.schema === authorization.schema &&
      authorization.communityId === config.communityId &&
      authorization.validFrom < authorization.expiresAt &&
      unregisteredOwner(authorization.policy) &&
      authorization.policy.version === config.policies.admission.version &&
      authorization.policy.sha256 === config.policies.admission.sha256,
    "owner_authorization_scope_mismatch",
    409,
  );
  insist(
    typeof signed.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(signed.signature),
    "invalid_owner_authorization_signature",
  );
  const signer = await recoverMessageAddress({
    message: { raw: hashJson(authorization) },
    signature: signed.signature as `0x${string}`,
  });
  insist(
    signer.toLowerCase() === config.controller,
    "untrusted_owner_authorization_signer",
    403,
  );
  return { authorization, signature: signed.signature as `0x${string}` };
}

/** Refuses anyone but the authorized owner wallet, inside the signed window. */
export async function requireAuthorizedOwner(
  value: unknown,
  config: CommunityConfig,
  wallet: string,
  now = Math.floor(Date.now() / 1000),
) {
  const { authorization } = await validateOwnerAuthorization(value, config);
  insist(
    now >= authorization.validFrom && now < authorization.expiresAt,
    "owner_authorization_outside_window",
    403,
  );
  insist(
    wallet.toLowerCase() === authorization.ownerWallet,
    "owner_publication_only",
    403,
  );
  return authorization;
}
