// Pure migration selection for deployment packages. Kept free of package
// build imports so tests can load it directly.
import { insist } from "../packages/community/common.ts";

export const OWNER_PUBLISHING_MIGRATION = "0012_owner_budget_windows.sql";
/** Migrations a community package applies; rewards and publishing are opt-in, in order. */
export function communityMigrations(
  names: string[],
  selected: { rewards: boolean; ownerPublishing: boolean },
) {
  insist(
    !selected.ownerPublishing || selected.rewards,
    "owner_publishing_rewards_selection_required",
    409,
  );
  return names
    .filter((p) => /^\d{4}_.+\.sql$/.test(p))
    .filter((p) => p !== "0011_manual_rewards.sql" || selected.rewards)
    .filter((p) => p !== OWNER_PUBLISHING_MIGRATION || selected.ownerPublishing)
    .sort();
}
export const MANAGED_MIGRATIONS = [
  "0001_managed.sql",
  "0002_release_operations.sql",
  "0003_owner_curated.sql",
] as const;
export const MANAGED_OWNER_PUBLISHING_MIGRATION =
  "0004_owner_budget_windows.sql";
export const managedMigrations = (ownerPublishing: boolean) => [
  ...MANAGED_MIGRATIONS,
  ...(ownerPublishing ? [MANAGED_OWNER_PUBLISHING_MIGRATION] : []),
];
