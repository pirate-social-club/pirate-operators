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
import {
  configureBudget,
  reserveBudget,
  type BudgetKey,
} from "../community/budgets.ts";
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

/**
 * Claims the owner window atomically in this service's database. One
 * conditional upsert either creates the scope's window, keeps the identical
 * window, or advances to a later non-overlapping one. Two concurrent
 * overlapping grants cannot both be admitted, and a superseded window can no
 * longer open new spending. Each paying service calls this on its own database.
 */
export async function claimOwnerWindow(
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
  await db
    .prepare(
      `INSERT INTO owner_budget_windows(scope,valid_from,expires_at) VALUES(?,?,?)
      ON CONFLICT(scope) DO UPDATE SET valid_from=excluded.valid_from,expires_at=excluded.expires_at
      WHERE owner_budget_windows.expires_at <= excluded.valid_from`,
    )
    .bind(key.scope, grant.validFrom, grant.expiresAt)
    .run();
  const row = await db
    .prepare(
      "SELECT valid_from,expires_at FROM owner_budget_windows WHERE scope=?",
    )
    .bind(key.scope)
    .first<{ valid_from: number; expires_at: number }>();
  insist(row, "owner_budget_window_unavailable", 503);
  insist(
    row.valid_from === grant.validFrom && row.expires_at === grant.expiresAt,
    row.valid_from >= grant.expiresAt
      ? "owner_budget_window_superseded"
      : "owner_budget_window_overlap",
    409,
  );
  return key;
}

/**
 * New spending under an owner grant. The window must be inside its signed
 * time range and still be the scope's current window when the reservation
 * commits; an earlier successful claim alone does not authorize it. Replays of
 * an existing reservation return without re-checking, and settlement uses
 * settleBudget with ownerBudgetKey directly, so superseded or expired windows
 * stay readable and settleable.
 */
export async function reserveOwnerBudget(
  db: D1Database,
  grant: OwnerBudgetGrant,
  asset: OwnerBudgetAsset,
  reservationId: string,
  requestHash: string,
  requested: string,
  now = Math.floor(Date.now() / 1000),
) {
  const key = ownerBudgetKey(grant, asset);
  insist(
    now >= grant.validFrom && now < grant.expiresAt,
    "owner_grant_outside_window",
    403,
  );
  await configureBudget(db, key, ownerBudgetCeiling(grant, asset));
  await reserveBudget(db, reservationId, requestHash, [key], requested, {
    clause:
      "EXISTS(SELECT 1 FROM owner_budget_windows WHERE scope=? AND valid_from=? AND expires_at=?)",
    binds: [key.scope, grant.validFrom, grant.expiresAt],
    code: "owner_budget_window_not_current",
  });
  return key;
}
