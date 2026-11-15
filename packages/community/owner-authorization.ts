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
    await verifyOwnerTypedAuthorization(record, config, verification);
    return record;
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
  return record;
}

/** Current controller signature, scope and owner identity. This grants no new
 * paid effect and never changes the original signed window. */
export async function requireOwnerIdentity(value:unknown,config:CommunityConfig,wallet:string,verification?:OwnerVerification) {
  const {authorization}=await validateOwnerAuthorization(value,config,verification);
  insist(wallet.toLowerCase()===authorization.ownerWallet,"owner_publication_only",403);
  return authorization;
}

/** NEW-effect eligibility, sampled after cryptographic/current-chain awaits. */
export async function requireAuthorizedOwner(value:unknown,config:CommunityConfig,wallet:string,now?:number,verification?:OwnerVerification) {
  const authorization=await requireOwnerIdentity(value,config,wallet,verification);
  now=verification?.now() ?? now ?? Math.floor(Date.now()/1000);
  insist(now>=authorization.validFrom&&now<authorization.expiresAt,"owner_authorization_outside_window",403);
  return authorization;
}
