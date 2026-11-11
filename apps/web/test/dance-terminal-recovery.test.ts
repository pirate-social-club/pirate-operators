/** UNRUN. Real client/journal/controller regressions over named simulated
 * persistence/HTTP/authority boundaries. No native or canonical acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import { DanceClientError } from "../src/dance/client.ts";
import {
  hasDanceExpiredOutcome,
  sameOriginalCommand,
} from "../src/dance/journal.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { danceTargetKey } from "../src/dance/source/ports.ts";
import { decodeJourney } from "../src/dance/source/journey-store.ts";
import {
  scope,
  consent,
  captureFixture,
  hash,
} from "./dance-source-fixtures.ts";
import {
  simulatedTerminalJourney,
  terminalSignal as signal,
} from "./dance-terminal-recovery-fixtures.ts";
const expired = (e: unknown) =>
  e instanceof DanceClientError &&
  e.status === 410 &&
  e.code === "dance_capture_expired" &&
  !e.unknown;

for (const direct of [false, true])
  for (const boundary of [
    "none",
    "outcome_rollback",
    "outcome_commit_ack_lost",
    "journey_rollback",
    "journey_commit_ack_lost",
    "outcome_commit_lifetime_loss",
    "journey_commit_lifetime_loss",
  ] as const) {
    test(`${direct ? "direct" : "recovered unknown"} 410: ${boundary} preserves original and reaches terminal cleanup`, async () => {
      const x = simulatedTerminalJourney(),
        take = await x.prepareTake();
      if (!direct) {
        x.transport.mode = "lost_before_acceptance";
        await assert.rejects(x.submit(take.ports));
      }
      const first = await take.ports.client.retained!();
      x.clock(take.c.expiresAtMs + 1);
      x.transport.mode = "expired";
      let armed = true;
      const fail = () => {
        if (armed) {
          armed = false;
          throw Error("SIMULATED persistence acknowledgement loss");
        }
      };
      x.transport.outcomeBoundary = () => {
        if (boundary === "outcome_rollback")
          x.durable.boundary.beforeCommit = fail;
        if (boundary === "outcome_commit_ack_lost")
          x.durable.boundary.afterCommit = fail;
        if (boundary === "outcome_commit_lifetime_loss")
          x.durable.boundary.afterCommit = () => {
            if (armed) {
              armed = false;
              x.lifetime(false);
            }
          };
      };
      const store = x.f.journey.store,
        exclusive = store.exclusive.bind(store);
      store.exclusive = (s, guard, use) =>
        exclusive(s, guard, (h) =>
          use({
            ...h,
            save: async (patch) => {
              if (
                patch.terminal === "expired" &&
                boundary === "journey_rollback"
              )
                fail();
              const saved = await h.save(patch);
              if (
                patch.terminal === "expired" &&
                boundary === "journey_commit_ack_lost"
              )
                fail();
              if (
                patch.terminal === "expired" &&
                boundary === "journey_commit_lifetime_loss" &&
                armed
              ) {
                armed = false;
                x.lifetime(false);
                guard();
              }
              return saved;
            },
          }),
        );
      const attempt = direct
        ? x.submit(take.ports)
        : createDanceReviewController(take.ports).load(signal());
      await assert.rejects(attempt);
      x.lifetime(true);
      x.durable.boundary.beforeCommit = () => {};
      x.durable.boundary.afterCommit = () => {};
      x.transport.outcomeBoundary = () => {};
      store.exclusive = exclusive;
      const reload = x.select(scope),
        journey = await store.read(scope, () => {}),
        originalId = journey.commands?.submit?.commandId ?? first?.commandId;
      assert.ok(originalId);
      const original = await reload.client.command!(originalId);
      assert.ok(original);
      if (!direct) assert.equal(sameOriginalCommand(first!, original), true);
      const before = x.requests.filter(
        (r) => r.body && r.path.endsWith("reviews"),
      ).length;
      // Loading/preparing observes durable state, without automatic HTTP POST.
      try {
        await createDancePreparationController(reload).prepare(
          consent.termsHash,
          signal(),
        );
      } catch {
        /* uncertainty hold */
      }
      assert.equal(
        x.requests.filter((r) => r.body && r.path.endsWith("reviews")).length,
        before,
      );
      const outcomeWasDurable = hasDanceExpiredOutcome(original);
      await assert.rejects(
        createDanceReviewController(reload).load(signal()),
        expired,
      );
      assert.equal(
        x.requests.filter((r) => r.body && r.path.endsWith("reviews")).length,
        before + (outcomeWasDurable ? 0 : 1),
      );
      const reconciled = await store.read(scope, () => {}),
        retained = await reload.client.command!(originalId);
      assert.equal(reconciled.submission, "none");
      assert.equal(reconciled.terminal, "expired");
      assert.equal(hasDanceExpiredOutcome(reconciled.commands!.submit!), true);
      assert.equal(hasDanceExpiredOutcome(retained!), true);
      assert.equal(sameOriginalCommand(original, retained!), true);
      const posts = x.requests.filter(
        (r) => r.body && r.path.endsWith("reviews"),
      );
      assert.equal(
        posts.every((r) => r.body === original.requestJson),
        true,
      );
      const noSend = posts.length;
      await assert.rejects(reload.client.dispatchPrepared!(original), expired);
      await assert.rejects(
        createDanceReviewController(reload).load(signal()),
        expired,
      );
      assert.equal(
        x.requests.filter((r) => r.body && r.path.endsWith("reviews")).length,
        noSend,
      );
      await createDancePreparationController(reload).closeTerminal(signal());
      assert.equal((await store.read(scope, () => {})).capture, null);
      assert.equal(
        hasDanceExpiredOutcome((await reload.client.command!(originalId))!),
        true,
      );
      assert.equal(
        x.f.journey.archives.get(take.c.captureId)?.commands?.submit?.commandId,
        originalId,
      );
    });
  }

