// UNRUN. Real protocol controller and immutable observer-binding adapter;
// explicit simulated HTTP/memory. No runtime/device/provider/Worker gate.
import test from "node:test";
import assert from "node:assert/strict";
import { shellFixture, shellMemory } from "./media-community-shell-fixture.ts";
import { captureCommunityOwner } from "../src/media/community-contracts.ts";
import { communityHttp } from "../src/media/community-http.ts";
import { CommunitySongController } from "../src/media/community-song-controller.ts";
import { bindCommunitySongJob } from "../src/media/community-job-binding.ts";

test(
  "bound observer reads the actual accepted job and never follows a later mutable draft",
  { timeout: 4000 },
  async () => {
    const f = shellFixture(),
      m = shellMemory(),
      owner = captureCommunityOwner(() => f.context),
      http = communityHttp(owner, f.transport);
    const controller = new CommunitySongController({
      owner,
      store: m.store,
      http,
    });
    await controller.prepare(f.input);
    await controller.publish();
    const original = m.value()!;
    const bound = bindCommunitySongJob({
      owner,
      storage: m.store,
      http,
      draft: original,
      onChange() {},
    });
    assert.equal((await bound.source.refresh())?.status, "processing");
    f.phase("published");
    assert.equal((await bound.source.refresh())?.status, "published");
    assert.equal(bound.binding.requestId, original.requestId);
    assert.equal(bound.binding.bodyDigest, original.bodyDigest);
    await controller.close();
    const next = {
      ...original,
      requestId: crypto.randomUUID(),
      submissionId: crypto.randomUUID(),
      jobId: "different-job",
    };
    m.replace(next);
    const before = f.calls.length;
    await assert.rejects(bound.source.refresh(), /no longer owns/);
    await assert.rejects(bound.source.retry(), /no longer owns/);
    assert.equal(f.calls.length, before);
    assert.equal(m.value(), next);
    owner.dispose();
  },
);

test(
  "overlapping poll/native resume serialize the same job after ignored read abort",
  { timeout: 4000 },
  async () => {
    const f = shellFixture(),
      m = shellMemory(),
      owner = captureCommunityOwner(() => f.context),
      http = communityHttp(owner, f.transport);
    const controller = new CommunitySongController({
      owner,
      store: m.store,
      http,
    });
    await controller.prepare(f.input);
    await controller.publish();
    f.phase("uncertain");
    const bound = bindCommunitySongJob({
        owner,
        storage: m.store,
        http,
        draft: m.value()!,
        onChange() {},
      }),
      gate = f.delay("job-body");
    const read = bound.source.refresh();
    try {
      await gate.entered.promise;
      const retry = bound.source.retry();
      gate.release.resolve();
      assert.equal((await read)?.status, "reconciling");
      assert.equal((await retry).status, "processing");
      assert.equal(
        f.calls.filter((call) => call.path.endsWith("/resume")).length,
        1,
      );
      assert.equal(m.value()?.jobId, f.jobId);
    } finally {
      gate.release.resolve();
      owner.dispose();
    }
  },
);

test(
  "authority loss during a delayed poll preserves its canonical receipt and fences a queued retry",
  { timeout: 4000 },
  async () => {
    const f = shellFixture(),
      m = shellMemory(),
      owner = captureCommunityOwner(() => f.context),
      http = communityHttp(owner, f.transport);
    const controller = new CommunitySongController({
      owner,
      store: m.store,
      http,
    });
    await controller.prepare(f.input);
    await controller.publish();
    f.phase("uncertain");
    const bound = bindCommunitySongJob({
        owner,
        storage: m.store,
        http,
        draft: m.value()!,
        onChange() {},
      }),
      gate = f.delay("job-body");
    const read = bound.source.refresh().then(
      () => null,
      (error) => error,
    );
    try {
      await gate.entered.promise;
      const retry = bound.source.retry().then(
          () => null,
          (error) => error,
        ),
        before = f.calls.length;
      owner.dispose();
      gate.release.resolve();
      assert.ok(await read);
      assert.ok(await retry);
      assert.equal(f.calls.length, before);
      assert.equal(m.value()?.job?.phase, "uncertain");
      assert.equal(
        f.calls.some((call) => call.path.endsWith("/resume")),
        false,
      );
    } finally {
      gate.release.resolve();
      owner.dispose();
    }
  },
);

test(
  "unknown job read and refused native retry retain original File/envelope; observer has no erasure path",
  { timeout: 4000 },
  async () => {
    const f = shellFixture(),
      m = shellMemory(),
      owner = captureCommunityOwner(() => f.context),
      http = communityHttp(owner, f.transport);
    const controller = new CommunitySongController({
      owner,
      store: m.store,
      http,
    });
    await controller.prepare(f.input);
    await controller.publish();
    const saved = m.value()!;
    const job = bindCommunitySongJob({
      owner,
      storage: m.store,
      http,
      draft: saved,
      onChange() {},
    });
    f.failReads(true);
    await assert.rejects(job.source.refresh());
    f.failReads(false);
    await assert.rejects(job.source.retry(), /cannot be resumed/);
    assert.equal(m.value()?.requestId, saved.requestId);
    assert.equal(m.value()?.files.audio, saved.files.audio);
    assert.equal(m.value()?.bodyDigest, saved.bodyDigest);
    assert.equal(
      f.calls.filter((call) => call.path.endsWith("/resume")).length,
      0,
    );
    f.phase("uncertain");
    assert.equal((await job.source.refresh())?.status, "reconciling");
    assert.equal((await job.source.retry()).status, "processing");
    assert.equal(
      f.calls.filter((call) => call.path.endsWith("/resume")).length,
      1,
    );
    owner.dispose();
  },
);
