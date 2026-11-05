// The barrier uses actual D1 transactions to force the older confirmed head to
// commit first. The chain transport is an explicit deterministic simulation.
import test from "node:test";
import assert from "node:assert/strict";
import { communityRuntime } from "./community-runtime.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";
import { configuration, publisher } from "./fixtures/release-admission.ts";
import { publicSongs } from "../services/community-public.ts";

for (const [newerHead, changedCheckpoint] of [
  [101n, false],
  [102n, false],
  [102n, true],
] as const) {
  test(`concurrent readers reconcile a cursor winner when observed heads are101/${newerHead}, changed checkpoint=${changedCheckpoint}`, async () => {
    const f = await communityRuntime();
    try {
      const posts = releasePostsFixture(publisher, configuration);
      let releaseOld!: () => void, releaseNew!: () => void;
      const bothAtLogs = new Promise<void>((resolve) => {
          releaseOld = resolve;
        }),
        oldCommitted = new Promise<void>((resolve) => {
          releaseNew = resolve;
        });
      const olderClient = {
          ...posts.client,
          getBlockNumber: async () => 101n,
          getLogs: async () => {
            await bothAtLogs;
            return [];
          },
        },
        newerClient = {
          ...posts.client,
          getBlockNumber: async () => newerHead,
          getLogs: async () => {
            releaseOld();
            await oldCommitted;
            if (changedCheckpoint)
              await f.db
                .prepare("UPDATE chain_scan_state SET checkpoint_hash=?")
                .bind("0x" + "0".repeat(64))
                .run();
            return [];
          },
        };
      const older = publicSongs(f.db, configuration, {
          client: olderClient,
          profile: posts.profile,
        }).finally(releaseNew),
        newer = publicSongs(f.db, configuration, {
          client: newerClient,
          profile: posts.profile,
        });
      const results = await Promise.allSettled([older, newer]);
      if (changedCheckpoint) {
        assert.equal(results[0]!.status, "fulfilled");
        assert.equal(results[1]!.status, "rejected");
        if (results[1]!.status === "rejected")
          assert.match(
            results[1]!.reason.message,
            /public_index_checkpoint_changed/,
          );
      } else
        assert.deepEqual(results, [
          { status: "fulfilled", value: [] },
          { status: "fulfilled", value: [] },
        ]);
      const cursor = await f.db
        .prepare("SELECT next_block FROM chain_scan_state")
        .first<{ next_block: string }>();
      assert.equal(
        cursor!.next_block,
        changedCheckpoint ? "101" : newerHead.toString(),
      );
      assert.equal(
        (await f.db
          .prepare("SELECT COUNT(*) AS n FROM public_post_revisions")
          .first())!.n,
        0,
      );
      assert.equal(
        (await f.db
          .prepare("SELECT COUNT(*) AS n FROM transaction_guards")
          .first())!.n,
        0,
      );
    } finally {
      await f.dispose();
    }
  });
}
