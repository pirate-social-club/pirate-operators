import {
  creatorAccount,
  creatorDatabase,
  creatorResources,
  fileDigest,
} from "./creator-state.ts";
import { cfJson, rows } from "./managed-inventory.ts";
import { insist, object } from "../packages/community/common.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";

export async function creatorInventory(env: NodeJS.ProcessEnv) {
  const [workers, databases] = await Promise.all([
    cfJson(["workers", "list", "--per-page", "100", "--page", "1"], env),
    cfJson(
      [
        "d1",
        "list",
        "--name",
        "pirate-creator-wallet-testnet",
        "--per-page",
        "100",
      ],
      env,
    ),
  ]);
  const scripts = rows(workers),
    dbs = rows(databases);
  insist(scripts.length < 100, "creator_inventory_pagination_required", 503);
  for (const resource of [
    creatorResources.WalletTest,
    creatorResources.CommunityTest,
  ])
    insist(
      scripts.some(
        (w) =>
          w.id === resource.identity.workerId &&
          w.name === resource.identity.workerName,
      ),
      "creator_worker_identity_changed",
      409,
    );
  insist(
    dbs.length === 1 && dbs[0]!.uuid === creatorDatabase,
    "creator_database_identity_changed",
    409,
  );
  const query = await cfJson(
    [
      "d1",
      "query",
      creatorDatabase,
      "--sql",
      "SELECT COUNT(*) AS incomplete FROM submissions WHERE status NOT IN ('confirmed','failed'); SELECT COUNT(*) AS unfinished FROM attempts WHERE status NOT IN ('active','failed'); SELECT COUNT(*) AS pending FROM signatures WHERE status NOT IN ('verified','failed'); SELECT COUNT(*) AS held FROM operator_lock",
    ],
    env,
  );
  insist(
    Array.isArray(query) &&
      query.length === 4 &&
      query.every((q) => {
        const r = object(q);
        return (
          r.success === true &&
          Array.isArray(r.results) &&
          r.results.length === 1 &&
          Object.values(object(r.results[0])).every((n) => n === 0)
        );
      }),
    "creator_native_operations_not_quiescent",
    409,
  );
  return {
    at: new Date().toISOString(),
    database: creatorDatabase,
    workers: [
      creatorResources.WalletTest.identity,
      creatorResources.CommunityTest.identity,
    ],
    quiescent: true,
  };
}

/** The official script-download API returns original module content. Keep it
 * in memory and record only module digests; no runtime binding value is read. */
export async function creatorRemoteModules(token: string, name: string) {
  insist(
    ["pirate-wallet-test", "pirate-creator-spike"].includes(name),
    "unowned_creator_worker",
  );
  return fetchWorkerModuleDigests(token, creatorAccount, name, [
    "index.js",
    "ika.wasm",
  ]);
}
