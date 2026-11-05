import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { cfJson, rows } from "./managed-inventory.ts";
import { insist, object } from "../packages/community/common.ts";
import { unseal } from "../apps/community-wizard/infra/protected-data.ts";

const queueId = "fe031cd96fbb47579585eb10154f785d",
  script = "pirate-first-song-20261105";
/** A first enablement may create only this consumer on this existing Queue.
 * A retry must authenticate its retained encrypted ownership before any apply. */
export async function qualifyCommunityConsumer(
  directory: string,
  password: string,
  env: NodeJS.ProcessEnv,
  required = false,
  query = cfJson,
) {
  const consumers = rows(
    await query(["queues", "consumers", "list", "--queue-id", queueId], env),
  );
  insist(consumers.length <= 1, "community_consumer_identity_ambiguous", 409);
  const relative = `${script}/setup/Consumer.json`,
    path = join(directory, "deployment/.alchemy/state", relative);
  let state: Record<string, unknown> | null = null;
  try {
    const metadata = await lstat(path);
    insist(
      metadata.isFile() &&
        metadata.uid === process.getuid!() &&
        !(metadata.mode & 0o077),
      "community_consumer_state_not_private",
      409,
    );
    state = object(
      JSON.parse(
        unseal(
          await readFile(path, "utf8"),
          password,
          `alchemy-state:${relative}`,
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!consumers.length) {
    insist(
      !required && !state,
      "community_consumer_missing_or_interrupted",
      409,
    );
    return null;
  }
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
