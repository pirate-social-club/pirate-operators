import test from "node:test";
import assert from "node:assert/strict";
import {
  createDanceClient,
  DanceClientError,
  type DanceClient,
} from "../apps/web/src/dance/client.ts";
import {
  identicalCommand,
  type DanceJournal,
  type DanceJournalEntry,
  type DanceJournalScope,
} from "../apps/web/src/dance/journal.ts";
import { createDanceLearnerController } from "../apps/web/src/dance/learner-controller.ts";
import { danceFixture, dh } from "./dance-fixture.ts";
class MemoryJournal implements DanceJournal {
  pending: DanceJournalEntry | null = null;
  entries = new Map<string, DanceJournalEntry>();
  recent: DanceJournalEntry | null = null;
  broken = false;
  async reserve(e: DanceJournalEntry) {
    if (this.broken) throw Error("journal disk full");
    if (this.pending) return structuredClone(this.pending);
    const old = this.entries.get(e.subject);
    if (old) return structuredClone(old);
    this.pending = structuredClone(e);
    return e;
  }
  async active(_s: DanceJournalScope) {
    return this.pending && structuredClone(this.pending);
  }
  async latest(_s: DanceJournalScope) {
    return this.recent && structuredClone(this.recent);
  }
  async acknowledge(_s: DanceJournalScope) {
    this.recent = null;
  }
  async accept(e: DanceJournalEntry, r: string) {
    assert.ok(this.pending && identicalCommand(this.pending, e));
    this.entries.set(e.subject, { ...e, receiptJson: r });
    this.recent = this.entries.get(e.subject)!;
    this.pending = null;
  }
  async definiteCaptureReset(_s: DanceJournalScope) {
    if (this.pending) throw Error("dance_response_unknown");
    this.entries.delete("capture");
    if (this.recent?.subject === "capture") this.recent = null;
  }
  async rejectExpired(e: DanceJournalEntry) {
    assert.equal(this.pending?.commandId, e.commandId);
    this.pending = null;
    this.entries.delete("capture");
  }
}
const options = (journal: DanceJournal, fetcher: typeof fetch) => ({
  communityId: dh(1),
  accountId: "owner",
  csrf: "fixture",
  journal,
  fetcher,
  isCurrent: () => true,
});
test("reload replays original uncertain Pass before opposite/different command; durable write precedes dispatch", async () => {
  const journal = new MemoryJournal(),
    bodies: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    assert.ok(journal.pending);
    bodies.push(String(init?.body));
    if (bodies.length === 1)
      throw Error("modeled network loss before acceptance");
    const b = JSON.parse(String(init?.body));
    return Response.json({
      commandId: b.commandId,
      reviewId: "review_1",
      state: "decision_pending",
    });
  };
  const a = createDanceClient(options(journal, transport));
  await assert.rejects(
    a.decide("review_1", 1, "pass", "reviewer-policy-v5"),
    /dance_response_unknown/,
  );
  a.dispose();
  const b = createDanceClient(options(journal, transport));
  await assert.rejects(
    b.decide("review_1", 1, "not_passed", "reviewer-policy-v5"),
    /dance_original_command_recovered/,
  );
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).verdict, "pass");
  await assert.rejects(
    b.decide("review_1", 1, "not_passed", "reviewer-policy-v5"),
    /dance_original_command_recovered/,
  );
  assert.equal(bodies.length, 2);
});
test("uncertain submission cannot retarget across reload or reset; storage failure sends no request", async () => {
  const j = new MemoryJournal();
  let fetches = 0;
  const fetcher: typeof fetch = async () => {
    fetches++;
    throw Error("unknown");
  };
  const a = createDanceClient(options(j, fetcher));
  await assert.rejects(
    a.submit("capture_a", "media_a", dh(2)),
    /dance_response_unknown/,
  );
  const b = createDanceClient(options(j, fetcher));
  await assert.rejects(
    b.submit("capture_b", "media_b", dh(3)),
    /dance_response_unknown/,
  );
  assert.equal(JSON.parse(j.pending!.bodyJson).captureId, "capture_a");
  await assert.rejects(b.resetDefiniteCapture(), /dance_response_unknown/);
  const full = new MemoryJournal();
  full.broken = true;
  const c = createDanceClient(options(full, fetcher));
  const prior = fetches;
  await assert.rejects(
    c.decide("review_2", 1, "pass", "reviewer-policy-v5"),
    /journal disk full/,
  );
  assert.equal(fetches, prior);
});
test("authoritative pre-acceptance expiry allows fresh capture; 403 preserves unknown command identity", async () => {
  const j = new MemoryJournal(),
    fetcher: typeof fetch = async () =>
      Response.json({ error: "dance_capture_expired" }, { status: 410 });
  const c = createDanceClient(options(j, fetcher));
  await assert.rejects(c.submit("c", "m", dh(2)), /dance_capture_expired/);
  assert.equal(j.pending, null);
  await c.resetDefiniteCapture();
  const denied = createDanceClient(
    options(j, async () =>
      Response.json({ error: "session_required" }, { status: 403 }),
    ),
  );
  await assert.rejects(denied.submit("c2", "m2", dh(3)), /session_required/);
  assert.ok(j.pending);
});
async function learnerFixture(
  overrides: Partial<DanceClient> = {},
  recordCanceled = false,
  current: () => boolean = () => true,
) {
  const f = danceFixture(),
    prepared = await f.prepare();
  const review = await f.store.review(prepared.reviewId);
  let submitted = 0,
    cleared = 0,
    resets = 0;
  const receipt = {
    version: "pirate.dance/1" as const,
    commandId: "fixture",
    reviewId: review.reviewId,
    revision: 1,
    state: "awaiting_review" as const,
    intentId: null,
  };
  const client: DanceClient = {
    capture: async () => prepared.capture,
    submit: async () => {
      submitted++;
      return receipt;
    },
    get: async () => review,
    queue: async () => ({
      version: "pirate.dance/1",
      items: [],
      cursor: null,
      skipped: { count: 0, reasons: {} },
    }),
    decide: async () => receipt,
    withdraw: async () => receipt,
    recover: async () => null,
    acknowledgeRecovery: async () => {},
    resetDefiniteCapture: async () => {
      resets++;
    },
    dispose() {},
    ...overrides,
  };
  const controller = createDanceLearnerController({
    client,
    selection: {
      songKey: prepared.capture.songKey,
      offerId: null,
      referenceId: null,
    },
    consent: { ...f.consent, text: "Fixture consent", admission: "admitted" },
    record: async () =>
      recordCanceled
        ? { status: "canceled" }
        : {
            status: "ready",
            take: {
              mediaId: prepared.mediaId,
              recordingSha256: prepared.recordingSha256,
              previewKey: "local-only",
            },
          },
    clearPrivate: () => {
      cleared++;
    },
    changed: () => {},
    current,
  });
  return {
    controller,
    submitted: () => submitted,
    cleared: () => cleared,
    resets: () => resets,
  };
}
test("take preview does not auto-submit; cancellation resets and explicit Submit is separate", async () => {
  const f = await learnerFixture();
  await f.controller.record();
  assert.equal(f.controller.state.phase, "preview");
  assert.equal(f.submitted(), 0);
  await f.controller.submit();
  assert.equal(f.submitted(), 1);
  assert.equal(f.controller.state.phase, "submitted");
  const canceled = await learnerFixture({}, true);
  await canceled.controller.record();
  assert.equal(canceled.controller.state.capture, null);
  assert.equal(canceled.resets(), 1);
});
test("uncertain submission blocks fresh capture; learner 401/403 clears result and private take/media", async () => {
  const unknown = await learnerFixture({
    submit: async () => {
      throw new DanceClientError("dance_response_unknown", true);
    },
  });
  await unknown.controller.record();
  await unknown.controller.submit();
  assert.equal(unknown.controller.state.phase, "submission_unknown");
  await unknown.controller.reset();
  assert.equal(unknown.resets(), 0);
  assert.ok(unknown.controller.state.take);
  for (const status of [401, 403]) {
    const denied = await learnerFixture({
      get: async () => {
        throw new DanceClientError("denied", false, status);
      },
    });
    await denied.controller.record();
    await denied.controller.load("review");
    assert.equal(denied.controller.state.phase, "denied");
    assert.equal(denied.controller.state.take, null);
    assert.equal(denied.controller.state.review, null);
    assert.equal(denied.controller.state.capture, null);
    assert.ok(denied.cleared());
  }
});
test("recording options cancellation clears private state only after the original command is accepted", async () => {
  let chosen: [string, number] | undefined;
  const accepted = await learnerFixture({
    withdraw: async (id, revision) => {
      chosen = [id, revision];
      return {
        version: "pirate.dance/1",
        commandId: "original-withdrawal",
        reviewId: id,
        revision: revision + 1,
        state: "withdrawal_pending",
        intentId: null,
      };
    },
  });
  await accepted.controller.load("original-review");
  const before = accepted.controller.state.review!;
  await accepted.controller.withdraw();
  assert.deepEqual(chosen, [before.reviewId, before.revision]);
  assert.equal(accepted.controller.state.phase, "denied");
  assert.equal(accepted.controller.state.review, null);
  assert.ok(accepted.cleared());

  const unknown = await learnerFixture({
    withdraw: async () => {
      throw new DanceClientError("dance_response_unknown", true);
    },
  });
  await unknown.controller.load("original-review");
  await unknown.controller.withdraw();
  assert.equal(unknown.controller.state.phase, "submitted");
  assert.ok(unknown.controller.state.review);
  assert.match(unknown.controller.state.error, /dance_response_unknown/);
});
test("a stale learner scope cannot start or replace a command", async () => {
  let requests = 0;
  const f = await learnerFixture(
    {
      capture: async () => {
        requests++;
        throw Error("unexpected capture");
      },
    },
    false,
    () => false,
  );
  await f.controller.record();
  await f.controller.reset();
  await f.controller.submit();
  await f.controller.withdraw();
  assert.equal(requests, 0);
  assert.equal(f.submitted(), 0);
  assert.equal(f.resets(), 0);
});
test("background status observation is read-only and cannot resume an uncertain withdrawal", async () => {
  let recoveries = 0;
  const f = await learnerFixture({
    recover: async () => {
      recoveries++;
      return null;
    },
    withdraw: async () => {
      throw new DanceClientError("dance_response_unknown", true);
    },
  });
  await f.controller.load("original-review");
  assert.equal(recoveries, 1);
  await f.controller.observe("original-review");
  assert.equal(recoveries, 1);
  await f.controller.withdraw();
  assert.match(f.controller.state.error, /dance_response_unknown/);
  await f.controller.observe("original-review");
  assert.match(f.controller.state.error, /dance_response_unknown/);
  assert.equal(recoveries, 1);
});
