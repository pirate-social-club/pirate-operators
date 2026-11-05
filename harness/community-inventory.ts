import { managedInventory, cfJson } from "./managed-inventory.ts";
import {
  communityAccount,
  communityPrefix,
  communityOwned,
} from "./community-package.ts";
import { insist, object } from "../packages/community/common.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";
export async function communityInventory(cloudEnv: NodeJS.ProcessEnv) {
  const value = await managedInventory(cloudEnv, communityPrefix);
  insist(
    value.resources.length === 4 &&
      value.resources.every(
        (r, i) => r.present && r.id === communityOwned[i]!.id,
      ),
    "community_resource_identity_changed",
    409,
  );
  return value;
}

export async function communityRemoteModules(token: string) {
  return fetchWorkerModuleDigests(token, communityAccount, communityPrefix, [
    "worker.mjs",
  ]);
}

export async function requireIdleCommunity(cloudEnv: NodeJS.ProcessEnv) {
  const idle = await cfJson(
    [
      "d1",
      "query",
      communityOwned[1].id,
      "--sql",
      "SELECT (SELECT COUNT(*) FROM community_accounts) AS accounts,(SELECT COUNT(*) FROM creator_connections) AS connections,(SELECT COUNT(*) FROM media_submissions) AS submissions,(SELECT COUNT(*) FROM publication_jobs) AS jobs,(SELECT COUNT(*) FROM external_operations) AS operations",
    ],
    cloudEnv,
  );
  insist(
    Array.isArray(idle) &&
      idle.length === 1 &&
      object(idle[0]).success === true &&
      Array.isArray(object(idle[0]).results) &&
      (object(idle[0]).results as unknown[]).length === 1 &&
      Object.values(object((object(idle[0]).results as unknown[])[0])).every(
        (v) => v === 0,
      ),
    "community_transport_repair_requires_idle_application",
    409,
  );
}
