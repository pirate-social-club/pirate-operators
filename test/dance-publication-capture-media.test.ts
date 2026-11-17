// Real D1 capture acceptance. Scripted RPC only for the retained grant fixture.
// Normal HTTP/media journey cases join this same file as their callers land.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import { hashJson } from "../packages/community/common.ts";
import { DanceStore } from "../packages/dance/store.ts";
import {
  hashPrivateDanceCaptureV2,
  parseDanceCaptureV2,
} from "../packages/dance/capture-v2.ts";
import type {
  PrivateCaptureV2,
  PublicationCaptureV2,
} from "../packages/dance/capture-v2.ts";
import {
  danceCaptureHash,
  danceSourceHash,
} from "../packages/dance-chain/v2/wire.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import { appDatabase } from "./fixtures/publication-app-http.ts";
import { danceCaptureV2Fixture, word } from "./fixtures/dance-capture-v2.ts";
import { journalFixture } from "./dance-publication-journal-fixture.ts";

const bound = { timeout: 30000 };
async function privateFixture(t: TestContext) {
  const database = await appDatabase();
  t.after(() => database.runtime.dispose());
  const store = new DanceStore(database.db),
    f = danceCaptureV2Fixture();
  const {
    captureHash: _hash,
    consent: _receipt,
    ...snapshot
  } = f.privateCapture;
  snapshot.reservedAtMs = (await store.now()) - 10;
  snapshot.expiresAtMs = snapshot.reservedAtMs + 60000;
  const capture: PrivateCaptureV2 = {
    ...snapshot,
    captureHash: hashPrivateDanceCaptureV2(snapshot),
    consent: null,
  };
  await database.db.batch([
    database.db
      .prepare("INSERT INTO application_identity VALUES(1,?,?)")
      .bind(capture.communityId, "https://dance-fixture.invalid"),
    database.db
      .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
      .bind(capture.learner.accountId, word(101), snapshot.reservedAtMs),
    database.db
      .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
      .bind(
        "private-binding",
        capture.learner.accountId,
        "moss",
        6343,
        capture.learner.wallet,
        snapshot.reservedAtMs,
      ),
  ]);
  const fence = {
    sql: "EXISTS(SELECT 1 FROM credential_bindings WHERE binding_id=? AND account_id=? AND subject=?)",
    values: [
      "private-binding",
      capture.learner.accountId,
      capture.learner.wallet,
    ],
  };
  const acceptance = {
    accepted: true as const,
    version: "dance-private-fixture/2",
    termsHash: capture.termsHash,
    publicityPolicyHash: f.pin.publicityPolicyHash,
  };
  return { ...database, store, capture, fence, acceptance };
}
const count = async (db: D1Database, table: string) =>
  Number(await db.prepare("SELECT count(*) AS n FROM " + table).first("n"));

test(
  "legacy capture reader refuses a persisted V2 capture instead of treating it as V4 authority",
  bound,
  async (t) => {
    const f = await privateFixture(t),
      c = f.capture;
    await f.db
      .prepare("INSERT INTO dance_captures VALUES(?,?,?,?,?,?)")
      .bind(
        c.captureId,
        c.communityId,
        c.learner.accountId,
        "original",
        word(102),
        JSON.stringify(c),
      )
      .run();
    await assert.rejects(f.store.capture(c.captureId), /dance_capture_version/);
    assert.equal(await count(f.db, "dance_captures"), 1);
  },
);