for (const mode of [
  "lost_before_acceptance",
  "auth401",
  "auth403",
  "server500",
  "other410",
  "text410",
] as const)
  test(`local clock expiry plus ${mode} cannot become authoritative expiry`, async () => {
    const x = simulatedTerminalJourney(),
      take = await x.prepareTake();
    x.transport.mode = "lost_before_acceptance";
    await assert.rejects(x.submit(take.ports));
    const original = await take.ports.client.retained!();
    assert.ok(original);
    x.clock(take.c.expiresAtMs + 1);
    x.transport.mode = mode;
    await assert.rejects(
      createDanceReviewController(take.ports).load(signal()),
    );
    const state = await x.f.journey.store.read(scope, () => {}),
      retained = await x.durable.journal().command!(scope, original.commandId);
    assert.equal(state.submission, "unknown");
    assert.equal(state.terminal, null);
    assert.equal(retained?.outcome, undefined);
    const reload = x.select(scope);
    await assert.rejects(
      createDancePreparationController(reload).closeTerminal(signal()),
    );
    assert.equal(
      sameOriginalCommand((await x.durable.journal().active(scope))!, original),
      true,
    );
  });

test("A complete -> B complete -> return A cleans A only; next deliberate start must freshly verify B", async () => {
  const x = simulatedTerminalJourney(),
    a = await x.prepareTake();
  await x.submit(a.ports);
  x.canonical(a.c);
  const originalA = await a.ports.client.acceptedCapture!();
  assert.ok(originalA);
  const b = await x.prepareTake(x.scopeB),
    acknowledgeB = b.ports.client.acknowledgeRecovery.bind(b.ports.client);
  b.ports.client.acknowledgeRecovery = async () => {
    throw Error("SIMULATED B receipt acknowledgement interrupted");
  };
  await assert.rejects(x.submit(b.ports));
  b.ports.client.acknowledgeRecovery = acknowledgeB;
  x.canonical(b.c);
  const originalB = await b.ports.client.acceptedCapture!();
  assert.ok(originalB);
  const latestB = await b.ports.client.retained!();
  assert.ok(latestB?.receiptJson);
  const backA = x.select(scope),
    p = createDancePreparationController(backA),
    posts = x.requests.filter((r) => r.body).length;
  await assert.rejects(
    x.durable.journal().definiteCaptureReset(scope, {
      commandId: originalB.commandId,
      captureId: a.c.captureId,
    }),
    /reset_changed/,
  );
  assert.equal((await p.prepare(consent.termsHash, signal())).kind, "terminal");
  await p.closeTerminal(signal());
  assert.equal((await x.f.journey.store.read(scope, () => {})).capture, null);
  assert.equal(
    (await backA.client.acceptedCapture!())?.commandId,
    originalB.commandId,
  );
  assert.deepEqual(await backA.client.retained!(), latestB);
  assert.equal(x.requests.filter((r) => r.body).length, posts);
  assert.equal(
    (await backA.client.command!(originalA.commandId))?.receiptJson,
    originalA.receiptJson,
  );
  assert.equal(
    (await x.f.journey.store.read(x.scopeB, () => {})).capture?.captureId,
    b.c.captureId,
  );
  const completedB = x.reviews.get(b.c.captureId)!;
  x.reviews.set(b.c.captureId, {
    ...completedB,
    canonical: { ...completedB.canonical!, canonical: false },
  });
  assert.equal(
    (await p.prepare(consent.termsHash, signal())).kind,
    "objectives",
  );
  await assert.rejects(
    p.start(consent.termsHash, signal()),
    /other_original_pending/,
  );
  assert.equal(
    (await backA.client.acceptedCapture!())?.commandId,
    originalB.commandId,
  );
  assert.equal(x.requests.filter((r) => r.body).length, posts);
  x.reviews.set(b.c.captureId, completedB);
  const next = captureFixture();
  next.captureId = "fresh_A";
  next.captureHash = hash(63);
  next.consent = {
    ...next.consent!,
    captureId: next.captureId,
    captureHash: next.captureHash,
  };
  x.captures.set(danceTargetKey(scope), next);
  assert.equal(
    (await p.start(consent.termsHash, signal())).session?.session_id,
    next.captureId,
  );
  assert.notEqual(
    (await backA.client.acceptedCapture!())?.commandId,
    originalA.commandId,
  );
  assert.equal(
    (await backA.client.command!(originalB.commandId))?.receiptJson,
    originalB.receiptJson,
  );
});

