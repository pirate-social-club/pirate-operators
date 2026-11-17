import { createDancePreparationController } from "../src/dance/source/dance-preparation-controller.ts";
import {
  simulatedSource,
  simulatedJourneyStore,
} from "./dance-source-fixtures.ts";
/** Actual browser client/command codec; HTTP and storage transport are named
 * simulations. Native D1/R2 mounted-route acceptance is qualified separately. */
import test from "node:test";
import assert from "node:assert/strict";
import { createDanceClient } from "../src/dance/client.ts";
import {
  assertCapture,
  captureTarget,
  danceTargetKey,
} from "../src/dance/source/ports.ts";
import {
  decodeJourney,
  emptyJourney,
} from "../src/dance/source/journey-store.ts";
import { simulatedCommandStorage } from "./dance-command-storage.ts";
import { danceCaptureV2Fixture } from "../../../test/fixtures/dance-capture-v2.ts";
function fixture() {
  const f = danceCaptureV2Fixture(),
    c = f.privateCapture;
  const capture = {
      ...c,
      consent: {
        accepted: true as const,
        version: "private-fixture/2",
        termsHash: c.termsHash,
        publicityPolicyHash: f.pin.publicityPolicyHash,
        receiptId: "original-capture-command",
        accountId: c.learner.accountId,
        captureId: c.captureId,
        captureHash: c.captureHash,
        acceptedAtMs: c.reservedAtMs + 1,
      },
    },
    target = captureTarget(capture);
  const scope = {
    ...target,
    sessionKey: "private-session",
    profileLabel: "Your profile",
  };
  const policy = {
    accepted: true as const,
    version: capture.consent!.version,
    termsHash: capture.consent!.termsHash,
    publicityPolicyHash: capture.consent!.publicityPolicyHash,
  };
  const commandScope = {
      communityId: target.communityId,
      accountId: target.accountId,
    },
    journal = simulatedCommandStorage().journal();
  const captureProfile = {
    version: "pirate.dance-capture-request/2" as const,
    target: {
      communityId: target.communityId,
      songKey: target.songKey,
      songRevision: target.songRevision,
      audioSha256: target.audioSha256,
      reference: target.reference,
      offerId: target.offerId,
    },
    publication: { kind: "private" as const },
  };
  return {
    capture,
    scope,
    target,
    policy,
    journal,
    commandScope,
    captureProfile,
  };
}
test("private profile persists its exact V2 target/mode before dispatch and accepts the real private DTO", async () => {
  const f = fixture(),
    sent: string[] = [];
  const client = createDanceClient({
    ...f.commandScope,
    csrf: "private-csrf",
    isCurrent: () => true,
    journal: f.journal,
    captureProfile: f.captureProfile,
    fetcher: async (_url, init) => {
      sent.push(String(init?.body));
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ...f.capture,
        consent: { ...f.capture.consent!, receiptId: body.commandId },
      });
    },
  });
  const command = await client.prepareCapture!(
    danceTargetKey(f.scope),
    f.target.songKey,
    f.target.offerId,
    f.target.reference?.id ?? null,
    f.policy,
  );
  assert.deepEqual(JSON.parse(command.requestJson!), {
    version: "pirate.dance-capture-request/2",
    target: f.captureProfile.target,
    publication: { kind: "private" },
    consent: f.policy,
    commandId: command.commandId,
  });
  assert.equal(sent.length, 0);
  const capture = (await client.dispatchPrepared!(command)) as typeof f.capture;
  assertCapture(capture, f.target);
  assert.equal(capture.publication.kind, "private");
  assert.equal(sent[0], command.requestJson);
  client.dispose();
});
test("private V2 remains a private journey snapshot across reload", () => {
  const f = fixture();
  assertCapture(f.capture, f.target);
  const stored = decodeJourney(
    { ...emptyJourney(f.scope), capture: f.capture },
    f.scope,
  );
  assert.equal(stored.capture?.version, "pirate.dance/2");
  assert.equal("authorizationId" in stored.capture!.learner, false);
  assert.throws(
    () =>
      assertCapture(
        { ...f.capture, songRevision: f.capture.songRevision + 1 },
        f.target,
      ),
    /target|binding|hash/,
  );
});
test("lost private capture reply retains original bytes across profile mutation and reload", async () => {
  const f = fixture(),
    bodies: string[] = [];
  let lose = true;
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    if (lose) {
      lose = false;
      throw new TypeError("fixture_lost_reply");
    }
    const body = JSON.parse(String(init?.body));
    return Response.json({
      ...f.capture,
      consent: { ...f.capture.consent!, receiptId: body.commandId },
    });
  };
  const make = () =>
    createDanceClient({
      ...f.commandScope,
      csrf: "private-csrf",
      isCurrent: () => true,
      journal: f.journal,
      captureProfile: f.captureProfile,
      fetcher,
    });
  const first = make(),
    command = await first.prepareCapture!(
      danceTargetKey(f.scope),
      f.target.songKey,
      f.target.offerId,
      f.target.reference?.id ?? null,
      f.policy,
    );
  f.captureProfile.target.songRevision++;
  await assert.rejects(first.dispatchPrepared!(command));
  first.dispose();
  const reloaded = make();
  await reloaded.recover();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], command.requestJson);
  assert.equal(bodies[1], bodies[0]);
  assert.equal(
    JSON.parse(bodies[1]).target.songRevision,
    f.capture.songRevision,
  );
  reloaded.dispose();
});
test("private practice cannot stage or send a public review command", async () => {
  const f = fixture();
  let sends = 0;
  const client = createDanceClient({
    ...f.commandScope,
    csrf: "private-csrf",
    isCurrent: () => true,
    journal: f.journal,
    captureProfile: f.captureProfile,
    fetcher: async () => {
      sends++;
      throw Error("must_not_send");
    },
  });
  await assert.rejects(
    client.prepareSubmission!(
      danceTargetKey(f.scope),
      f.capture.captureId,
      "media-private",
      "0x" + "ab".repeat(32),
    ),
    /private_recording_not_public/,
  );
  await assert.rejects(
    client.submit(f.capture.captureId, "media-private", "0x" + "ab".repeat(32)),
    /private_recording_not_public/,
  );
  assert.equal(await f.journal.active(f.commandScope), null);
  assert.equal(sends, 0);
  client.dispose();
});
test("a V2 server refusal retains one original request without V1 fallback", async () => {
  const f = fixture(),
    bodies: Record<string, unknown>[] = [];
  const client = createDanceClient({
    ...f.commandScope,
    csrf: "private-csrf",
    isCurrent: () => true,
    journal: f.journal,
    captureProfile: f.captureProfile,
    fetcher: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        { error: "fixture_profile_unavailable" },
        { status: 503 },
      );
    },
  });
  await assert.rejects(
    client.capture(
      f.target.songKey,
      f.target.offerId,
      f.target.reference?.id ?? null,
      f.policy,
    ),
  );
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].version, "pirate.dance-capture-request/2");
  assert.deepEqual(bodies[0].publication, { kind: "private" });
  assert.ok(await f.journal.active(f.commandScope));
  client.dispose();
});

