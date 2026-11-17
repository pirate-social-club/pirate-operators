import { hashPrivateDanceCaptureV2 } from "../../../packages/dance/capture-v2.ts";
import { word } from "../../../test/fixtures/dance-capture-v2.ts";
import { createDanceReviewController } from "../src/dance/source/dance-review-controller.ts";
/** Actual client/journal and completion controllers. Persistence delivery and
 * media HTTP are explicit simulations; native media admission has separate
 * mounted HTTP/D1/R2 coverage. No wallet, camera or provider claim. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDanceClient } from "../src/dance/client.ts";
import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import { captureTarget, danceTargetKey } from "../src/dance/source/ports.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import {
  simulatedSource,
  simulatedJourneyStore,
  mediaFixture,
} from "./dance-source-fixtures.ts";
import { danceCaptureV2Fixture } from "../../../test/fixtures/dance-capture-v2.ts";

async function fixture() {
  const f = danceCaptureV2Fixture(),
    template = f.privateCapture;
  const target = captureTarget(template),
    scope = {
      ...target,
      sessionKey: "private-done-session",
      profileLabel: "Your profile",
    };
  const consent = {
    accepted: true as const,
    version: "private-done-fixture/2",
    termsHash: template.termsHash,
    publicityPolicyHash: f.pin.publicityPolicyHash,
  };
  const commands = simulatedCommandStorage(),
    journal = commands.journal(),
    commandScope = {
      communityId: scope.communityId,
      accountId: scope.accountId,
    };
  const journey = simulatedJourneyStore(),
    model = simulatedSource();
  let live = true;
  const requests: string[] = [];
  const client = createDanceClient({
    ...commandScope,
    csrf: "private-csrf",
    isCurrent: () => live,
    journal,
    captureProfile: {
      version: "pirate.dance-capture-request/2",
      target: {
        communityId: scope.communityId,
        songKey: scope.songKey,
        songRevision: scope.songRevision,
        audioSha256: scope.audioSha256,
        reference: scope.reference,
        offerId: scope.offerId,
      },
      publication: { kind: "private" },
    },
    fetcher: async (url, init) => {
      requests.push(String(url));
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...template,
        consent: {
          ...consent,
          receiptId: body.commandId,
          accountId: scope.accountId,
          captureId: template.captureId,
          captureHash: template.captureHash,
          acceptedAtMs: template.reservedAtMs + 1,
        },
      });
    },
  });
  const command = await client.prepareCapture!(
    danceTargetKey(scope),
    scope.songKey,
    scope.offerId,
    scope.reference?.id ?? null,
    consent,
  );
  const capture = (await client.dispatchPrepared!(command)) as typeof template;
  const status = mediaFixture(capture),
    digest = status.ready!.recordingSha256;
  await journey.store.exclusive(
    scope,
    () => {},
    (h) =>
      h.save({
        capture,
        captureUnknown: false,
        commands: { capture: command },
        upload: {
          requestId: "private-upload-original",
          recordingSha256: digest,
          bytes: 1000,
          mediaId: status.id,
          put: "acknowledged",
          status,
        },
      }),
  );
  const ports = {
    ...model.ports,
    scope,
    currentScope: () => (live ? scope : null),
    client,
    journal: journey.store,
    nowMs: () => capture.reservedAtMs + 100,
    consent: {
      ...consent,
      text: "Private completion fixture terms",
      admission: "admitted" as const,
    },
    captureAccess: async () => {},
    media: {
      ...model.ports.media,
      status: async (
        _capture: Parameters<typeof model.ports.media.status>[0],
        _id: string,
      ) => status,
    },
  };
  return {
    expectation: {
      captureId: capture.captureId,
      captureHash: capture.captureHash,
      commandId: command.commandId,
      mediaId: status.id,
      recordingSha256: digest,
    },
    capture,
    command,
    status,
    client,
    journal,
    commandScope,
    commands,
    journey,
    ports,
    requests,
    lifetime: (v: boolean) => {
      live = v;
    },
  };
}

test("Done archives a confirmed private take and starts another without a public review or media deletion", async () => {
  const f = await fixture();
  try {
    const displayed = createDanceReviewController(f.ports);
    await displayed.observe(new AbortController().signal);
    await displayed.finishPrivate(new AbortController().signal);
    const saved = await f.journey.store.read(f.ports.scope, () => {});
    assert.equal(saved.capture, null);
    assert.equal(saved.upload, null);
    assert.equal(await f.journal.acceptedCapture!(f.commandScope), null);
    assert.equal(
      (await f.journal.command!(f.commandScope, f.command.commandId))
        ?.receiptJson,
      JSON.stringify(f.capture),
    );
    assert.deepEqual(
      f.journey.archives.get(f.capture.captureId)?.capture,
      f.capture,
    );
    assert.equal(f.status.state, "ready");
    assert.deepEqual(f.requests, ["/api/dance/captures"]);
    const next = await f.client.prepareCapture!(
      danceTargetKey(f.ports.scope),
      f.ports.scope.songKey,
      f.ports.scope.offerId,
      f.ports.scope.reference?.id ?? null,
      {
        accepted: true,
        version: f.capture.consent!.version,
        termsHash: f.capture.consent!.termsHash,
        publicityPolicyHash: f.capture.consent!.publicityPolicyHash,
      },
    );
    assert.notEqual(next.commandId, f.command.commandId);
    assert.equal(JSON.parse(next.bodyJson).publication.kind, "private");
  } finally {
    f.client.dispose();
  }
});

test("private Done cannot retire a different ready recording", async () => {
  const f = await fixture();
  try {
    f.ports.media.status = async () => ({
      ...f.status,
      ready: { ...f.status.ready!, recordingSha256: "ff".repeat(32) },
    });
    await assert.rejects(
      createDancePreparationController(f.ports).closeTerminal(
        new AbortController().signal,
        f.expectation,
      ),
      /target_changed/,
    );
    assert.equal(
      (await f.journal.acceptedCapture!(f.commandScope))?.commandId,
      f.command.commandId,
    );
    assert.equal(f.journey.archives.size, 0);
  } finally {
    f.client.dispose();
  }
});

test("an unsettled original command holds private Done without clearing the saved take", async () => {
  const f = await fixture();
  try {
    await f.journal.reserve({
      version: 1,
      scope: f.commandScope,
      commandId: "pending-independent",
      subject: "original-unsettled",
      path: "reviews/other/withdraw",
      bodyJson: "{}",
    });
    await assert.rejects(
      createDancePreparationController(f.ports).closeTerminal(
        new AbortController().signal,
        f.expectation,
      ),
      /resolution_unproven/,
    );
    assert.equal(
      (await f.journal.active(f.commandScope))?.commandId,
      "pending-independent",
    );
    assert.equal(f.journey.archives.size, 0);
  } finally {
    f.client.dispose();
  }
});

test("lost archive acknowledgement retries the same private completion and preserves original history", async () => {
  const f = await fixture();
  try {
    const original = f.journey.store.exclusive.bind(f.journey.store);
    let lose = true;
    f.journey.store.exclusive = (s, g, use) =>
      original(s, g, (h) =>
        use({
          ...h,
          archive: async () => {
            await h.archive();
            if (lose) {
              lose = false;
              throw Error("fixture_archive_ack_lost");
            }
          },
        }),
      );
    await assert.rejects(
      createDancePreparationController(f.ports).closeTerminal(
        new AbortController().signal,
        f.expectation,
      ),
      /archive_ack_lost/,
    );
    assert.equal(
      (await f.journal.acceptedCapture!(f.commandScope))?.commandId,
      f.command.commandId,
    );
    await createDancePreparationController(f.ports).closeTerminal(
      new AbortController().signal,
      f.expectation,
    );
    assert.equal(
      (await f.journey.store.read(f.ports.scope, () => {})).capture,
      null,
    );
    assert.equal(f.journey.archives.size, 1);
    assert.ok(
      (await f.journal.command!(f.commandScope, f.command.commandId))
        ?.receiptJson,
    );
    assert.deepEqual(f.requests, ["/api/dance/captures"]);
  } finally {
    f.client.dispose();
  }
});

test("account loss during the private status read cannot clear the take or its original command", async () => {
  const f = await fixture();
  try {
    f.ports.media.status = async () => {
      f.lifetime(false);
      return f.status;
    };
    await assert.rejects(
      createDancePreparationController(f.ports).closeTerminal(
        new AbortController().signal,
        f.expectation,
      ),
      { message: "dance_session_changed" },
    );
    f.lifetime(true);
    assert.equal(
      (await f.journal.acceptedCapture!(f.commandScope))?.commandId,
      f.command.commandId,
    );
    assert.equal(f.journey.archives.size, 0);
  } finally {
    f.client.dispose();
  }
});

// Another tab completes A, then the real command/journey codecs accept ready B.
// The stale A view must never treat this current B as its completion identity.
async function replaceWithReadyTake(
  f: Awaited<ReturnType<typeof fixture>>,
  exclusive = f.journey.store.exclusive.bind(f.journey.store),
) {
  await f.journal.definiteCaptureReset(f.commandScope, {
    captureId: f.capture.captureId,
    keepUnrelated: true,
  });
  await exclusive(
    f.ports.scope,
    () => {},
    async (h) => {
      await h.archive();
      await h.save({
        capture: null,
        upload: null,
        commands: undefined,
        submission: "none",
        terminal: null,
      });
    },
  );
  const commandId = crypto.randomUUID(),
    body = JSON.parse(f.command.bodyJson);
  const nextCommand = {
    ...f.command,
    commandId,
    requestJson: JSON.stringify({ ...body, commandId }),
  };
  const { captureHash: _hash, consent: _consent, ...snapshot } = f.capture;
  snapshot.captureId = word(700);
  snapshot.reservedAtMs += 1000;
  snapshot.expiresAtMs += 1000;
  const hash = hashPrivateDanceCaptureV2(snapshot);
  const capture = {
    ...snapshot,
    captureHash: hash,
    consent: {
      ...f.capture.consent!,
      receiptId: commandId,
      captureId: snapshot.captureId,
      captureHash: hash,
      acceptedAtMs: snapshot.reservedAtMs + 1,
    },
  };
  await f.journal.reserve(nextCommand);
  await f.journal.markDispatch!(nextCommand);
  await f.journal.accept(nextCommand, JSON.stringify(capture));
  const status = mediaFixture(capture, "ab".repeat(32));
  status.id = "media-B";
  status.ready = { ...status.ready!, id: status.id };
  await exclusive(
    f.ports.scope,
    () => {},
    (h) =>
      h.save({
        capture,
        commands: { capture: nextCommand },
        upload: {
          requestId: "private-upload-B",
          recordingSha256: status.ready!.recordingSha256,
          bytes: 1000,
          mediaId: status.id,
          put: "acknowledged",
          status,
        },
      }),
  );
  f.ports.media.status = async (_capture, id) =>
    id === status.id ? status : f.status;
  return { capture, command: nextCommand, status };
}
for (const replace of ["before-click", "before-exclusive"] as const) {
  test(`stale private Done from displayed A preserves ready B: ${replace}`, async () => {
    const f = await fixture();
    try {
      const controller = createDanceReviewController(f.ports);
      const view = await controller.observe(new AbortController().signal);
      assert.equal(view.result.kind, "local_recording");
      const exclusive = f.journey.store.exclusive.bind(f.journey.store);
      let release!: () => void, entered!: () => void;
      const blocked = new Promise<void>((r) => {
          entered = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      if (replace === "before-exclusive")
        f.journey.store.exclusive = async (s, g, use) => {
          entered();
          await gate;
          return exclusive(s, g, use);
        };
      let b: Awaited<ReturnType<typeof replaceWithReadyTake>>;
      if (replace === "before-click")
        b = await replaceWithReadyTake(f, exclusive);
      const done = controller.finishPrivate(new AbortController().signal);
      const rejected = assert.rejects(
        done,
        /completion_changed|local_attempt_changed|original_command_changed/,
      );
      if (replace === "before-exclusive") {
        await blocked;
        b = await replaceWithReadyTake(f, exclusive);
        release();
      }
      await rejected;
      const kept = await f.journey.store.read(f.ports.scope, () => {});
      assert.equal(kept.capture?.captureId, b!.capture.captureId);
      assert.equal(kept.capture?.captureHash, b!.capture.captureHash);
      assert.equal(kept.upload?.mediaId, b!.status.id);
      assert.equal(f.journey.archives.has(b!.capture.captureId), false);
      assert.equal(
        (await f.journal.acceptedCapture!(f.commandScope))?.commandId,
        b!.command.commandId,
      );
      assert.equal(
        (await f.journal.command!(f.commandScope, b!.command.commandId))
          ?.receiptJson,
        JSON.stringify(b!.capture),
      );
      assert.deepEqual(f.requests, ["/api/dance/captures"]);
    } finally {
      f.client.dispose();
    }
  });
}
