
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { decodeAbiParameters, encodeAbiParameters } from "viem";
import { hashJson, hashText } from "../packages/community/common.ts";
import type { AccountSession } from "../packages/community/accounts.ts";
import { installedDancePublicationAction, readDanceV2PrivateRegistration, readInstalledDanceSubmissionStatus, type DancePublicationActionInput } from "../services/dance-publication-actions.ts";
import { danceCommand, danceConsentHash, danceMediaBinding, danceMediaId, danceRecordingBinding, danceRecordingReplay, danceSubmissionHash, danceSubmissionId } from "../packages/dance-chain/v2/wire.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import { DanceV2ActionStore, danceActionAcceptanceContext, danceDispatchSessionPin } from "../services/dance-v2-action-store.ts";
import { PublicationInstallation } from "../services/publication-installed-selection.ts";
import type { Web2PublicDanceInputs } from "../services/web2-public-dance-start.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";
import { danceCaptureV2Fixture } from "./fixtures/dance-capture-v2.ts";
import type { DanceV2Observation } from "../services/dance-v2-action-recovery.ts";
import { nativeDanceObservationTransport } from "../services/linux-web2-dance-retained-transport.ts";
import { nativeDanceObservationPath, nativeDanceResponse, readNativeDanceReference } from "../services/native-dance-retained-reference.ts";
import { publicationAcceptSessionHeader, publicationHostOrigin } from "../services/native-publication-reference.ts";
import type { CommunityPrivateDance } from "../services/community-private-dance.ts";
import { parseDanceCaptureV2, type PublicationCaptureV2 } from "../packages/dance/capture-v2.ts";

