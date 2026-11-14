/** PREPARED, UNRUN. Actual SQLite statements and source3 adapter, modeled
 * canonical authority only. No Worker/provider/chain/device acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { DanceFence } from "../packages/dance/contracts.ts";
import type { MediaIntent, MediaRecord, PublishedMediaSong } from "../packages/community-media/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { MediaRepository } from "../packages/community-media/repository.ts";
import { MemorySqliteD1 } from "./dance-sqlite-fixture.ts";
import { danceFixture, dh } from "./dance-fixture.ts";
import {
  compactDanceFence, DanceSource3Bindings, DANCE_SOURCE3_BINDINGS_SCHEMA_PROPOSAL,
} from "../services/dance-source3-bindings.ts";

async function fixture(t: { after(fn: () => void): void }) {
  const db = new MemorySqliteD1(); t.after(() => db.close());
  db.sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF;");
  db.sqlite.exec(readFileSync(new URL("../packages/dance/schema.sql", import.meta.url), "utf8"));
  db.sqlite.exec(readFileSync(new URL("../packages/community-media/schema.sql", import.meta.url), "utf8"));
  db.sqlite.exec(DANCE_SOURCE3_BINDINGS_SCHEMA_PROPOSAL);
  const model = danceFixture(); model.store.time = Date.now();
  // The shared generic model emits expected.mediaEpoch=0 while its authority
  // reports mediaEpoch=1. This exact-admission fixture must capture the actual
  // modeled current epochs BEFORE capture commitment and consent are created.
  // Do not alter that shared model or make the production equality permissive.
  const modeledAdmission = model.ports.admitCapture;
  model.ports.admitCapture = async (community, actor, selection) => {
    const admitted = await modeledAdmission(community, actor, selection);
    const current = await model.ports.authority(community, actor, actor);
    assert.equal(current.owner.canonicalAccepted, true);
    return { ...admitted, capture: { ...admitted.capture, expected: {
      ownerEpoch: current.owner.epoch, ...structuredClone(current.epochs),
    } } };
  };
  db.sqlite.function("model_guard", key => Number(model.store.checks.get(String(key))?.() ?? false));
  const convert = (f: DanceFence): DanceFence => ({ sql: "model_guard(?)", values: [f.sql] });
  const ports = { ...model.ports,
    async authority(...args: Parameters<typeof model.ports.authority>) {
      const f = await model.ports.authority(...args); return { ...f, fence: convert(f.fence) };
    },
    rules: async (...args: Parameters<typeof model.ports.rules>) => convert(await model.ports.rules(...args)),
    authorization: async (...args: Parameters<typeof model.ports.authorization>) => convert(await model.ports.authorization(...args)),
  };
  const template = await model.service.capture("learner", "source3_original_capture",
    { songKey: dh(10), referenceId: null, offerId: null }, model.consent);
  const current = await model.ports.authority(template.communityId, "learner", "learner");
  assert.equal(current.owner.canonicalAccepted, true);
  assert.deepEqual(template.expected, { ownerEpoch: current.owner.epoch, ...current.epochs });
  const { captureHash, consent, ...committed } = template;
  assert.equal(captureHash, await model.ports.captureCommitment(committed));
  assert.equal(consent!.captureHash, captureHash);
  const store = new DanceStore(db.asD1());
  await store.reserveCapture({ ...template, consent: null }, "learner", "original", dh(90), []);
  const capture = await store.acceptConsent({ ...template, consent: null }, model.consent, "original", []);
  const bindings = new DanceSource3Bindings({ db: db.asD1(), communityId: capture.communityId,
    sourceHash: capture.source.sourceHash, dance: ports });
  const actor = { accountId: capture.learner.accountId };
  const intent: MediaIntent = { requestId: "original_recording_request", songKey: capture.songKey,
    songRevision: capture.songRevision, recordingSha256: "a".repeat(64), bytes: 12,
    startSample: capture.startSample, durationSamples: capture.durationSamples,
    purpose: "private-review", publicConsent: false };
  const song: PublishedMediaSong = { communityId: capture.communityId, songKey: capture.songKey,
    songRevision: capture.songRevision, audioSha256: capture.audioSha256.slice(2),
    durationSamples: capture.songDurationSamples, title: "Explicit local simulation" };
  const record: MediaRecord = { version: "pirate.community-media/1", id: crypto.randomUUID(),
    requestId: intent.requestId, revision: 1, state: "ready", purpose: "private-review", publicConsent: false,
    communityId: capture.communityId, accountId: actor.accountId, songKey: song.songKey,
    songRevision: song.songRevision, audioSha256: song.audioSha256, recordingSha256: intent.recordingSha256,
    startSample: intent.startSample, durationSamples: intent.durationSamples,
    mediaPolicyVersion: capture.mediaPolicyVersion, sourceBytes: intent.bytes,
    createdAt: Date.now(), uploadExpiresAt: Date.now() + 600000, expiresAt: Date.now() + 600000, attempts: 0 };
  const repository = new MediaRepository(db.asD1(), capture.communityId);
  return { db, model, capture, actor, intent, song, record, bindings, repository };
}

test("one-binding fence preserves >100 typed values, literals, null and final atomic refusal", async t => {
  const db = new MemorySqliteD1(); t.after(() => db.close());
  db.sqlite.exec("CREATE TABLE guard_values(n INTEGER PRIMARY KEY,v TEXT); INSERT INTO guard_values VALUES(1,'original');");
  const many: DanceFence = { sql: Array.from({ length: 120 }, () => "?=1").join(" AND "), values: Array(120).fill(1) };
  const guard = compactDanceFence([many, { sql: "? IS NULL AND ?='string?literal' AND ?=9007199254740991 AND EXISTS(SELECT 1 FROM guard_values WHERE v=?) /* ? */",
    values: [null, "string?literal", Number.MAX_SAFE_INTEGER, "original"] }]);
  assert.equal(guard.values.length, 1);
  assert.equal(await db.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.values).first<{ ok: number }>().then(r => r?.ok), 1);
  db.sqlite.exec("UPDATE guard_values SET v='changed'");
  assert.equal(await db.prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.values).first(), null);
  for (const sql of ["?1=1", ":named=1", "?=1 -- unterminated"])
    assert.throws(() => compactDanceFence([{ sql, values: [1] }]), /dance_source3_fence_parameters/);
  assert.throws(() => compactDanceFence([{ sql: "?=?", values: [1] }]), /dance_source3_fence_budget/);
});

