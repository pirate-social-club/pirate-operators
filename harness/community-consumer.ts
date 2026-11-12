import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cfJson, rows } from "./managed-inventory.ts";
import { insist, object } from "../packages/community/common.ts";
import { unseal } from "../apps/community-wizard/infra/protected-data.ts";
import { inventoryCommunityState } from "./community-state.ts";
import { verifyCommunityPackage } from "./community-package-custody.ts";
import type { ReviewedUpdate } from "./reviewed-update.ts";

const queueId = "fe031cd96fbb47579585eb10154f785d",
  script = "pirate-first-song-20261105";
/** Current Consumer ownership is mandatory. Missing state never permits replacement. */
export async function qualifyCommunityConsumer(
  directory: string,
  password: string,
  env: NodeJS.ProcessEnv,
  required = false,
  query = cfJson,
  custody?: { profileHash: string; policy: ReviewedUpdate },
) {
  insist(custody, "community_consumer_package_binding_required", 409);
  const location = await verifyCommunityPackage(
    directory,
    custody.profileHash,
    custody.policy,
    (cwd) => inventoryCommunityState(cwd, password),
  );
  const consumers = rows(
    await query(["queues", "consumers", "list", "--queue-id", queueId], env),
  );
  insist(consumers.length <= 1, "community_consumer_identity_ambiguous", 409);
  const relative = `${script}/setup/Consumer.json`,
    path = join(location.cwd, ".alchemy/state", relative);
  const state = object(
    JSON.parse(
      unseal(
        await readFile(path, "utf8"),
        password,
        `alchemy-state:${relative}`,
      ),
    ),
  );
  insist(
    consumers.length === 1,
    "community_consumer_missing_or_interrupted",
    409,
  );
  void required; // current-state adoption never allows a first-enable fallback
  const consumer = consumers[0]!,
    settings = object(consumer.settings),
    attr = object(
      state?.status === "updating" ? object(state.old).attr : state?.attr,
    );
  insist(
    consumer.script === script &&
      typeof consumer.consumer_id === "string" &&
      settings.batch_size === 1 &&
      settings.max_concurrency === 1 &&
      settings.max_retries === 3 &&
      settings.retry_delay === 60 &&
      state &&
      ["created", "updated", "updating"].includes(String(state.status)) &&
      state.resourceType === "Cloudflare.Queues.Consumer" &&
      state.logicalId === "Consumer" &&
      attr.queueId === queueId &&
      attr.scriptName === script &&
      attr.consumerId === consumer.consumer_id &&
      attr.accountId === "08a4c22cf52e2ecae883e36f80a33f4a",
    "community_consumer_ownership_unverified",
    409,
  );
  return { queueId, consumerId: consumer.consumer_id, scriptName: script };
}