test("A cleanup preserves B and refuses any unrelated active or transport-uncertain original", async () => {
  const x = simulatedTerminalJourney(),
    a = await x.prepareTake();
  await x.submit(a.ports);
  x.canonical(a.c);
  const b = await x.prepareTake(x.scopeB);
  await x.submit(b.ports);
  x.canonical(b.c);
  const acceptedB = await b.ports.client.acceptedCapture!(),
    backA = x.select(scope);
  const pending = await backA.client.prepareSubmission!(
    danceTargetKey(scope),
    "unrelated_C",
    "media_C",
    hash(16),
  );
  for (const attempt of [false, true]) {
    if (attempt) {
      x.transport.mode = "lost_before_acceptance";
      await assert.rejects(backA.client.dispatchPrepared!(pending));
    }
    const before = structuredClone([...x.durable.rows]);
    await assert.rejects(
      createDancePreparationController(backA).closeTerminal(signal()),
      /resolution_unproven/,
    );
    assert.deepEqual([...x.durable.rows], before);
    assert.equal(
      (await backA.client.acceptedCapture!())?.commandId,
      acceptedB?.commandId,
    );
    assert.equal(
      (await x.f.journey.store.read(scope, () => {})).capture?.captureId,
      a.c.captureId,
    );
  }
});

for (const corrupt of ["account", "community", "malformed", "outcome"] as const)
  test(`atomic A cleanup vetoes ${corrupt} B pointer without clearing it`, async () => {
    const x = simulatedTerminalJourney(),
      a = await x.prepareTake();
    await x.submit(a.ports);
    x.canonical(a.c);
    const b = await x.prepareTake(x.scopeB);
    await x.submit(b.ports);
    x.canonical(b.c);
    const backA = x.select(scope);
    const row = x.durable.rows.get(
        JSON.stringify([scope.communityId, scope.accountId]),
      )!,
      old = row.accepted.capture!;
    const capture = JSON.parse(old.receiptJson!);
    if (corrupt === "account")
      capture.learner.accountId = "other_private_account";
    if (corrupt === "community") capture.communityId = hash(97);
    old.receiptJson = corrupt === "malformed" ? "{" : JSON.stringify(capture);
    if (corrupt === "outcome")
      Object.assign(old, { outcome: { version: "unknown" } });
    const before = structuredClone([...x.durable.rows]);
    await assert.rejects(
      createDancePreparationController(backA).closeTerminal(signal()),
    );
    assert.deepEqual([...x.durable.rows], before);
    assert.equal(
      (await x.f.journey.store.read(scope, () => {})).capture?.captureId,
      a.c.captureId,
    );
  });

test("account/lifetime loss before A cleanup cannot mutate any retained command", async () => {
  const x = simulatedTerminalJourney(),
    a = await x.prepareTake();
  await x.submit(a.ports);
  x.canonical(a.c);
  const before = structuredClone([...x.durable.rows]);
  x.current({ ...scope, accountId: "different_authenticated_owner" });
  await assert.rejects(
    createDancePreparationController(a.ports).closeTerminal(signal()),
    /session_changed/,
  );
  assert.deepEqual([...x.durable.rows], before);
});

