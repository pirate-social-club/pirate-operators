/** UNRUN. Actual SQL/read services + authenticated route; account/media/chain
 * facts are the existing explicitly modeled SQLite fixture, not live evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { hashText } from "../packages/community/common.ts";
import { DanceProductionReads } from "../services/dance-production-reads.ts";
import { danceCommunityApi } from "../services/dance-community-api.ts";
import { captureProductionTarget, type DanceSelectedCatalogue } from "../services/dance-production.ts";
import { sqliteDanceFixture } from "./dance-sqlite-fixture.ts";
import { dh } from "./dance-fixture.ts";

function catalogueSimulation(f: ReturnType<typeof sqliteDanceFixture>): DanceSelectedCatalogue {
  return {
    songKeyForPost: () => dh(10),
    async list(communityId, accountId, songKey) {
      return { page: { version: "pirate.dance-catalogue/1", communityId, accountId,
        choices: [{ communityId, songKey, songRevision: 1, audioSha256: dh(3), reference: null,
          offerId: null, title: "Dance", durationMs: 10000, playback: "unavailable", recordingAllowed: false }],
        consent: { ...f.model.consent, text: "Simulation consent", admission: "review_pending" }, cursor: null },
        fence: { sql: "1", values: [] } };
    },
    select: (...args) => f.ports.admitCapture(...args),
    rules: c => f.ports.rules(c),
    songPostId: async () => dh(70) as `0x${string}`,
    guide: async c => ({ communityId: c.communityId, songKey: c.songKey,
      songRevision: c.songRevision, audioSha256: c.audioSha256, access: "public",
      playback_url: "https://community.invalid/api/public/posts/" + dh(70) + "/audio" }),
    reference: async () => { throw Error("No reference authority supplied in this simulation"); },
  };
}

test("stored-capture access executes exact SQL, rejects other owner, and rechecks revocation at final batch", async () => {
  const f = sqliteDanceFixture();
  try {
    const c = await f.capture();
    const reads = new DanceProductionReads(f.db.asD1(), f.ports, catalogueSimulation(f), dh(1));
    assert.deepEqual(await reads.captureAccess("learner", c.captureId), c);
    assert.ok(f.db.executed.some(sql => sql.includes("dance_captures c JOIN dance_consents")));
    await assert.rejects(reads.captureAccess("stranger", c.captureId), /dance_not_found/);
    f.db.beforeBatch = () => { f.model.principals.learner.active = false; };
    await assert.rejects(reads.captureAccess("learner", c.captureId));
    assert.equal(f.db.count("dance_captures"), 1);
  } finally { f.close(); }
});

test("historically accepted stored capture expires on server time without deleting original or creating commands", async () => {
  const f = sqliteDanceFixture();
  try {
    const original = await f.capture(), c = structuredClone(original), elapsed = 4 * 86400000;
    c.captureId = "historical_capture";
    c.reservedAtMs -= elapsed; c.expiresAtMs -= elapsed;
    c.consent = { ...c.consent!, captureId: c.captureId, acceptedAtMs: c.consent!.acceptedAtMs - elapsed };
    // A retained historical accepted row, not a new server admission today.
    const bytes = JSON.stringify({ ...c, consent: null });
    f.db.sqlite.prepare("INSERT INTO dance_captures VALUES(?,?,?,?,?,?)")
      .run(c.captureId, c.communityId, "learner", "historical_command", dh(89), bytes);
    f.db.sqlite.prepare("INSERT INTO dance_consents VALUES(?,?)").run(c.captureId, JSON.stringify(c.consent));
    const reads = new DanceProductionReads(f.db.asD1(), f.ports, catalogueSimulation(f), dh(1));
    await assert.rejects(reads.captureAccess("learner", c.captureId), /dance_capture_expired/);
    assert.equal(f.db.sqlite.prepare("SELECT capture_json FROM dance_captures WHERE capture_id=?").get(c.captureId)!.capture_json, bytes);
    assert.equal(f.db.count("dance_receipts"), 0);
  } finally { f.close(); }
});

test("actual latest SQL binds complete target and account; reads never create another command", async () => {
  const f = sqliteDanceFixture();
  try {
    const a = await f.pending();
    const b = await f.service.capture("learner", "capture_reference", {
      songKey: a.capture.songKey, referenceId: "reference_b", offerId: null,
    }, f.model.consent);
    const media = await f.addMedia(b);
    await f.service.submit("learner", "submit_reference", b.captureId, media.id, media.recordingSha256);
    const reads = new DanceProductionReads(f.db.asD1(), f.ports, catalogueSimulation(f), dh(1));
    const commands = f.db.count("dance_receipts");
    assert.equal((await reads.latest("learner", captureProductionTarget(a.capture)))?.reviewId, a.capture.captureId);
    assert.equal((await reads.latest("learner", captureProductionTarget(b)))?.reviewId, b.captureId);
    assert.equal(await reads.latest("learner2", captureProductionTarget(a.capture)), null);
    assert.equal(await reads.latest("learner", { ...captureProductionTarget(a.capture), songRevision: 2 }), null);
    assert.equal(await reads.latest("learner", { ...captureProductionTarget(a.capture), audioSha256: dh(99) }), null);
    assert.equal(f.db.count("dance_receipts"), commands);
    // Original accepted submission retry remains exact; no new outbox/media row.
    const receipt = await f.service.submit("learner", a.command, a.capture.captureId, a.media.id, a.media.recordingSha256);
    assert.equal(receipt.commandId, a.command);
    assert.equal(f.db.count("dance_receipts"), commands);
  } finally { f.close(); }
});

test("catalogue refuses cross-resource producer output and guide refuses fabricated public expiry/path", async () => {
  const f = sqliteDanceFixture();
  try {
    const c = await f.capture(), selected = catalogueSimulation(f);
    const reads = new DanceProductionReads(f.db.asD1(), f.ports, selected, dh(1));
    const valid = await reads.cataloguePage("learner", c.songKey, null);
    assert.equal(valid.choices[0].recordingAllowed, false);
    assert.equal(valid.consent.admission, "review_pending");
    const list = selected.list;
    selected.list = async (...args) => {
      const p = await list(...args); p.page.choices[0]!.songRevision = 0; return p;
    };
    await assert.rejects(reads.cataloguePage("learner", c.songKey, null));
    const grant = await reads.guide("learner", c.captureId, "https://community.invalid");
    assert.equal(grant.expires_at, undefined);
    selected.guide = async capture => ({ communityId: capture.communityId, songKey: capture.songKey,
      songRevision: capture.songRevision, audioSha256: capture.audioSha256, access: "public",
      playback_url: "https://other.invalid/api/public/posts/" + dh(70) + "/audio" });
    await assert.rejects(reads.guide("learner", c.captureId, "https://community.invalid"));
    f.model.validAuthorizations.delete(c.learner.authorizationId);
    await assert.rejects(reads.captureAccess("learner", c.captureId));
  } finally { f.close(); }
});

test("real accountSession route rejects absent session/account mismatch; no catalogue mount gives 503", async () => {
  const f = sqliteDanceFixture();
  try {
    f.db.sqlite.exec(`CREATE TABLE community_accounts(account_id TEXT PRIMARY KEY,author_id TEXT);
      CREATE TABLE credential_bindings(binding_id TEXT PRIMARY KEY,account_id TEXT,subject TEXT);
      CREATE TABLE community_sessions(session_hash TEXT,community_id TEXT,community_origin TEXT,
        account_id TEXT,binding_id TEXT,csrf_token TEXT,expires_at INTEGER);`);
    const token = "a".repeat(64), origin = "https://community.invalid";
    f.db.sqlite.prepare("INSERT INTO community_accounts VALUES(?,?)").run("learner", dh(90));
    f.db.sqlite.prepare("INSERT INTO credential_bindings VALUES(?,?,?)").run("binding", "learner", f.model.principals.learner.wallet);
    f.db.sqlite.prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
      .run(hashText(token), dh(1), origin, "learner", "binding", "csrf", Date.now() + 60000);
    const context = { communityId: dh(1) as `0x${string}`, origin };
    const ports = { db: f.db.asD1(), dance: f.ports, catalogue: catalogueSimulation(f) };
    const request = (account?: string, cookie = true) => new Request(origin + "/api/dance/catalogue?songKey=" + dh(10), {
      headers: { ...(cookie ? { cookie: "__Host-community_session=" + token } : {}),
        ...(account ? { "x-dance-account": account } : {}) },
    });
    await assert.rejects(danceCommunityApi(request(undefined, false), ports, context, new Headers()), /session_required/);
    await assert.rejects(danceCommunityApi(request("other"), ports, context, new Headers()), /dance_account_changed/);
    const response = await danceCommunityApi(request("learner"), ports, context, new Headers());
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("cache-control"), "no-store, private");
    assert.equal((await response?.json() as { accountId: string }).accountId, "learner");
    await assert.rejects(danceCommunityApi(request("learner"), { ...ports, catalogue: undefined }, context, new Headers()),
      /dance_production_catalogue_unavailable/);
  } finally { f.close(); }
});
