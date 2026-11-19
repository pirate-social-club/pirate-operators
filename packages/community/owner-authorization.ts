import { recoverMessageAddress } from "viem";
import { hashJson, insist } from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";

import {
  ownerAuthorizationRecord,
  type SignedOwnerAuthorization,
} from "./owner-authorization-typed-data.ts";
import {
  verifyOwnerTypedAuthorization,
  type OwnerVerification,
} from "./owner-authorization-verifier.ts";
export type {
  OwnerAuthorization,
  SignedOwnerAuthorization,
} from "./owner-authorization-typed-data.ts";

export async function validateOwnerAuthorization(
  value: unknown,
  config: CommunityConfig,
  verification?: OwnerVerification,
): Promise<SignedOwnerAuthorization> {
  return (await verifiedOwnerAuthorization(value, config, verification)).record;
}

async function verifiedOwnerAuthorization(
  value: unknown,
  config: CommunityConfig,
  verification?: OwnerVerification,
) {
  const record = ownerAuthorizationRecord(value),
    { authorization } = record;
  insist(
    authorization.communityId === config.communityId &&
      authorization.policy.version === config.policies.admission.version &&
      authorization.policy.sha256 === config.policies.admission.sha256,
    "owner_authorization_scope_mismatch",
    409,
  );
  if (authorization.schema === "pirate.owner-publishing-authorization/2") {
    const safeAnchorExpiresAtMs = await verifyOwnerTypedAuthorization(record, config, verification);
    return { record, safeAnchorExpiresAtMs };
  }
  const signer = await recoverMessageAddress({
    message: { raw: hashJson(authorization) },
    signature: record.signature,
  });
  insist(
    signer.toLowerCase() === config.controller,
    "untrusted_owner_authorization_signer",
    403,
  );
  return { record, safeAnchorExpiresAtMs: undefined };
}

async function verifiedOwnerIdentity(value: unknown, config: CommunityConfig, wallet: string, verification?: OwnerVerification) {
  const { record: { authorization }, safeAnchorExpiresAtMs } = await verifiedOwnerAuthorization(value, config, verification);
  insist(wallet.toLowerCase() === authorization.ownerWallet, "owner_publication_only", 403);
  return { authorization, safeAnchorExpiresAtMs };
}

/** Current controller signature, scope and owner identity. This grants no new
 * paid effect and never changes the original signed window. */
export async function requireOwnerIdentity(value:unknown,config:CommunityConfig,wallet:string,verification?:OwnerVerification) {
  return (await verifiedOwnerIdentity(value, config, wallet, verification)).authorization;
}

/** NEW-effect eligibility, sampled after cryptographic/current-chain awaits. */
export async function requireAuthorizedOwner(value:unknown,config:CommunityConfig,wallet:string,now?:number,verification?:OwnerVerification) {
  return (await requireAuthorizedOwnerWithFreshness(value, config, wallet, now, verification)).authorization;
}

/** The deadline is from the same verified safe view as the owner signature. */
export async function requireAuthorizedOwnerWithFreshness(
  value: unknown,
  config: CommunityConfig,
  wallet: string,
  now?: number,
  verification?: OwnerVerification,
) {
  const identity = await verifiedOwnerIdentity(value, config, wallet, verification);
  const { authorization } = identity;
  const current = verification?.now() ?? now ?? Math.floor(Date.now() / 1000);
  insist(current >= authorization.validFrom && current < authorization.expiresAt, "owner_authorization_outside_window", 403);
  return identity;
}