for (const boundary of [
  "journal_rollback",
  "journal_commit_ack_lost",
  "journey_rollback",
  "journey_commit_ack_lost",
] as const)
  test(`A cleanup ${boundary} preserves B across reload`, async () => {
    const x = simulatedTerminalJourney(),
      a = await x.prepareTake();
    await x.submit(a.ports);
    x.canonical(a.c);
    const b = await x.prepareTake(x.scopeB);
    await x.submit(b.ports);
    x.canonical(b.c);
    const acceptedB = await b.ports.client.acceptedCapture!(),
      backA = x.select(scope),
      reset = backA.client.resetDefiniteCapture.bind(backA.client);
    let armed = true;
    const fail = () => {
      if (armed) {
        armed = false;
        throw Error("SIMULATED cleanup acknowledgement loss");
      }
    };
    backA.client.resetDefiniteCapture = async (id) => {
      if (boundary === "journal_rollback")
        x.durable.boundary.beforeCommit = fail;
      if (boundary === "journal_commit_ack_lost")
        x.durable.boundary.afterCommit = fail;
      return reset(id);
    };
    const store = x.f.journey.store,
      exclusive = store.exclusive.bind(store);
    store.exclusive = (s, guard, use) =>
      exclusive(s, guard, (h) =>
        use({
          ...h,
          save: async (patch) => {
            if (patch.capture === null && boundary === "journey_rollback")
              fail();
            const saved = await h.save(patch);
            if (
              patch.capture === null &&
              boundary === "journey_commit_ack_lost"
            )
              fail();
            return saved;
          },
        }),
      );
    await assert.rejects(
      createDancePreparationController(backA).closeTerminal(signal()),
    );
    store.exclusive = exclusive;
    x.durable.boundary.beforeCommit = () => {};
    x.durable.boundary.afterCommit = () => {};
    const reload = x.select(scope);
    assert.deepEqual(await reload.client.acceptedCapture!(), acceptedB);
    const state = await store.read(scope, () => {});
    if (state.capture)
      await createDancePreparationController(reload).closeTerminal(signal());
    assert.equal((await store.read(scope, () => {})).capture, null);
    assert.deepEqual(await reload.client.acceptedCapture!(), acceptedB);
    assert.equal(
      (
        await createDancePreparationController(reload).prepare(
          consent.termsHash,
          signal(),
        )
      ).kind,
      "objectives",
    );
  });

test("terminal projection codec rejects unknown or contradictory outcome facts", async () => {
  const x = simulatedTerminalJourney(),
    take = await x.prepareTake();
  x.transport.mode = "expired";
  await assert.rejects(x.submit(take.ports), expired);
  const original = await x.f.journey.store.read(scope, () => {});
  for (const defect of [
    "unknown_version",
    "extra_field",
    "receipt_and_expiry",
  ] as const) {
    const corrupt = structuredClone(original),
      command = corrupt.commands!.submit!;
    if (defect === "unknown_version")
      Object.assign(command.outcome!, { version: "unreviewed" });
    if (defect === "extra_field")
      Object.assign(command.outcome!, { optimistic: true });
    if (defect === "receipt_and_expiry")
      command.receiptJson = JSON.stringify({ commandId: command.commandId });
    assert.throws(() => decodeJourney(corrupt, scope), /journal_corrupt/);
  }
});

test("an existing legacy original can expire without inventing prepared metadata or replaying its terminal outcome", async () => {
  const x = simulatedTerminalJourney(),
    take = await x.prepareTake();
  // Historical state only: new production controllers always prepare first.
  await x.f.journey.store.exclusive(
    scope,
    () => {},
    async (h) => {
      await h.save({ submission: "unknown" });
    },
  );
  x.transport.mode = "lost_before_acceptance";
  await assert.rejects(
    take.ports.client.submit(take.c.captureId, "media", hash(16)),
  );
  const original = await take.ports.client.retained!();
  assert.ok(original);
  assert.equal(original.targetKey, undefined);
  assert.equal(original.requestJson, undefined);
  x.transport.mode = "expired";
  const reload = x.select(scope);
  await assert.rejects(
    createDanceReviewController(reload).load(signal()),
    expired,
  );
  const before = x.requests.filter(
    (r) => r.body && r.path.endsWith("reviews"),
  ).length;
  await assert.rejects(
    createDanceReviewController(reload).load(signal()),
    expired,
  );
  assert.equal(
    x.requests.filter((r) => r.body && r.path.endsWith("reviews")).length,
    before,
  );
  const saved = await reload.client.command!(original.commandId);
  assert.ok(saved);
  assert.equal(sameOriginalCommand(original, saved), true);
  assert.equal(hasDanceExpiredOutcome(saved), true);
  assert.equal(saved.targetKey, undefined);
  assert.equal(saved.requestJson, undefined);
  const bodies = x.requests
    .filter((r) => r.body && r.path.endsWith("reviews"))
    .map((r) => r.body);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  const state = await x.f.journey.store.read(scope, () => {});
  assert.equal(state.submission, "none");
  assert.equal(state.terminal, "expired");
  assert.equal(state.commands?.submit, undefined);
  await createDancePreparationController(reload).closeTerminal(signal());
  assert.equal(
    hasDanceExpiredOutcome((await reload.client.command!(original.commandId))!),
    true,
  );
});
