import type { PublicClient } from "viem";
import { verifyAccountTypedData } from "./account-signature-verifier.ts";
import { canonical, CommunityError, insist } from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import {
  ownerAuthorizationTypedData,
  type SignedOwnerAuthorization,
} from "./owner-authorization-typed-data.ts";

export interface OwnerVerification {
  client: PublicClient;
  currentConfiguration(): Promise<CommunityConfig>;
  now(): number;
  maxSafeBlockAgeSeconds: bigint;
}
/** Trusted caller selects the client and current authority. Provider exceptions
 * remain unavailable. Wrapped/account verification never uses address recovery. */
export async function verifyOwnerTypedAuthorization(
  record: SignedOwnerAuthorization,
  config: CommunityConfig,
  verification?: OwnerVerification,
) {
  insist(verification, "owner_authorization_verification_unavailable", 503);
  const v = verification;
  try {
    insist(
      (await v.client.getChainId()) === config.chainId,
      "owner_authorization_verification_unavailable",
      503,
    );
    const safe = await v.client.getBlock({ blockTag: "safe" });
    const maximumAge = v.maxSafeBlockAgeSeconds;
    // The last valid sampled second includes the maximum age itself.
    const staleAt = safe.timestamp + maximumAge + 1n;
    function fresh() {
      const now = v.now();
      insist(
        Number.isSafeInteger(now) &&
          maximumAge >= 0n &&
          safe.timestamp <= BigInt(now) &&
          BigInt(now) < staleAt,
        "owner_authorization_safe_view_unavailable",
        503,
      );
    }
    insist(
      safe.number !== null && safe.hash !== null,
      "owner_authorization_safe_view_unavailable",
      503,
    );
    fresh();
    const valid = await verifyAccountTypedData(v.client,{
      data:ownerAuthorizationTypedData(record.authorization, config),
      address: config.controller as `0x${string}`,
      signature: record.signature,
      blockNumber: safe.number,
    });
    insist(
      (await v.client.getBlock({ blockNumber: safe.number })).hash ===
        safe.hash,
      "owner_authorization_chain_reorganized",
      503,
    );
    insist(
      canonical(await v.currentConfiguration()) === canonical(config),
      "owner_authorization_authority_changed",
      403,
    );
    fresh();
    insist(valid, "untrusted_owner_authorization_signer", 403);
    // Cryptographic/current identity verification is also required when
    // authenticating an immutable original after its paid window has closed.
    // NEW effects separately call requireAuthorizedOwner after their awaits.
    const safeAnchorExpiresAtMs = Number(staleAt * 1000n);
    insist(Number.isSafeInteger(safeAnchorExpiresAtMs), "owner_authorization_safe_view_unavailable", 503);
    return safeAnchorExpiresAtMs;
  } catch (error) {
    if (error instanceof CommunityError) throw error;
    throw new CommunityError(
      "owner_authorization_verification_unavailable",
      503,
    );
  }
}
