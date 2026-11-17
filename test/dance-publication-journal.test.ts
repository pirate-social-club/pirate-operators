/** Failures specified before service implementation.
 * Protect actual D1 batch atomicity, original bytes and current private scope;
 * no fake permission boolean, latest-grant fallback or independent capture commit. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { danceAccountCommitment } from "../packages/dance-chain/v2/wire.ts";
import type { DanceDecision } from "../packages/dance-chain/v2/wire.ts";
import { other } from "./fixtures/publication-app.ts";
import { journalFixture } from "./dance-publication-journal-fixture.ts";

type Fixture = Awaited<ReturnType<typeof journalFixture>>;
const bounded = { timeout: 30000 };
async function scenario(
  t: TestContext,
  label: string,
  work: (f: Fixture) => Promise<void>,
  options: Parameters<typeof journalFixture>[1] = {},
) {
  const f = await journalFixture(t, options);
  try {
    await work(f);
  } finally {
    await f.artifact(label);
  }
}

test(
  "original Dance binding and caller acceptance commit together, retain exact grant and survive reload idempotently",
  bounded,
  async (t) =>
    scenario(t, "atomic-original-and-reload", async (f) => {
      const journal = await f.journal(),
        originals = await f.originals();
      const plan = await journal.prepareCapture(f.request());
      assert.equal(plan.grant.accountId, "account");
      assert.equal(plan.grant.binding.grantId, f.command.digest);
      assert.deepEqual(plan.grant.binding.grant, f.command.message);
      assert.equal(plan.grant.binding.recordedAtS, String(f.f.now()));
      assert.equal(
        plan.grant.binding.boundAtS,
        String(f.capture().reservedAtMs / 1000n),
      );
      assert.deepEqual(await f.bindings(), []);
      assert.deepEqual(await f.markers(), []);
      const guards = await journal.acceptanceFences({
        captureHash: plan.captureHash,
        grants: [plan.grant],
        configurationRevision: "1",
        ownerEpoch: "7",
      });
      await new DanceStore(f.db).assert([...guards]);
      assert.deepEqual(
        await f.bindings(),
        [],
        "observation must not independently install a binding",
      );
      await f.commit(
        { ...plan, fences: [...plan.fences, ...guards] },
        "accepted",
      );
      const bindings = await f.bindings();
      assert.equal(bindings.length, 1);
      assert.equal((await f.markers()).length, 1);
      const reloaded = await f.journal(),
        retry = await reloaded.prepareCapture(f.request());
      assert.deepEqual(retry.grant, plan.grant);
      const sameWallet = await reloaded.prepareCapture({
        ...f.request(),
        capture: {
          ...f.capture(),
          learner: getAddress(f.capture().learner),
        },
      });
      assert.equal(sameWallet.captureHash, plan.captureHash);
      await f.commit(retry, "deliberate-identical-retry");
      assert.deepEqual(await f.bindings(), bindings);
      assert.deepEqual(await f.originals(), originals);
      assert.equal(f.f.store().get("op:nonce"), 1);
      assert.equal(f.f.store().entries("intent:").length, 1);
      assert.equal(
        await f.db
          .prepare("SELECT count(*) AS n FROM dance_transaction_guards")
          .first("n"),
        0,
      );
    }),
);

test(
  "later caller mutation failure rolls back binding and every guard in the same genuine D1 batch",
  bounded,
  async (t) =>
    scenario(t, "caller-rollback", async (f) => {
      await f.db
        .prepare(
          "INSERT INTO dance_binding_acceptance_probe VALUES('duplicate',?)",
        )
        .bind(digest("original"))
        .run();
      const original = await f.originals(),
        plan = await (await f.journal()).prepareCapture(f.request());
      await assert.rejects(
        f.commit(plan, "duplicate"),
        /UNIQUE constraint failed/i,
      );
      assert.deepEqual(await f.bindings(), []);
      assert.deepEqual(await f.markers(), [
        { id: "duplicate", capture_hash: digest("original") },
      ]);
      assert.deepEqual(await f.originals(), original);
      assert.equal(
        await f.db
          .prepare("SELECT count(*) AS n FROM dance_transaction_guards")
          .first("n"),
        0,
      );
    }),
);

for (const race of [
  "withdrawal",
  "session",
  "credential",
  "identity",
  "command-version",
  "observation",
  "installation",
] as const)
  test(
    "prepared Dance binding refuses an actual accepting D1 " + race + " race",
    bounded,
    async (t) =>
      scenario(t, "atomic-" + race, async (f) => {
        const plan = await (await f.journal()).prepareCapture(f.request()),
          originals = await f.originals();
        const gate = f.f.holdMutation("INSERT INTO dance_publication_bindings");
        const pending = f.commit(plan, "must-not-commit");
        const refused = assert.rejects(
          pending,
          /dance_fence_changed|CHECK constraint failed/,
        );
        try {
          await gate.entered;
          if (race === "withdrawal")
            assert.equal(
              (
                await f.f.stop({
                  purpose: "dance-verdict",
                  requestId: "withdraw-after-capture-prepare",
                  sourceCommandId: f.command.commandId,
                })
              ).status,
              200,
            );
          else if (race === "session") await f.f.revokeSession();
          else if (race === "credential")
            await f.db
              .prepare(
                "UPDATE credential_bindings SET subject=? WHERE binding_id='binding'",
              )
              .bind(other.address.toLowerCase())
              .run();
          else if (race === "identity")
            await f.db
              .prepare(
                "UPDATE application_identity SET community_origin='https://changed.invalid' WHERE id=1",
              )
              .run();
          else if (race === "command-version")
            await f.db
              .prepare(
                "UPDATE publication_v1_commands SET version=version+1,due_ms=due_ms+1 WHERE command_id=?",
              )
              .bind(f.command.commandId)
              .run();
          else if (race === "observation") {
            assert.ok(f.original);
            f.f.authority.state.receipts.delete(f.original.hash);
            assert.equal(
              (await f.f.call("commands/" + f.command.commandId)).status,
              200,
            );
          } else await f.f.setCatalog(null);
        } finally {
          gate.release();
        }
        await refused;
        assert.deepEqual(await f.bindings(), []);
        assert.deepEqual(await f.markers(), []);
        assert.deepEqual(
          (await f.originals()).filter((o) => o.id === f.command.commandId),
          originals,
        );
        assert.equal(
          f.f.store().get("op:nonce"),
          1,
          "no replacement sender allocation",
        );
        assert.equal(
          await f.db
            .prepare("SELECT count(*) AS n FROM dance_transaction_guards")
            .first("n"),
          0,
        );
      }),
  );

test(
  "a later grant cannot replace the original command under the same capture identity",
  bounded,
  async (t) =>
    scenario(t, "same-capture-no-retarget", async (f) => {
      const j = await f.journal(),
        c = f.capture(),
        p = await j.prepareCapture(f.request(c));
      await f.commit(p, "original");
      const bindings = await f.bindings();
      const next = await f.secondGrant();
      const changed = {
        ...f.capture("capture-A", next),
        captureId: c.captureId,
      };
      await assert.rejects(
        (await f.journal()).prepareCapture({
          ...f.request(changed),
          commandId: next.commandId,
        }),
        /dance_publication_binding_changed/,
      );
      assert.deepEqual(await f.bindings(), bindings);
      await assert.rejects(
        j.acceptanceFences({
          captureHash: p.captureHash,
          grants: [
            {
              ...p.grant,
              binding: { ...p.grant.binding, grantId: next.digest },
            },
          ],
          configurationRevision: "1",
          ownerEpoch: "7",
        }),
        /dance_publication_binding_changed/,
      );
    }),
);

for (const state of ["prepared", "queued", "recorded-but-stopped"] as const)
  test(
    "a " +
      state +
      " publication command cannot fabricate a usable Dance binding",
    bounded,
    async (t) =>
      scenario(
        t,
        "no-bind-" + state,
        async (f) => {
          const j = await f.journal(),
            receipt = await j.reconcileOriginal(f.command);
          assert.equal(
            receipt.state,
            state === "recorded-but-stopped" ? "recorded" : state,
          );
          await assert.rejects(
            j.prepareCapture(f.request()),
            /dance_publication_(not_recorded|local_changed)/,
          );
          assert.deepEqual(await f.bindings(), []);
          assert.deepEqual(await f.markers(), []);
        },
        {
          submitted: state !== "prepared",
          recorded: state === "recorded-but-stopped",
          activate: false,
        },
      ),
  );

test(
  "original receipt survives withdrawal, expiry, active-source disablement and a newly mounted installation",
  bounded,
  async (t) =>
    scenario(t, "recovery-first-across-disable", async (f) => {
      const j = await f.journal(),
        receipt = await j.reconcileOriginal(f.command);
      assert.equal(receipt.state, "recorded");
      const original = await f.originals();
      assert.equal(
        (
          await f.f.stop({
            purpose: "dance-verdict",
            requestId: "stop-original",
            sourceCommandId: f.command.commandId,
          })
        ).status,
        200,
      );
      await f.f.setCatalog(null);
      f.f.advance(4000n);
      const current = await f.journal(),
        before = f.f.operatorCalls.length;
      const recovered = await current.reconcileOriginal(f.command);
      assert.deepEqual(recovered, receipt);
      assert.ok(
        f.f.operatorCalls
          .slice(before)
          .every((c) => c.path === "/publication/v1/reconcile"),
      );
      assert.deepEqual(
        (await f.originals()).filter((o) => o.id === f.command.commandId),
        original,
      );
      await assert.rejects(
        current.prepareCapture(f.request()),
        /publication_release_inactive|dance_publication_/,
      );
      assert.deepEqual(await f.bindings(), []);
      assert.equal(f.f.store().get("op:nonce"), 1);
    }),
);

test(
  "malformed, wrong-account, changed-source and changed original-command preimages refuse before reconciliation",
  bounded,
  async (t) =>
    scenario(t, "closed-original-command", async (f) => {
      const j = await f.journal(),
        before = f.f.operatorCalls.length,
        original = await f.originals();
      for (const changed of [
        { ...f.command, digest: digest("wrong") },
        { ...f.command, accountId: "different-private-account" },
        {
          ...f.command,
          source: {
            ...f.command.source,
            registry: other.address.toLowerCase(),
          },
        },
        { ...f.command, requestId: "replacement-request" },
      ])
        await assert.rejects(j.reconcileOriginal(changed as typeof f.command));
      assert.equal(f.f.operatorCalls.length, before);
      assert.deepEqual(await f.originals(), original);
      assert.deepEqual(await f.bindings(), []);
    }),
);

test(
  "binding DDL refuses duplicate INSERT OR REPLACE independently of recursive delete triggers",
  bounded,
  async (t) =>
    scenario(t, "immutable-binding-replace", async (f) => {
      const p = await (await f.journal()).prepareCapture(f.request());
      await f.commit(p, "original");
      const rows = await f.bindings();
      await f.db.prepare("PRAGMA recursive_triggers=OFF").run();
      await assert.rejects(
        f.db
          .prepare(
            "INSERT OR REPLACE INTO dance_publication_bindings SELECT community_id,capture_id,capture_hash,account_id,purpose,command_id,value_json FROM dance_publication_bindings",
          )
          .run(),
        /dance_publication_binding_immutable/,
      );
      await assert.rejects(
        f.db
          .prepare(
            "UPDATE dance_publication_bindings SET value_json=value_json",
          )
          .run(),
        /dance_publication_binding_immutable/,
      );
      await assert.rejects(
        f.db.prepare("DELETE FROM dance_publication_bindings").run(),
        /dance_publication_binding_immutable/,
      );
      assert.deepEqual(await f.bindings(), rows);
    }),
);

test(
  "a real second reviewer binds its own purpose; learner withdrawal vetoes a subsequent accepting batch",
  bounded,
  async (t) =>
    scenario(t, "reviewer-and-learner-originals", async (f) => {
      const c = f.capture(),
        learnerPlan = await (await f.journal()).prepareCapture(f.request(c));
      await f.commit(learnerPlan, "capture");
      const reviewer = await f.reviewer(),
        rc = reviewer.command;
      const calls = f.f.operatorCalls.length;
      await assert.rejects(
        reviewer.journal.reconcileOriginal(f.command),
        /dance_publication_command_not_owned/,
      );
      assert.equal(
        f.f.operatorCalls.length,
        calls,
        "another private account cannot probe an original command",
      );
      assert.equal(rc.action, "grant");
      if (rc.action !== "grant") throw Error("fixture_grant_required");
      const domain = {
        chainId: BigInt(rc.source.chainId),
        verifier: rc.message.publicationTarget,
        communityId: rc.source.communityId,
      };
      const decision: DanceDecision = {
        submissionId: digest("submission"),
        verdict: 1,
        reviewerAccountCommitment: danceAccountCommitment(
          domain,
          rc.accountId,
          rc.message.learner,
        ),
        reviewerWallet: rc.message.learner,
        reviewerPublicationGrantId: rc.digest,
        reviewerIdentityEpoch: 1n,
        reviewerGroupId: digest("reviewer-group"),
        reviewerGroupEpoch: 1n,
        expectedOwnerEpoch: 7n,
        expectedReviewerRoleEpoch: 9n,
        expectedMediaEpoch: 1n,
        intentAcceptedAtMs: f.f.now() * 1000n,
        expectedConfigurationRevision: 1n,
        expectedRulesEpoch: 1n,
        reviewerConsentHash: digest("review-consent"),
      };
      const rp = await reviewer.journal.prepareReview({
        commandId: rc.commandId,
        capture: c,
        decision,
      });
      const fences = await reviewer.journal.acceptanceFences({
        captureHash: rp.captureHash,
        grants: [learnerPlan.grant, rp.grant],
        configurationRevision: "1",
        ownerEpoch: "7",
      });
      assert.equal(rp.grant.accountId, "reviewer");
      assert.equal(rp.grant.binding.grant.purpose, "dance-review-attribution");
      await f.commit(
        { ...rp, fences: [...rp.fences, ...fences] },
        "review-binding-accepted",
      );
      const retainedBindings = await f.bindings(),
        retainedMarkers = await f.markers();
      assert.equal(retainedBindings.length, 2);
      assert.equal(retainedMarkers.length, 2);
      const gate = f.f.holdMutation("INSERT INTO dance_publication_bindings");
      const pending = f.commit(
        { ...rp, fences: [...rp.fences, ...fences] },
        "review-must-not-commit",
      );
      const refused = assert.rejects(
        pending,
        /dance_fence_changed|CHECK constraint failed/,
      );
      try {
        await gate.entered;
        assert.equal(
          (
            await f.f.stop({
              purpose: "dance-verdict",
              requestId: "learner-stop-before-review",
              sourceCommandId: f.command.commandId,
            })
          ).status,
          200,
        );
      } finally {
        gate.release();
      }
      await refused;
      assert.deepEqual(await f.bindings(), retainedBindings);
      assert.deepEqual(await f.markers(), retainedMarkers);
    }),
);

test(
  "missing binding schema fails closed without DDL-on-read or an independent accepting mutation",
  bounded,
  async (t) =>
    scenario(
      t,
      "missing-ddl-held",
      async (f) => {
        await assert.rejects(
          (await f.journal()).prepareCapture(f.request()),
          /no such table.*dance_publication_bindings/i,
        );
        assert.equal(
          await f.db
            .prepare(
              "SELECT count(*) AS n FROM sqlite_master WHERE name='dance_publication_bindings'",
            )
            .first("n"),
          0,
        );
        assert.deepEqual(await f.markers(), []);
      },
      { schema: false },
    ),
);

test(
  "captured configuration and owner epochs cannot be rebound or replaced by malformed counters",
  bounded,
  async (t) =>
    scenario(t, "frozen-epoch-join", async (f) => {
      const j = await f.journal(),
        input = f.request(),
        plan = await j.prepareCapture(input);
      await f.commit(plan, "original");
      const bindings = await f.bindings();
      for (const changed of [
        { configurationRevision: "2", ownerEpoch: "7" },
        { configurationRevision: "1", ownerEpoch: "8" },
        { configurationRevision: "01", ownerEpoch: "7" },
      ]) {
        await assert.rejects(
          j.acceptanceFences({
            captureHash: plan.captureHash,
            grants: [plan.grant],
            ...changed,
          }),
        );
        await assert.rejects(
          (await f.journal()).prepareCapture({ ...input, ...changed }),
        );
        assert.deepEqual(await f.bindings(), bindings);
      }
      assert.equal((await f.markers()).length, 1);
      assert.equal(f.f.store().get("op:nonce"), 1);
    }),
);
