import test from "node:test";
import assert from "node:assert/strict";
import { fixture, actor } from "./community-media-fixture.ts";
import { eraseCommunityMedia } from "../services/community-media-maintenance.ts";

test(
  "A empty-list pause / B late-object deletion failure / A stale-clear retains the newer erasure obligation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      ready = await f.ready();
    await f.service.withdraw(ready.id, actor);
    const pending = await f.repository.save(await f.repository.get(ready.id), {
      erasePending: true,
    });
    f.ports.quota.perAccount = 1;
    let listed!: () => void, release!: () => void;
    const emptyListed = new Promise<void>((resolve) => {
      listed = resolve;
    });
    const resumeA = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const bucket = f.ports.bucket,
      save = f.repository.save.bind(f.repository);
    let first = true;
    const claims: number[] = [],
      clears: number[] = [];
    f.repository.save = async (before, changes) => {
      if (changes.erasePending === false) clears.push(before.revision);
      const next = await save(before, changes);
      if (changes.erasePending === true) claims.push(next.revision);
      return next;
    };
    f.ports.bucket = new Proxy(bucket, {
      get(target, property) {
        if (property === "list")
          return async (options: R2ListOptions) => {
            const page = await target.list(options);
            if (first) {
              first = false;
              assert.equal(page.objects.length, 0);
              listed();
              await resumeA;
            }
            return page;
          };
        if (property === "delete")
          return async () => {
            throw Error("B late-object deletion failed");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sweepA = eraseCommunityMedia(f.service, pending);
    await emptyListed;
    const lateKey = `${f.service.prefix(ready.id)}late-after-A.mp4`;
    await bucket.put(lateKey, f.source);
    await eraseCommunityMedia(f.service, await f.repository.get(ready.id));
    const afterB = await f.repository.get(ready.id);
    assert.equal(afterB.erasePending, true);
    assert.equal(
      claims.length,
      2,
      "both attempts must obtain fresh CAS revisions even while pending was true",
    );
    assert.ok(claims[1]! > claims[0]!);
    release();
    await sweepA;
    const afterA = await f.repository.get(ready.id);
    assert.equal(afterA.revision, afterB.revision);
    assert.equal(afterA.erasePending, true);
    assert.deepEqual(
      clears,
      [claims[0]],
      "A may only try to clear its own now-stale generation",
    );
    assert.ok(await bucket.head(lateKey));
    await assert.rejects(
      f.reserve({ requestId: "blocked_by_late_bytes" }),
      /media_capacity_full/,
    );
    f.ports.bucket = bucket;
    await eraseCommunityMedia(f.service, afterA);
    assert.equal((await f.repository.get(ready.id)).erasePending, false);
    assert.equal(await bucket.head(lateKey), null);
    assert.equal(
      (await f.reserve({ requestId: "after_cleanup_succeeds" })).state,
      "uploading",
    );
  },
);