test("original capture/request survives lost commit ACK and reserves exactly one canonical mediaId", async t => {
  const f = await fixture(t);
  f.db.afterBatch = () => { throw Error("simulated lost D1 acknowledgement"); };
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  assert.equal(f.db.count("dance_source3_requests"), 1);
  const fence = await f.bindings.reservation(f.actor, f.intent, f.song);
  assert.equal(fence.values.length, 1); // unchanged producer INSERT has 18 total binds
  const first = await f.repository.reserve(f.record, undefined, fence);
  const recovered = await f.repository.reserve({ ...f.record, id: crypto.randomUUID() }, undefined, fence);
  assert.equal(recovered.id, first.id);
  assert.equal(f.db.count("community_media"), 1);
  assert.equal(await f.bindings.preview(f.actor, first), true);
  await f.bindings.assertSubmission(first.id, f.capture.captureHash, "0x" + f.intent.recordingSha256);
});

test("same song/interval never repairs a foreign request, capture, account, digest or mediaId", async t => {
  const f = await fixture(t);
  await assert.rejects(f.bindings.reservation(f.actor, f.intent, f.song), /original_missing/);
  await assert.rejects(f.bindings.bindIntent(f.actor, f.capture.captureId, dh(999), f.intent), /capture_changed/);
  await assert.rejects(f.bindings.bindIntent({ accountId: "stranger" }, f.capture.captureId, f.capture.captureHash, f.intent), /capture_missing/);
  await assert.rejects(f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash,
    { ...f.intent, playbackUrl: "https://private.invalid/unverified" } as MediaIntent), /invalid_fields/);
  assert.equal(f.db.count("dance_source3_requests"), 0);
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  await assert.rejects(f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash,
    { ...f.intent, recordingSha256: "b".repeat(64) }), /original_conflict/);
  await assert.rejects(f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash,
    { ...f.intent, requestId: "second_request_same_capture" }), /retained/);
  const saved = await f.repository.reserve(f.record, undefined, await f.bindings.reservation(f.actor, f.intent, f.song));
  await assert.rejects(f.bindings.preview(f.actor, { ...saved, id: crypto.randomUUID() }), /media_changed/);
  await assert.rejects(f.bindings.assertSubmission(saved.id, dh(999), "0x" + f.intent.recordingSha256), /capture_changed/);
  await assert.rejects(f.bindings.reservation(f.actor, f.intent, { ...f.song, audioSha256: "b".repeat(64) }), /song_changed/);
  assert.equal(f.db.count("dance_source3_requests"), 1);
});

test("authority changes before accepting reserve, and erasure/withdrawal before preview, deny exact original", async t => {
  const f = await fixture(t);
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  const fence = await f.bindings.reservation(f.actor, f.intent, f.song);
  f.model.setOwner();
  await assert.rejects(f.repository.reserve(f.record, undefined, fence), /reservation_not_admitted/);
  assert.equal(f.db.count("community_media"), 0);
  await assert.rejects(f.bindings.reservation(f.actor, f.intent, f.song), /authority_changed|owner_epoch/);
});