test("ordinary status requires the original accepting session before ready and preserves a dormant ready action", async t => {
  const local = new MemorySqliteD1();
  t.after(() => local.close());
  local.sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE dance_transaction_guards (guard_id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
    CREATE TABLE community_accounts(account_id TEXT PRIMARY KEY,author_id TEXT);
    CREATE TABLE credential_bindings(binding_id TEXT PRIMARY KEY, account_id TEXT, namespace TEXT, network INTEGER, subject TEXT);
    CREATE TABLE community_sessions(session_hash TEXT PRIMARY KEY, community_id TEXT, community_origin TEXT,
      account_id TEXT, binding_id TEXT, csrf_token TEXT, expires_at INTEGER);
    CREATE TABLE publication_v1_installed_selection(community_id TEXT,installation_id TEXT,community_origin TEXT,
      incarnation INTEGER, installed_binding_sha256 TEXT, selection_sha256 TEXT);
    CREATE TABLE dance_captures(community_id TEXT,capture_id TEXT,account_id TEXT,capture_json TEXT);
    CREATE TABLE dance_consents(capture_id TEXT,consent_json TEXT);
    CREATE TABLE community_media_submissions(community_id TEXT,submission_id TEXT,account_id TEXT,media_id TEXT,
      submitted_at_ms INTEGER,binding_commitment TEXT,deadline_ms INTEGER,media_revision INTEGER);
  `);
  const migration = new URL("../apps/community-wizard/infra/migrations/0023_dance_publication_dispatch.sql", import.meta.url);
  local.sqlite.exec(readFileSync(migration, "utf8"));
  const db = local.asD1(), store = new DanceV2ActionStore(db);
  const { bound, domain, pin } = danceCaptureV2Fixture();
  const author = hashText("author"), { accountId: account, wallet } = bound.learner;
  const publisher = ("0x" + "2".repeat(40)) as `0x${string}`;
  const communityId = bound.communityId, origin = "https://fixture.example";
  const expected = { communityId, origin, installationId: hashText("installation"), incarnation: "1",
    installedBindingSha256: hashText("binding"), selectionSha256: hashText("selection") };
  const installation = Object.assign(Object.create(PublicationInstallation.prototype), { db, expected }) as PublicationInstallation;
  const selection = { publication: { db, installation }, publisher } as unknown as Web2PublicDanceInputs;
  const { captureId, captureHash } = bound;
  const body = { commandId: "fixture-original", captureId, mediaId: "fixture-media", recordingSha256: hashText("recording") };
  const context = { communityId, origin }, deadline = Date.now() + 60_000;
  local.sqlite.prepare("INSERT INTO publication_v1_installed_selection VALUES(?,?,?,?,?,?)")
    .run(communityId, expected.installationId, origin, expected.incarnation, expected.installedBindingSha256, expected.selectionSha256);
  local.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?)").run(account, author);
  local.sqlite.prepare("INSERT INTO credential_bindings VALUES(?,?, 'moss',6343,?)").run("binding", account, wallet);
  const session = (cookie: string, csrf_token: string) => {
    const actor: AccountSession = { session_hash: hashText(cookie), account_id: account, binding_id: "binding",
      author_id: author, wallet, csrf_token, expires_at: deadline };
    local.sqlite.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
      .run(actor.session_hash, communityId, origin, account, actor.binding_id, actor.csrf_token, actor.expires_at);
    return actor;
  };
  const firstCookie = "a".repeat(64), otherCookie = "b".repeat(64);
  const first = session(firstCookie, "csrf_one"), other = session(otherCookie, "csrf_two");
  const mediaId = danceMediaId(domain, body.mediaId), generation = 2n;
  const binding = danceMediaBinding(domain, captureHash, mediaId, generation, body.recordingSha256);
  local.sqlite.prepare("INSERT INTO dance_captures VALUES(?,?,?,?)")
    .run(communityId, captureId, account, JSON.stringify(bound));
  const acceptedAt = bound.reservedAtMs + 10, submittedAt = acceptedAt + 10;
  const consentReceipt = {
    accepted: true as const, version: "fixture/1", termsHash: bound.termsHash, publicityPolicyHash: pin.publicityPolicyHash,
    receiptId: "fixture-consent", accountId: account, captureId, captureHash, acceptedAtMs: acceptedAt,
  };
  local.sqlite.prepare("INSERT INTO dance_consents VALUES(?,?)").run(captureId, JSON.stringify(consentReceipt));
  const mediaDeadline = submittedAt + 604800000;
  local.sqlite.prepare("INSERT INTO community_media_submissions VALUES(?,?,?,?,?,?,?,?)")
    .run(communityId, captureId, account, body.mediaId, submittedAt, binding, mediaDeadline, Number(generation));
  const original = store.original(communityId, captureId, "register", account, body);
  const baseContext = hashJson({ captureHash, binding, publisher });
  const acceptedContext = (s: AccountSession) => danceActionAcceptanceContext(baseContext, danceDispatchSessionPin(s));
  await store.reserve(original, acceptedContext(first), true).run();
  let observations = 0;
  const mustStayUnsent = async () => { observations++; throw Error("dormant observer"); };
  const status = (cookie: string, observer: DanceV2Observation | undefined = mustStayUnsent, requestId = body.commandId, target = captureId) =>
    readInstalledDanceSubmissionStatus({ context, selection, request: new Request(
      origin + "/api/dance/reviews/" + target + "/submission-status?" + new URLSearchParams({ requestId }),
      { headers: { cookie: "__Host-community_session=" + cookie, "x-dance-account": account } },
    ) }, async () => {}, observer);
  assert.deepEqual(await status(firstCookie), {
    version: "pirate.dance-action-status/1", requestId: body.commandId, actionId: original.command_id, state: "awaiting_chain_clock",
  });
  assert.equal((await status(otherCookie)).state, "held");
  await assert.rejects(status(otherCookie, mustStayUnsent, "foreign-request"), /dance_not_found/);
  assert.equal(observations, 0);

  const legacy = hashText("legacy capture");
  local.sqlite.prepare("INSERT INTO dance_captures VALUES(?,?,?,?)")
    .run(communityId, legacy, account, JSON.stringify({ captureHash }));
  local.sqlite.prepare("INSERT INTO community_media_submissions VALUES(?,?,?,?,?,?,?,?)")
    .run(communityId, legacy, account, body.mediaId, submittedAt, binding, mediaDeadline, Number(generation));
  await store.reserve(store.original(communityId, legacy, "register", account, { ...body, captureId: legacy }), baseContext, true).run();
  assert.equal((await status(firstCookie, mustStayUnsent, body.commandId, legacy)).state, "held");

  const saved = (await store.read(communityId, captureId, "register"))!;
  const [wire] = decodeAbiParameters([danceShapes.capture], bound.canonical.captureAbi);
  const consent = { accepted: true, acceptedAtMs: BigInt(acceptedAt), captureHash, termsSha256: bound.termsHash,
    publicityPolicyHash: pin.publicityPolicyHash } as const;
  const resource = danceSubmissionId(domain, wire.learner, wire.captureId);
  const deadlineMs = BigInt(mediaDeadline);
  const submission = {
      submissionId: resource, captureHash, consentHash: danceConsentHash(domain, consent),
      mediaBindingHash: binding, mediaIdCommitment: mediaId, mediaGeneration: generation,
      recordingReplayKey: danceRecordingReplay(domain, body.recordingSha256),
      recordingBindingHash: danceRecordingBinding(domain, body.recordingSha256, binding),
      trustedSubmittedAtMs: BigInt(submittedAt), reviewDeadlineMs: deadlineMs, mediaExpiresAtMs: deadlineMs,
  };
  const command = danceCommand(domain, "registerSubmission", publisher, original.command_id, {
    expectedOwnerEpoch: 7n, expectedConfigurationRevision: 99n, expectedRulesEpoch: 0n, expectedMediaEpoch: 0n,
    capture: wire, consent, recordingSha256: body.recordingSha256, submission,
  });
  const ready = { command_id: original.command_id, source_hash: bound.canonical.sourceHash, publisher,
    command_hash: command.hash, encoded: command.encoded, calldata: command.data, resource_id: resource };
  const prepareWithWitness = (actor: AccountSession) =>
    store.atomic([store.fence({ ...saved, context_sha256: acceptedContext(actor) })],
      [store.prepare(ready), store.prepareDispatchSession(ready, actor)]);
  await assert.rejects(prepareWithWitness(other), /dance_fence_changed/);
  assert.equal(await store.ready(original.command_id), null);
  await prepareWithWitness(first);
  assert.equal(await store.dispatchSessionPin(original.command_id), danceDispatchSessionPin(first));
  const result = await status(firstCookie);
  assert.deepEqual(result, {
    version: "pirate.dance-action-status/1", requestId: body.commandId, actionId: original.command_id, state: "held",
  });
  assert.equal(observations, 1, "the real ready preimage reaches the unavailable native observer");
  const submit = (cookie: string, csrf: string) => ({
    selection, context, body, runtime: { db, publicationV2: {}, source3: {} },
    request: new Request(origin + "/api/dance/reviews", { method: "POST", headers: {
      cookie: "__Host-community_session=" + cookie, "x-dance-account": account, "x-csrf-token": csrf, origin,
    } }),
  }) as unknown as DancePublicationActionInput;
  let dispatched = 0;
  const dispatch = async () => { dispatched++; };
  const check = async () => {};
  assert.equal((await installedDancePublicationAction(submit(firstCookie, first.csrf_token), check, undefined, dispatch)).state, "held");
  assert.equal((await installedDancePublicationAction(submit(firstCookie, first.csrf_token), check, mustStayUnsent, dispatch)).state, "held");
  assert.equal(observations, 2);
  const absence: DanceV2Observation = async () => ({ state: "awaiting_publisher" });
  assert.equal((await installedDancePublicationAction(submit(otherCookie, other.csrf_token), check, absence, dispatch)).state, "held");
  const forward = "c".repeat(64);
  let observed = 0;
  let nativeStatusCode = 202;
  const observeTransport = nativeDanceObservationTransport({
    chainId: 6343, communityId, publisher, verifier: domain.verifier,
    sourceHash: bound.canonical.sourceHash, installationId: expected.installationId, releaseSha256: hashText("release"),
  }, forward, {
    async fetch(input) {
      const request = new Request(input);
      observed++;
      assert.equal(request.url, publicationHostOrigin + nativeDanceObservationPath);
      assert.equal(request.headers.get("authorization"), "Bearer " + forward);
      assert.equal(request.headers.get(publicationAcceptSessionHeader), null);
      const ref = await readNativeDanceReference(request);
      assert.equal(ref.original.commandId, original.command_id);
      const valid = nativeDanceResponse(ref, dispatched
        ? { state: "retained_unsent", transactionHash: hashText("verified transaction") }
        : { state: "awaiting_publisher" });
      return new Response(valid.body, { status: nativeStatusCode, headers: valid.headers });
    },
  });
  assert.deepEqual(await installedDancePublicationAction(submit(firstCookie, first.csrf_token), check, observeTransport, dispatch), result);
  assert.equal(observed, 1);
  assert.equal(dispatched, 0);
  assert.equal(await store.dispatchSessionPin(original.command_id), danceDispatchSessionPin(first));
  assert.deepEqual({ ...await store.ready(original.command_id) }, ready);
  nativeStatusCode = 200;
  const submitted = await installedDancePublicationAction(submit(firstCookie, first.csrf_token), check, observeTransport, dispatch);
  assert.equal(dispatched, 1);
  assert.equal(observed, 3);
  assert.deepEqual(submitted, { ...result, state: "retained_unsent" });
  const observedAgain = await installedDancePublicationAction(submit(firstCookie, first.csrf_token), check,
    async () => ({ state: "retained_unsent", transactionHash: hashText("verified transaction") }), dispatch);
  assert.deepEqual(observedAgain, submitted);
  assert.equal(dispatched, 1);
  assert.equal(local.count("dance_v2_ready_commands"), 1);

  // The distinct reviewer verifies the learner's original registration. It
  // reads the immutable pin from the ready row even after the learner logs out.
  local.sqlite.exec("DELETE FROM community_sessions");
  const anchor = { number: 20n, hash: hashText("review block"), timestamp: 1_800_000_001n, transactions: [] };
  const reviewerSelection = {
    ...selection, source: { domain, sourceHash: bound.canonical.sourceHash },
    publication: { db, client: {
      async readContract({ functionName, blockHash, requireCanonical }: { functionName: string; blockHash: string; requireCanonical: boolean }) {
        assert.equal(blockHash, anchor.hash);
        assert.equal(requireCanonical, true);
        if (functionName === "registrationOf")
          return [bound.canonical.captureAbi, encodeAbiParameters([danceShapes.submission], [submission]), danceSubmissionHash(domain, submission)];
        if (functionName === "media") return [1n, true];
        assert.equal(functionName, "commandReceipts");
        return [command.hash, command.operation, resource, 1n];
      },
    } },
  } as unknown as Web2PublicDanceInputs;
  const media = { id: body.mediaId, communityId, accountId: account, state: "ready", purpose: "private-review",
    submissionId: captureId, readyAt: submittedAt, rendition: {}, revision: Number(generation),
    expiresAt: mediaDeadline, submissionBindingCommitment: binding, recordingSha256: body.recordingSha256.slice(2) };
  const runtime = { media: {
    ports: { repository: { db, communityId, async get(id: string) { assert.equal(id, body.mediaId); return media; } } },
    async usable(value: unknown) { assert.equal(value, media); },
  } } as unknown as CommunityPrivateDance;
  const capture = parseDanceCaptureV2({ ...bound, consent: consentReceipt }) as PublicationCaptureV2;
  const review = await readDanceV2PrivateRegistration(reviewerSelection, runtime, capture, store);
  assert.equal(review.registered.command.hash, command.hash);
  assert.equal(await review.verifyRegistration(anchor, check), 1n);
});
