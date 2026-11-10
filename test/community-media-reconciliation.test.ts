import test from "node:test";
import assert from "node:assert/strict";
import { fixture, actor } from "./community-media-fixture.ts";
import { sha256 } from "../packages/community-media/validation.ts";

test("lost queued commit response reconciles sealed source without deleting it", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  const save = f.repository.save.bind(f.repository);
  let lost = false;
  f.repository.save = async (before, changes) => {
    const result = await save(before, changes);
    if (changes.state === "queued" && !lost) {
      lost = true;
      throw Error("lost D1 response");
    }
    return result;
  };
  assert.equal(
    (await f.service.upload(item.id, actor, f.source)).state,
    "queued",
  );
  const record = await f.repository.get(item.id),
    object = await f.media.get(record.sourceKey!);
  assert.ok(object);
  assert.equal(
    await sha256(new Uint8Array(await object.arrayBuffer())),
    f.hash,
  );
  assert.equal(
    (await f.service.upload(item.id, actor, f.source)).state,
    "queued",
  );
  await f.service.process(item.id);
  assert.equal((await f.repository.get(item.id)).state, "ready");
});

test("lost ready commit response reconciles rendition and replay keeps playback", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  await f.service.upload(item.id, actor, f.source);
  const save = f.repository.save.bind(f.repository);
  f.repository.save = async (before, changes) => {
    const result = await save(before, changes);
    if (changes.state === "ready") throw Error("lost D1 ready response");
    return result;
  };
  await f.service.process(item.id);
  await f.service.process(item.id);
  const record = await f.repository.get(item.id);
  assert.ok(await f.media.head(record.renditionKey!));
  assert.equal(
    (await f.http(`/api/media/${item.id}/playback`, actor))?.status,
    200,
  );
});

for (const kind of ["source", "rendition"] as const)
  test(`unknown ${kind} commit preserves bytes while canonical read is unavailable`, async (t) => {
    const f = await fixture(t),
      item = await f.reserve();
    if (kind === "rendition") await f.service.upload(item.id, actor, f.source);
    const save = f.repository.save.bind(f.repository),
      get = f.repository.get.bind(f.repository);
    let unreadable = false;
    f.repository.save = async (before, changes) => {
      const result = await save(before, changes);
      if (changes.state === (kind === "source" ? "queued" : "ready")) {
        unreadable = true;
        throw Error("unknown commit response");
      }
      return result;
    };
    f.repository.get = async (id) => {
      if (unreadable) throw Error("canonical read unavailable");
      return get(id);
    };
    await assert.rejects(
      kind === "source"
        ? f.service.upload(item.id, actor, f.source)
        : f.service.process(item.id),
      /canonical read unavailable/,
    );
    const record = await get(item.id);
    assert.ok(
      await f.media.head(
        kind === "source" ? record.sourceKey! : record.renditionKey!,
      ),
    );
    unreadable = false;
    if (kind === "source")
      assert.equal(
        (await f.service.upload(item.id, actor, f.source)).state,
        "queued",
      );
    else
      assert.equal(
        (await f.http(`/api/media/${item.id}/playback`, actor))?.status,
        200,
      );
  });

test("an uncertain fencing write cannot justify artifact cleanup", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  await f.service.upload(item.id, actor, f.source);
  const save = f.repository.save.bind(f.repository);
  f.repository.save = async (before, changes) => {
    if (changes.state === "ready" || changes.state === "failed")
      throw Error("outcome unknown");
    return save(before, changes);
  };
  await assert.rejects(
    f.service.process(item.id),
    /media_commit_outcome_unknown/,
  );
  assert.equal((await f.repository.get(item.id)).state, "processing");
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(item.id) })).objects.length,
    2,
  );
});

test("late-object deletion failure restores persisted pending erasure and quota", async (t) => {
  const f = await fixture(t),
    record = await f.ready();
  await f.service.withdraw(record.id, actor);
  assert.equal((await f.repository.get(record.id)).erasePending, false);
  await f.media.put(`${f.service.prefix(record.id)}late.mp4`, f.source);
  f.ports.quota.perAccount = 1;
  const bucket = f.ports.bucket;
  f.ports.bucket = new Proxy(bucket, {
    get(target, key) {
      if (key === "delete")
        return async () => {
          throw Error("late deletion failed");
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await f.service.recover();
  assert.equal((await f.repository.get(record.id)).erasePending, true);
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(record.id) })).objects
      .length,
    1,
  );
  await assert.rejects(
    f.reserve({ requestId: "new_request_0002" }),
    /media_capacity_full/,
  );
  f.ports.bucket = bucket;
  await f.service.recover();
  assert.equal((await f.repository.get(record.id)).erasePending, false);
  assert.equal(
    (await f.reserve({ requestId: "new_request_0002" })).state,
    "uploading",
  );
});
