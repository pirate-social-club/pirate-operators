// Pure migration selection for deployment packages. Kept free of package
// build imports so tests can load it directly.
import { insist } from "../packages/community/common.ts";

export const COMMUNITY_MEDIA_MIGRATION = "0015_community_media.sql";
export const DANCE_MIGRATION = "0016_dance.sql";
export const DANCE_CANONICAL_MIGRATION = "0017_dance_canonical_controls.sql";
export const LEARNING_AUTHORITY_MIGRATION = "0018_learning_authority.sql";
export const REWARD_CLOSURE_MIGRATION = "0014_reward_closure_snapshots.sql";
export const OWNER_PUBLISHING_MIGRATION = "0012_owner_budget_windows.sql";
export const LEARNING_AUTHORIZATION_MIGRATION =
  "0013_learning_authorization.sql";
/**
 * Migrations a community package applies. Rewards, owner publishing and the
 * V4 sign-in authorization are opt-in, in that deployed order: V4 appends
 * after 0012, so it requires owner publishing, which requires rewards.
 */
export function communityMigrations(
  names: string[],
  selected: {
    rewards: boolean;
    ownerPublishing: boolean;
    v4: boolean;
    rewardClosure?: boolean;
    media?: boolean;
    dance?: boolean;
  },
) {
  insist(
    !selected.ownerPublishing || selected.rewards,
    "owner_publishing_rewards_selection_required",
    409,
  );
  insist(
    !selected.v4 || selected.ownerPublishing,
    "learning_v4_publishing_selection_required",
    409,
  );
  insist(
    !selected.rewardClosure || selected.v4,
    "reward_closure_v4_selection_required",
    409,
  );
  insist(
    !selected.media || selected.v4,
    "community_media_v4_selection_required",
    409,
  );
  insist(
    !selected.dance || (selected.media && selected.rewardClosure),
    "dance_media_reward_selection_required",
    409,
  );
  return names
    .filter((p) => /^\d{4}_.+\.sql$/.test(p))
    .filter((p) => p !== "0011_manual_rewards.sql" || selected.rewards)
    .filter((p) => p !== OWNER_PUBLISHING_MIGRATION || selected.ownerPublishing)
    .filter((p) => p !== LEARNING_AUTHORIZATION_MIGRATION || selected.v4)
    .filter((p) => p !== REWARD_CLOSURE_MIGRATION || selected.rewardClosure)
    .filter((p) => p !== COMMUNITY_MEDIA_MIGRATION || selected.media)
    .filter((p) => p !== DANCE_MIGRATION || selected.dance)
    .filter((p) => p !== DANCE_CANONICAL_MIGRATION || selected.dance)
    .filter((p) => p !== LEARNING_AUTHORITY_MIGRATION || selected.v4)
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
