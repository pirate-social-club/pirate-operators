import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { rewardTestProfile } from "./manual-rewards-fixture.ts";
import { communityScheduled } from "../services/community-application.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";
import type { RewardChain } from "../packages/rewards/contracts.ts";
import { RewardStore } from "../packages/rewards/store.ts";

// Every read-only reward RPC either never answers or fails. Reconciliation
// must still be attempted, but only after Study retention and recovery.
function stalledChain(mode: "hang" | "reject") {
  const calls: string[] = [];
  let release!: (error: Error) => void;
  const released = new Promise<never>((_, reject) => {
    release = reject;
  });
  released.catch(() => {});
  const chain = new Proxy({} as RewardChain, {
    get: (_, method) => async () => {
      calls.push(String(method));
      if (mode === "reject") throw new Error("reward_rpc_unavailable");
      return released;
    },
  });
  return { chain, calls, release: () => release(new Error("released")) };
}

for (const [mode, port] of [
  ["hang", 19901],
  ["reject", 19902],
] as const) {
  test(
    `scheduled Study recovery completes while reward reconciliation ${mode === "hang" ? "never answers" : "fails"}`,
    { timeout: 60000 },
    async () => {
      const f = await studyPublicationFixture(port);
      const stalled = stalledChain(mode);
      try {
        const sql = await readFile(
          new URL(
            "../apps/community-wizard/infra/migrations/0011_manual_rewards.sql",
            import.meta.url,
          ),
          "utf8",
        );
        await f.db.batch(
          sql
            .replace(/--[^\n]*/g, "")
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => f.db.prepare(s)),
        );
        // One confirmed funding record makes the treasury audit read the chain.
        const store = new RewardStore(f.db, rewardTestProfile);
        await store.init();
        await f.db
          .prepare(
            "INSERT INTO reward_funding(funding_id,program_id,kind,source_json,destination_json,input_hash,amount_atomic,transaction_hash,log_index) VALUES('funding_1',?,'prefunding','{}',?,?,'100000',?,0)",
          )
          .bind(
            store.program,
            JSON.stringify({ blockNumber: "100" }),
            `0x${"99".repeat(32)}`,
            `0x${"98".repeat(32)}`,
          )
          .run();
        // A lesson from before the time limit was removed keeps its one-hour
        // deadline, so scheduled recovery closes and publishes it here.
        const lesson = await f.startLegacy();
        f.behavior(async () => {
          throw new StudySpeechError("speech_timeout", "unknown");
        });
        await f.answer(lesson, true);
        f.advance(3600001);
        await f.mineClock();
        const env = {
          ...f.env,
          REWARDS_PROFILE_JSON: JSON.stringify(rewardTestProfile),
        };
        const ports = {
          ...f.ports,
          rewards: { chain: stalled.chain },
        } as typeof f.ports;
        const run = communityScheduled(env, ports);
        run.catch(() => {});
        const deadline = Date.now() + 30000;
        while ((await f.publication(lesson.lessonId)).state !== "published") {
          assert.ok(Date.now() < deadline, "Study recovery was held");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const closed = await f.get(lesson.lessonId);
        assert.equal(closed.status, "expired");
        assert.equal(closed.completedAt, lesson.expiresAt);
        // Reconciliation is still attempted after Study work, and its failure
        // remains visible to the scheduler instead of being swallowed.
        while (stalled.calls.length === 0) {
          assert.ok(Date.now() < deadline, "reconciliation was skipped");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        stalled.release();
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message, "community_scheduled_failed");
          return true;
        });
      } finally {
        stalled.release();
        await f.dispose();
      }
    },
  );
}