test("preview requires the persisted ready revision; pending erasure and replace cannot clear original", async t => {
  const f = await fixture(t);
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  const saved = await f.repository.reserve(f.record, undefined, await f.bindings.reservation(f.actor, f.intent, f.song));
  assert.equal(await f.bindings.preview(f.actor, saved), true);
  // Simulate an independently committed withdrawal in the actual table. The
  // shared SQLite fixture's .run result is not D1's meta shape; this case tests
  // source3's stale-read fence, not the already-owned erasure implementation.
  const withdrawn = { ...saved, revision: saved.revision + 1, state: "withdrawn", erasePending: true };
  f.db.sqlite.prepare("UPDATE community_media SET revision=?,state='withdrawn',body=? WHERE id=? AND revision=?")
    .run(withdrawn.revision, JSON.stringify(withdrawn), saved.id, saved.revision);
  await assert.rejects(f.bindings.preview(f.actor, saved), /media_changed/);
  assert.throws(() => f.db.sqlite.prepare(`INSERT OR REPLACE INTO dance_source3_requests VALUES(?,?,?,?,?,?)`)
    .run(f.capture.communityId, f.actor.accountId, f.intent.requestId, f.capture.captureId, dh(999), JSON.stringify(f.intent)), /retained/);
  assert.equal(f.db.count("dance_source3_requests"), 1);
});

test("reference/resource lease and rule fences remain live in the actual producer INSERT", async t => {
  const f = await fixture(t);
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  const original = await f.bindings.reservation(f.actor, f.intent, f.song);
  f.db.sqlite.exec("CREATE TABLE actual_resource_guard(resource_id TEXT PRIMARY KEY,generation INTEGER,lease_until INTEGER);");
  f.db.sqlite.prepare("INSERT INTO actual_resource_guard VALUES(?,?,?)").run("exact_selected_resource", 7, Date.now() + 60000);
  const resource = compactDanceFence([original, {
    sql: "EXISTS(SELECT 1 FROM actual_resource_guard WHERE resource_id=? AND generation=? AND lease_until>?)",
    values: ["exact_selected_resource", 7, Date.now()],
  }]);
  // Explicit simulated local resource projection. Canonical/reference producer
  // owns this exact resource predicate; matching song metadata cannot replace it.
  f.db.sqlite.exec("UPDATE actual_resource_guard SET generation=8");
  await assert.rejects(f.repository.reserve(f.record, undefined, resource), /reservation_not_admitted/);
  assert.equal(f.db.count("community_media"), 0);
  f.model.setRules();
  await assert.rejects(f.repository.reserve(f.record, undefined, original), /reservation_not_admitted/);
});

test("Media2 original recording/request/account survive a capture-read await and independent callback mutation", async t => {
  const f = await fixture(t), actor = structuredClone(f.actor), intent = structuredClone(f.intent);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  f.db.beforeRead = async sql => {
    if (!sql.includes("SELECT c.capture_json")) return;
    f.db.beforeRead = null; enter(); await released;
  };
  const rules = f.model.ports.rules;
  f.model.ports.rules = async capture => {
    const fence = await rules(capture);
    capture.songRevision++; capture.expected.ownerEpoch = 99;
    capture.learner.knownAliases = ["callback_changed_alias"];
    return fence;
  };
  const pending = f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  await entered;
  f.actor.accountId = "caller_changed_private_account";
  f.intent.requestId = "caller_changed_request"; f.intent.recordingSha256 = "b".repeat(64); f.intent.songRevision++;
  release(); await pending;
  const saved = f.db.sqlite.prepare("SELECT account_id,request_id,intent_json FROM dance_source3_requests").get()!;
  assert.equal(saved.account_id, actor.accountId); assert.equal(saved.request_id, intent.requestId);
  assert.deepEqual(JSON.parse(String(saved.intent_json)), intent);
  assert.equal(f.db.count("dance_source3_requests"), 1);
  assert.equal(f.db.count("community_media"), 0); // No upload/new attempt inferred from recovery.
});

test("Media3 source3 still requires canonical owner acceptance and every exact captured epoch", async t => {
  const f = await fixture(t), authority = f.model.ports.authority;
  for (const mismatch of ["accepted", "ownerEpoch", "configurationRevision", "rulesEpoch", "mediaEpoch"] as const) {
    f.model.ports.authority = async (...args) => {
      const facts = await authority(...args);
      if (mismatch === "accepted") facts.owner.canonicalAccepted = false;
      else if (mismatch === "ownerEpoch") facts.owner.epoch++;
      else facts.epochs[mismatch]++;
      return facts;
    };
    await assert.rejects(f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent),
      /dance_source3_authority_changed/);
    assert.equal(f.db.count("dance_source3_requests"), 0);
  }
  f.model.ports.authority = authority;
  await f.bindings.bindIntent(f.actor, f.capture.captureId, f.capture.captureHash, f.intent);
  assert.equal(f.db.count("dance_source3_requests"), 1);
  const original = JSON.parse(String(f.db.sqlite.prepare("SELECT intent_json FROM dance_source3_requests").get()!.intent_json));
  assert.deepEqual(original, f.intent);
});
