import {
  amount,
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
} from "../community/common.ts";
import { address, chain, httpsOrigin } from "../community/manifest-core.ts";
import type { BudgetKey } from "../community/budgets.ts";
import { unregisteredOwner } from "../community/owner-policy.ts";

/**
 * Bounded owner budget for the unregistered owner policy. Reviewed operator
 * configuration of the paying service; a request body never selects it.
 * There is no registration section: the policy has no registration operation.
 */
export interface OwnerBudgetGrant {
  schema: "pirate.owner-publishing-grant/1";
  sha256: string;
  communityId: string;
  communityOrigin: string;
  ownerWallet: string;
  policy: { version: string; sha256: string };
  destination: { chainId: number; postsContract: string; publisher: string };
  validFrom: number;
  expiresAt: number;
  limits: {
    songs: number;
    pinAdds: number;
    pinBytes: string;
    recognitionRequests: number;
    postFeeWei: string;
  };
}
export type OwnerBudgetAsset =
  | "songs"
  | "pin_adds"
  | "pin_bytes"
  | "recognition_requests"
  | "post_fee_wei";

export const ownerGrantDigest = (grant: OwnerBudgetGrant) => {
  const { sha256, ...scope } = grant;
  return hashJson(scope);
};

export function validateOwnerGrant(input: unknown): OwnerBudgetGrant {
  const g = object(input);
  exact(g, [
    "schema",
    "sha256",
    "communityId",
    "communityOrigin",
    "ownerWallet",
    "policy",
    "destination",
    "validFrom",
    "expiresAt",
    "limits",
  ]);
  const policy = object(g.policy),
    destination = object(g.destination),
    limits = object(g.limits);
  exact(policy, ["version", "sha256"]);
  exact(destination, ["chainId", "postsContract", "publisher"]);
  exact(limits, [
    "songs",
    "pinAdds",
    "pinBytes",
    "recognitionRequests",
    "postFeeWei",
  ]);
  const grant: OwnerBudgetGrant = {
    schema: "pirate.owner-publishing-grant/1",
    sha256: bytes32(g.sha256),
    communityId: bytes32(g.communityId),
    communityOrigin: httpsOrigin(g.communityOrigin),
    ownerWallet: address(g.ownerWallet),
    policy: { version: String(policy.version), sha256: bytes32(policy.sha256) },
    destination: {
      chainId: chain(destination.chainId),
      postsContract: address(destination.postsContract),
      publisher: address(destination.publisher),
    },
    validFrom: integer(g.validFrom, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(g.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    limits: {
      songs: integer(limits.songs, 1, 100),
      pinAdds: integer(limits.pinAdds, 1, 1000),
      pinBytes: amount(limits.pinBytes).toString(),
      recognitionRequests: integer(limits.recognitionRequests, 1, 1000),
      postFeeWei: amount(limits.postFeeWei).toString(),
    },
  };
  insist(
    g.schema === grant.schema &&
      unregisteredOwner(grant.policy) &&
      grant.validFrom < grant.expiresAt &&
      grant.sha256 === ownerGrantDigest(grant),
    "owner_grant_binding_invalid",
    503,
  );
  // Test-network ceilings. Live values belong in the reviewed execution profile.
  insist(
    amount(grant.limits.pinBytes) > 0n &&
      amount(grant.limits.pinBytes) <= 10n * 1024n ** 3n &&
      amount(grant.limits.postFeeWei) > 0n &&
      amount(grant.limits.postFeeWei) <= 100000000000000000n,
    "owner_grant_exceeds_test_bounds",
    503,
  );
  return grant;
}

/**
 * Consumption is keyed by owner, community and policy plus the signed window,
 * never by grant hash or configuration revision. Replacing the grant or
 * publishing a new configuration inside the window reuses the same buckets.
 */
export const ownerBudgetKey = (
  grant: OwnerBudgetGrant,
  asset: OwnerBudgetAsset,
): BudgetKey => ({
  scope: `owner:${grant.communityId}:${grant.ownerWallet}:${grant.policy.version}`,
  period: `${grant.validFrom}-${grant.expiresAt}`,
  asset,
});
export const ownerBudgetCeiling = (
  grant: OwnerBudgetGrant,
  asset: OwnerBudgetAsset,
) =>
  ({
    songs: String(grant.limits.songs),
    pin_adds: String(grant.limits.pinAdds),
    pin_bytes: grant.limits.pinBytes,
    recognition_requests: String(grant.limits.recognitionRequests),
    post_fee_wei: grant.limits.postFeeWei,
  })[asset];

/** A new window for the same owner scope cannot overlap one already in use. */
export async function requireOwnerWindow(
  db: D1Database,
  grant: OwnerBudgetGrant,
  now = Math.floor(Date.now() / 1000),
) {
  insist(
    now >= grant.validFrom && now < grant.expiresAt,
    "owner_grant_outside_window",
    403,
  );
  const key = ownerBudgetKey(grant, "songs");
  const rows = await db
    .prepare("SELECT DISTINCT period FROM spending_budgets WHERE scope=?")
    .bind(key.scope)
    .all<{ period: string }>();
  for (const { period } of rows.results) {
    if (period === key.period) continue;
    const match = /^(\d+)-(\d+)$/.exec(period);
    insist(match, "owner_budget_window_unreadable", 503);
    const from = Number(match[1]),
      until = Number(match[2]);
    insist(
      until <= grant.validFrom || from >= grant.expiresAt,
      "owner_budget_window_overlap",
      409,
    );
  }
  return key;
}