test(
  "private capture reservation and separate media consent persist without a public command",
  bound,
  async (t) => {
    const f = await privateFixture(t),
      c = f.capture,
      request = word(103);
    assert.equal(await count(f.db, "publication_v1_commands"), 0);
    await f.store.reserveCaptureV2(
      c,
      c.learner.accountId,
      "private-original",
      request,
      [f.fence],
      { kind: "private" },
    );
    assert.equal((await f.store.storedCapture(c.captureId)).consent, null);
    const accepted = await f.store.acceptConsentV2(
      c,
      f.acceptance,
      "private-original",
      [f.fence],
    );
    assert.ok(accepted.consent);
    assert.ok(accepted.consent.acceptedAtMs >= c.reservedAtMs);
    assert.ok(accepted.consent.acceptedAtMs < c.expiresAtMs);
    const reloaded = new DanceStore(f.db);
    assert.deepEqual(
      await reloaded.findStoredCapture(
        c.communityId,
        c.learner.accountId,
        "private-original",
        request,
      ),
      accepted,
    );
    assert.deepEqual(
      await reloaded.acceptConsentV2(c, f.acceptance, "private-original", [
        f.fence,
      ]),
      accepted,
    );
    assert.equal(await count(f.db, "dance_captures"), 1);
    assert.equal(await count(f.db, "dance_consents"), 1);
    assert.equal(await count(f.db, "publication_v1_commands"), 0);
    await assert.rejects(
      reloaded.findStoredCapture(
        c.communityId,
        c.learner.accountId,
        "private-original",
        word(104),
      ),
      /idempotency/,
    );
  },
);

test(
  "private capture credential loss at the accepting batch leaves no capture or publication work",
  bound,
  async (t) => {
    const f = await privateFixture(t),
      c = f.capture,
      gate = f.holdMutation("INSERT INTO dance_captures");
    const pending = f.store.reserveCaptureV2(
      c,
      c.learner.accountId,
      "private-race",
      word(105),
      [f.fence],
      { kind: "private" },
    );
    const rejected = assert.rejects(
      pending,
      /dance_fence_changed|CHECK constraint failed/,
    );
    try {
      await gate.entered;
      await f.native
        .prepare(
          "DELETE FROM credential_bindings WHERE binding_id='private-binding'",
        )
        .run();
    } finally {
      gate.release();
    }
    await rejected;
    assert.equal(await count(f.db, "dance_captures"), 0);
    assert.equal(await count(f.db, "publication_v1_commands"), 0);
  },
);

test(
  "wrong media consent cannot poison the immutable consent row",
  bound,
  async (t) => {
    const f = await privateFixture(t),
      c = f.capture;
    await f.store.reserveCaptureV2(
      c,
      c.learner.accountId,
      "private-consent",
      word(106),
      [f.fence],
      { kind: "private" },
    );
    await assert.rejects(
      f.store.acceptConsentV2(
        c,
        { ...f.acceptance, termsHash: word(107) },
        "private-consent",
        [f.fence],
      ),
      /consent/,
    );
    assert.equal(await count(f.db, "dance_consents"), 0);
    assert.ok(
      (
        await f.store.acceptConsentV2(c, f.acceptance, "private-consent", [
          f.fence,
        ])
      ).consent,
    );
  },
);

