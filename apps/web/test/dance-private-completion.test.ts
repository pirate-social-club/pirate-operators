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
    media: { ...model.ports.media, status: async () => status },
  };
  return {
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
    await createDanceReviewController(f.ports).finishPrivate(
      new AbortController().signal,
    );
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
      ),
      /archive_ack_lost/,
    );
    assert.equal(
      (await f.journal.acceptedCapture!(f.commandScope))?.commandId,
      f.command.commandId,
    );
    await createDancePreparationController(f.ports).closeTerminal(
      new AbortController().signal,
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
