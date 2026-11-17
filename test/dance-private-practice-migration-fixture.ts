/** Test-only existing Alchemy executor + actual local D1. Cache metadata and
 * capture inputs below are explicitly OFFLINE server fixtures, not evidence of
 * a verified Directory read, account permission, selected source or live media. */
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { ownerMigrationRecords, applyOwnerMigrationRecords, ownerMigrationLedger, migrationSha } from "./owner-publishing-migration-fixture.ts";
import { canonical, hashText } from "../packages/community/common.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { DANCE_PRIVATE_MEDIA_POLICY, type DanceFence } from "../packages/dance/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { hashPrivateDanceCaptureV2, parseDanceCaptureV2 } from "../packages/dance/capture-v2.ts";
import { danceCaptureV2Fixture, word } from "./fixtures/dance-capture-v2.ts";
import { DanceSource3Bindings } from "../services/dance-source3-bindings.ts";
import type { DancePrivatePolicyV2 } from "../services/dance-private-catalogue.ts";
import type { MediaIntent } from "../packages/community-media/contracts.ts";

export async function privatePracticeFixture() {
  const runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('local private migration fixture')}}",
    compatibilityDate: "2026-08-06", d1Databases: ["DB"] });
  try {
    const native = await runtime.getD1Database("DB"), db = native as unknown as D1Database;
    const base = "apps/community-wizard/infra/migrations/";
    const names = (await readdir(new URL("../" + base, import.meta.url))).filter(name => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 22).sort();
    assert.deepEqual(names.map(name => Number(name.slice(0, 4))), Array.from({ length: 22 }, (_, i) => i + 1));
    const records = await ownerMigrationRecords(names.map(name => base + name));
    const document = JSON.parse(await readFile(new URL("../docs/deployments/first-song-managed-20261105.configuration.json", import.meta.url), "utf8"));
    const config = validateConfig(document.configuration), shape = danceCaptureV2Fixture(), legacy = shape.legacy;
    const terms = "Offline fixture private Dance media acceptance";
    const policy: DancePrivatePolicyV2 = { version: "pirate.dance-private-policy/2", configurationRevision: config.configurationRevision,
      rulesEpoch: 0, mediaEpoch: 0, captureTtlMs: 60000,
      consent: { version: "private-migration-fixture/2", termsHash: hashText(terms), publicityPolicyHash: word(13), text: terms, admission: "admitted" },
      rulesDocument: "Offline private practice rules", rubricText: "Offline categorical review rubric", mediaPolicyDocument: canonical(DANCE_PRIVATE_MEDIA_POLICY) };
    const apply = (through: 21 | 22) => applyOwnerMigrationRecords(db, records.slice(0, through));
    const ledger = () => ownerMigrationLedger(db);
    const configJson = canonical(config);
    // Only this explicitly simulated test producer populates cache evidence.
    // The production preparePrivateDanceState service MUST never write it.
    async function seedVerifiedConfiguration(revision = config.configurationRevision) {
      const value = revision === config.configurationRevision ? config : { ...config, configurationRevision: revision };
      const bytes = canonical(value);
      await db.batch([
        db.prepare("INSERT INTO application_identity SELECT 1,?,? WHERE NOT EXISTS(SELECT 1 FROM application_identity WHERE id=1)").bind(config.communityId, config.app.origin),
        db.prepare("INSERT INTO public_configurations VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(config.communityId, revision, config.publisher, "ipfs://offline-fixture-configuration", hashText(bytes), bytes, "1", word(70), word(71)),
      ]);
    }
    async function seedRetained() {
      const account = shape.legacy.learner.accountId;
      await db.batch([
        db.prepare("INSERT INTO community_accounts VALUES(?,?,10)").bind(account, word(72)),
        db.prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,10)").bind("fixture-credential", account, shape.legacy.learner.wallet),
        db.prepare("INSERT INTO learning_settings VALUES(?,100,100,NULL)").bind(account),
        db.prepare("INSERT INTO community_sessions(session_hash,community_id,community_origin,account_id,binding_id,csrf_token,expires_at) VALUES(?,?,?,?,?,?,?)")
          .bind("a".repeat(64), config.communityId, config.app.origin, account, "fixture-credential", "b".repeat(64), Date.now() + 60000),
        db.prepare("INSERT INTO dance_captures VALUES(?,?,?,?,?,?)").bind(legacy.captureId, legacy.communityId, account, "retained-v1-command", word(73), JSON.stringify(legacy)),
        db.prepare("INSERT INTO dance_consents VALUES(?,?)").bind(legacy.captureId, JSON.stringify(shape.receipt(legacy))),
      ]);
    }
    const retained = async () => Promise.all(["community_accounts", "credential_bindings", "community_sessions", "learning_settings", "dance_captures", "dance_consents"].map(async table =>
      (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
    function observed(afterRead?: () => void | Promise<void>, beforeBatch?: () => void | Promise<void>) {
      const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
      function statement(raw: D1PreparedStatement): D1PreparedStatement {
        const proxy = new Proxy(raw, { get(t, key) {
          if (key === "bind") return (...values: unknown[]) => statement(t.bind(...values));
          if (["first", "all", "raw"].includes(String(key))) return async (...args: unknown[]) => {
            const value = await Reflect.apply(Reflect.get(t, key), t, args); await afterRead?.(); return value;
          };
          const value = Reflect.get(t, key); return typeof value === "function" ? value.bind(t) : value;
        } });
        originals.set(proxy, raw); return proxy;
      }
      let fired = false;
      return new Proxy(db, { get(t, key) {
        if (key === "prepare") return (sql: string) => statement(t.prepare(sql));
        if (key === "batch") return async (statements: D1PreparedStatement[]) => {
          if (!fired) { fired = true; await beforeBatch?.(); }
          return t.batch(statements.map(s => originals.get(s) ?? s));
        };
        const value = Reflect.get(t, key); return typeof value === "function" ? value.bind(t) : value;
      } });
    }
    return { db, config, configJson, policy, legacy, shape, records, apply, ledger, seedVerifiedConfiguration, seedRetained, retained,
      seedLaterConfiguration: () => seedVerifiedConfiguration(config.configurationRevision + 1),
      observeReads: (after: () => void | Promise<void>) => observed(after),
      beforeBatch: (before: () => void | Promise<void>) => observed(undefined, before),
      async applyBroken22() {
        const last = records.at(-1)!, sql = last.sql + "\nSELECT * FROM fixture_missing_private_dance_table;";
        return applyOwnerMigrationRecords(db, [...records.slice(0, 21), { ...last, sql, hash: migrationSha(sql), statements: [sql] }]);
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) { await runtime.dispose(); throw error; }
}

/** This case tests installed table/store compatibility, not the real catalogue's
 * source authority. Its trusted private port supplies an explicit fixture
 * policy-row predicate; actual accepting predicates execute in the real D1. */
export async function exercisePrivateStores(f: Awaited<ReturnType<typeof privatePracticeFixture>>) {
  const store = new DanceStore(f.db), at = await store.now();
  const snapshot = { ...f.shape.privateSnapshot, communityId: f.config.communityId,
    reservedAtMs: at, expiresAtMs: at + 60000, reference: null, offer: null,
    expected: { configurationRevision: f.config.configurationRevision, rulesEpoch: 0, mediaEpoch: 0 },
    termsHash: f.policy.consent.termsHash, mediaPolicyHash: hashText(f.policy.mediaPolicyDocument),
    rulesHash: hashText(f.policy.rulesDocument), rubricHash: hashText(f.policy.rubricText), rubricText: f.policy.rubricText };
  const capture = parseDanceCaptureV2({ ...snapshot, captureHash: hashPrivateDanceCaptureV2(snapshot), consent: null }, false);
  const fence: DanceFence = { sql: "EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=? AND body_json=?)", values: [f.config.communityId, canonical(f.policy)] };
  await store.reserveCaptureV2(capture, capture.learner.accountId, "private-migration-capture", word(74), [fence], { kind: "private" });
  const accepted = await store.acceptConsentV2(capture, { accepted: true, version: f.policy.consent.version,
    termsHash: f.policy.consent.termsHash, publicityPolicyHash: f.policy.consent.publicityPolicyHash }, "private-migration-consent", [fence]);
  const actor = { accountId: accepted.learner.accountId };
  const bindings = new DanceSource3Bindings({ db: f.db, communityId: f.config.communityId,
    privateV2: { current: async () => [fence] } });
  const intent: MediaIntent = { requestId: "private-source3-original", songKey: accepted.songKey, songRevision: accepted.songRevision,
    recordingSha256: "a".repeat(64), bytes: 1000, startSample: accepted.startSample, durationSamples: accepted.durationSamples,
    purpose: "private-review", publicConsent: false };
  await bindings.bindIntent(actor, accepted.captureId, accepted.captureHash, intent);
  await bindings.bindIntent(actor, accepted.captureId, accepted.captureHash, intent);
  const reservation = await bindings.reservation(actor, intent, { communityId: accepted.communityId, songKey: accepted.songKey,
    songRevision: accepted.songRevision, audioSha256: accepted.audioSha256.slice(2), durationSamples: accepted.songDurationSamples, title: "Offline source3 song" });
  await store.assert([reservation]);
  return { capture: accepted, intent };
}
