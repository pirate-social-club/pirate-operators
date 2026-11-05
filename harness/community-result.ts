import { join } from "node:path";
import { insist, object } from "../packages/community/common.ts";
import { communityOwned } from "./community-package.ts";
import { privateJson } from "./community-state.ts";
import type { managedInventory } from "./managed-inventory.ts";

/** Read-only reconciliation of an already completed release. Never reapplies
 * Alchemy merely because its final console response was lost. */
export async function completedCommunityRelease(
  directory: string,
  profile: { planId: string; bundleSha256: string },
  profileHash: string,
  live: {
    inventory: Awaited<ReturnType<typeof managedInventory>>;
    modules: Record<string, string>;
    health: Record<string, unknown>;
  },
) {
  const result = await privateJson(join(directory, "deployment-result.json"));
  if (!result) return null;
  const savedHealth = object(result.health),
    savedAfter = object(result.after);
  insist(
    result.schema === "pirate.community-application-release/1" &&
      result.profileHash === profileHash &&
      savedHealth.profileHash === profileHash &&
      savedHealth.planId === profile.planId &&
      Array.isArray(savedAfter.resources) &&
      savedAfter.resources.length === communityOwned.length &&
      savedAfter.resources.every((raw, i) => {
        const r = object(raw);
        return r.present === true && r.id === communityOwned[i]!.id;
      }),
    "community_completed_result_conflict",
    409,
  );
  insist(
    Object.keys(live.modules).length === 1 &&
      Object.values(live.modules)[0] === profile.bundleSha256 &&
      live.health.profileHash === profileHash &&
      live.health.planId === profile.planId &&
      live.health.signIn === "available" &&
      live.health.creatorConnection === "available" &&
      live.inventory.resources.length === communityOwned.length &&
      live.inventory.resources.every(
        (r, i) => r.present && r.id === communityOwned[i]!.id,
      ),
    "community_completed_release_not_live",
    503,
  );
  return result;
}
