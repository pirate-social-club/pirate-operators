import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "../apps/community-wizard/infra/protected-data.ts";
import { qualifyCommunityConsumer } from "../harness/community-consumer.ts";

test("consumer enablement accepts absence only once and authenticates the exact encrypted retry owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirate-consumer-")),
    password = "fixture-protection-credential-at-least32",
    queueId = "fe031cd96fbb47579585eb10154f785d",
    script = "pirate-first-song-20261105",
    consumerId = "fixture-consumer",
    relative = `${script}/setup/Consumer.json`;
  let consumers: Record<string, unknown>[] = [];
  const query = async (args: string[]) => {
    assert.deepEqual(args, [
      "queues",
      "consumers",
      "list",
      "--queue-id",
      queueId,
    ]);
    return consumers;
  };
  try {
    assert.equal(
      await qualifyCommunityConsumer(directory, password, {}, false, query),
      null,
    );
    await assert.rejects(
      qualifyCommunityConsumer(directory, password, {}, true, query),
    );
    consumers = [
      {
        consumer_id: consumerId,
        script,
        settings: {
          batch_size: 1,
          max_concurrency: 1,
          max_retries: 3,
          retry_delay: 60,
        },
      },
    ];
    await assert.rejects(
      qualifyCommunityConsumer(directory, password, {}, false, query),
    );
    const path = join(directory, "deployment/.alchemy/state", relative);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const record = {
      status: "created",
      resourceType: "Cloudflare.Queues.Consumer",
      logicalId: "Consumer",
      attr: {
        accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
        queueId,
        scriptName: script,
        consumerId,
      },
    };
    const save = async (value: unknown) =>
      writeFile(
        path,
        seal(JSON.stringify(value), password, `alchemy-state:${relative}`),
        { mode: 0o600 },
      );
    await save(record);
    assert.deepEqual(
      await qualifyCommunityConsumer(directory, password, {}, true, query),
      { queueId, consumerId, scriptName: script },
    );
    consumers[0]!.script = "unrelated-worker";
    await assert.rejects(
      qualifyCommunityConsumer(directory, password, {}, true, query),
      /ownership_unverified/,
    );
    consumers[0]!.script = script;
    await save({
      ...record,
      attr: { ...record.attr, queueId: "unrelated-queue" },
    });
    await assert.rejects(
      qualifyCommunityConsumer(directory, password, {}, true, query),
      /ownership_unverified/,
    );
    await save(record);
    consumers.push(consumers[0]!);
    await assert.rejects(
      qualifyCommunityConsumer(directory, password, {}, true, query),
      /ambiguous/,
    );
    consumers = [];
    await assert.rejects(
      qualifyCommunityConsumer(directory, password, {}, false, query),
      /missing_or_interrupted/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