async function boundFixture(t: TestContext) {
  const f = await journalFixture(t),
    j = await f.journal(),
    wire = f.capture();
  wire.referenceSelection = {
    ...wire.referenceSelection,
    startSample: 0n,
    durationSamples: 288000n,
  };
  const plan = await j.prepareCapture(f.request(wire)),
    b = plan.grant.binding;
  const prototype = danceCaptureV2Fixture(),
    domain = {
      chainId: BigInt(b.source.chainId),
      verifier: b.grant.publicationTarget,
      communityId: b.source.communityId,
    };
  const pin = {
    ...prototype.pin,
    directory: b.source.directory,
    directoryRuntimeHash: b.source.directoryRuntimeHash,
    consentRegistry: b.source.registry,
    consentRegistryRuntimeHash: b.source.registryRuntimeHash,
    posts: wire.song.posts,
    runtimeCodeHash: b.grant.publicationTargetRuntimeHash,
    learnerConsentPolicyHash: b.grant.policyHash,
    rulesSha256: wire.rulesSha256,
    termsSha256: wire.termsSha256,
    rubricSha256: wire.rubricSha256,
    mediaPolicySha256: wire.mediaPolicySha256,
  };
  const c: PublicationCaptureV2 = {
    ...prototype.bound,
    captureId: wire.captureId,
    communityId: b.source.communityId,
    learner: { accountId: plan.grant.accountId, wallet: b.grant.learner },
    songKey: songKeyOf({ ...wire.song, chainId: b.source.chainId }),
    songRevision: Number(wire.song.revision),
    manifestSha256: wire.song.manifestSha256,
    audioSha256: wire.song.audioSha256,
    startSample: 0,
    durationSamples: 288000,
    reference: null,
    offer: null,
    rulesHash: wire.rulesSha256,
    termsHash: wire.termsSha256,
    rubricHash: wire.rubricSha256,
    mediaPolicyHash: wire.mediaPolicySha256,
    reservedAtMs: Number(wire.reservedAtMs),
    expiresAtMs: Number(wire.reservedAtMs) + 60000,
    expected: {
      ownerEpoch: "7",
      configurationRevision: "1",
      rulesEpoch: "1",
      mediaEpoch: "1",
    },
    publication: {
      kind: "publication-bound",
      publicationCommandId: f.command.commandId,
      binding: b,
    },
    canonical: {
      encoding: "pirate.dance-capture-abi/2",
      domain: {
        chainId: String(domain.chainId),
        verifier: domain.verifier,
        communityId: domain.communityId,
      },
      sourceHash: danceSourceHash(domain, pin),
      sourcePinAbi: encodeAbiParameters([danceShapes.sourcePin], [pin]),
      captureAbi: encodeAbiParameters([danceShapes.capture], [wire]),
    },
    captureHash: danceCaptureHash(domain, wire),
    consent: null,
  };
  parseDanceCaptureV2(c, false);
  return { ...f, plan, capture: c, store: new DanceStore(f.db) };
}

test(
  "original public binding and actual capture INSERT commit in one D1 batch",
  bound,
  async (t) => {
    const f = await boundFixture(t),
      c = f.capture;
    await f.store.reserveCaptureV2(
      c,
      c.learner.accountId,
      "bound-original",
      word(108),
      f.plan.fences,
      { kind: "publication-bound", bindingPlan: f.plan },
    );
    assert.equal(await count(f.db, "dance_captures"), 1);
    assert.equal(await count(f.db, "dance_publication_bindings"), 1);
    assert.deepEqual(await f.store.storedCapture(c.captureId), c);
    assert.equal(f.f.store().get("op:nonce"), 1);
  },
);

test(
  "actual capture write failure rolls back its original public binding",
  bound,
  async (t) => {
    const f = await boundFixture(t),
      c = f.capture;
    await f.db
      .prepare(
        "CREATE TRIGGER fixture_capture_write_failure BEFORE INSERT ON dance_captures BEGIN SELECT RAISE(ABORT,'fixture_capture_write_failure'); END",
      )
      .run();
    await assert.rejects(
      f.store.reserveCaptureV2(
        c,
        c.learner.accountId,
        "bound-rollback",
        word(109),
        f.plan.fences,
        { kind: "publication-bound", bindingPlan: f.plan },
      ),
      /fixture_capture_write_failure/,
    );
    assert.equal(await count(f.db, "dance_captures"), 0);
    assert.equal(await count(f.db, "dance_publication_bindings"), 0);
    assert.equal(f.f.store().get("op:nonce"), 1);
  },
);

test(
  "a substituted local publication command cannot borrow a valid original binding plan",
  bound,
  async (t) => {
    const f = await boundFixture(t),
      c = f.capture;
    const changed = {
      ...c,
      publication: { ...c.publication, publicationCommandId: word(110) },
    };
    await assert.rejects(
      f.store.reserveCaptureV2(
        changed,
        c.learner.accountId,
        "bound-changed",
        word(111),
        f.plan.fences,
        { kind: "publication-bound", bindingPlan: f.plan },
      ),
      /dance_v2_capture_join/,
    );
    assert.equal(await count(f.db, "dance_captures"), 0);
    assert.equal(await count(f.db, "dance_publication_bindings"), 0);
  },
);
