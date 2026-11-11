import test from "node:test";
import assert from "node:assert/strict";
import { TelegramStudyService } from "../services/telegram-study.ts";
import {
  connectedFactoryFixture,
  deferred,
} from "./telegram-connected-factory-fixture.ts";
import {
  boundaryError,
  connectedBoundary,
  requireFactoryGate,
} from "./telegram-factory-boundary.ts";

// UNRUN. Coordinator-only native/operator fixture slot; this observes the
// existing actual factory path and retains the required joined-row assertion.
test(
  "diagnose the first actual native callback through the original Study start",
  { timeout: 90000 },
  async (t) => {
    const starts: {
      state: "entered" | "completed" | "failed";
      code?: string;
    }[] = [];
    const original = TelegramStudyService.prototype.start;
    t.mock.method(
      TelegramStudyService.prototype,
      "start",
      async function (
        this: TelegramStudyService,
        ...args: Parameters<TelegramStudyService["start"]>
      ) {
        const observation: (typeof starts)[number] = { state: "entered" };
        starts.push(observation);
        try {
          const result = await original.apply(this, args);
          observation.state = "completed";
          return result;
        } catch (error) {
          observation.state = "failed";
          observation.code = boundaryError(error);
          throw error;
        }
      },
    );
    const f = await connectedFactoryFixture(20346);
    try {
      assert.equal((await f.choose()).status, 200);
      await f.factory.alarm();
      const snapshot = await connectedBoundary(f);
      t.diagnostic(
        JSON.stringify({
          starts,
          operatorResponses: f.operatorResponses,
          ...snapshot,
        }),
      );
      assert.equal(
        starts.length,
        1,
        "one callback must call the original Study start once",
      );
      assert.deepEqual(
        starts,
        [{ state: "completed" }],
        JSON.stringify(snapshot),
      );
      const joined = await f.shared.db
        .prepare(
          "SELECT l.lesson_id,p.binding_json FROM study_lessons l JOIN study_publications p USING(lesson_id) WHERE l.account_id=?",
        )
        .bind(f.session.account_id)
        .first<{ lesson_id: string; binding_json: string }>();
      assert.ok(joined, JSON.stringify(snapshot));
      assert.equal(
        JSON.parse(joined.binding_json).offer.speechChannel,
        "telegram-linked",
      );
      assert.equal(f.shared.counts().calls, 0);
    } finally {
      await f.dispose();
    }
  },
);

test("a refused completed tick fails the deferred gate immediately with boundary facts", async () => {
  const gate = deferred();
  let inspections = 0;
  await assert.rejects(
    requireFactoryGate(
      gate.promise,
      Promise.resolve(),
      "/authorization/",
      () => {
        inspections++;
        return { joined: 0, refused: true };
      },
    ),
    /factory_gate_not_reached:\/authorization\/.*"joined":0/,
  );
  assert.equal(inspections, 1);
});

test("a rejected processing promise keeps its original failure as cause", async () => {
  const gate = deferred(),
    cause = Error("fixture_processing_refused");
  await assert.rejects(
    requireFactoryGate(
      gate.promise,
      Promise.reject(cause),
      "/study/bind",
      () => ({ joined: 0 }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.cause === cause &&
      error.message.startsWith("factory_processing_failed:"),
  );
});

test("a real deferred entry still holds processing until the original release", async () => {
  const entered = deferred(),
    release = deferred();
  let dispatched = false,
    complete = false,
    inspections = 0;
  const processing = (async () => {
    dispatched = true;
    entered.resolve();
    await release.promise;
    complete = true;
  })();
  await requireFactoryGate(entered.promise, processing, "/study/bind", () => {
    inspections++;
    return { unexpected: true };
  });
  assert.equal(dispatched, true);
  assert.equal(complete, false);
  release.resolve();
  await processing;
  assert.equal(complete, true);
  assert.equal(inspections, 0);
});