test("the existing preparation controller accepts explicit private mode and persists its original command before transport", async () => {
  const f = fixture(),
    model = simulatedSource(),
    journey = simulatedJourneyStore(),
    requests: string[] = [];
  const client = createDanceClient({
    ...f.commandScope,
    csrf: "private-csrf",
    isCurrent: () => true,
    journal: f.journal,
    captureProfile: f.captureProfile,
    fetcher: async (_url, init) => {
      const stored = await journey.store.read(f.scope, () => {});
      assert.equal(stored.captureUnknown, true);
      assert.ok(stored.commands?.capture);
      requests.push(String(init?.body));
      const request = JSON.parse(String(init?.body));
      return Response.json({
        ...f.capture,
        consent: { ...f.capture.consent!, receiptId: request.commandId },
      });
    },
  });
  const source = {
    ...model.ports,
    scope: f.scope,
    currentScope: () => f.scope,
    client,
    journal: journey.store,
    consent: {
      ...f.policy,
      text: "Private fixture terms",
      admission: "admitted" as const,
    },
    nowMs: () => f.capture.reservedAtMs + 100,
  };
  const controller = createDancePreparationController(source);
  const result = await controller.start(
    f.policy.termsHash,
    new AbortController().signal,
  );
  assert.equal(result.kind, "capture_ready");
  assert.equal(result.session?.capture.version, "pirate.dance/2");
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0]).publication.kind, "private");
  const saved = await journey.store.read(f.scope, () => {});
  assert.equal(saved.captureUnknown, false);
  assert.equal(saved.submission, "none");
  client.dispose();
});
