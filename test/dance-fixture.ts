/** Explicit external authority/media models; SQL transactions are real D1. */
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import type {
  DanceCapture,
  DancePorts,
  DancePrincipal,
  DanceReadyMedia,
} from "../packages/dance/contracts.ts";
import { DANCE_VERSION } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { DanceReviewService } from "../services/dance-review.ts";
import { insist } from "../packages/community/common.ts";

export const dh = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export async function danceFixture(options: { realClock?: boolean } = {}) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const raw = await runtime.getD1Database("DB");
    let now = 1_800_000_000_000;
    const statements = new WeakMap<object, D1PreparedStatement>();
    // Only the database clock is frozen for exact millisecond boundary proofs.
    // Every condition, constraint, rollback and transaction runs in workerd D1.
    const db = new Proxy(raw, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(
              options.realClock
                ? sql
                : sql.replaceAll(DANCE_DB_NOW, String(now)),
            );
            const proxy = new Proxy(statement, {
              get(t, k) {
                if (k === "bind")
                  return (...values: unknown[]) => {
                    const bound = t.bind(...values);
                    statements.set(bound, bound);
                    return bound;
                  };
                const v = Reflect.get(t, k);
                return typeof v === "function" ? v.bind(t) : v;
              },
            });
            statements.set(proxy, statement);
            return proxy;
          };
        if (key === "batch")
          return (s: D1PreparedStatement[]) =>
            target.batch(s.map((v) => statements.get(v) ?? v));
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const sql = await readFile(
      new URL("../packages/dance/schema.sql", import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .trim()
        .split(/;\s*(?=CREATE|$)/)
        .filter((s) => s.trim())
        .map((s) => db.prepare(s)),
    );
    await db.batch([
      db.prepare(
        "CREATE TABLE fixture_authority(account_id TEXT PRIMARY KEY,identity_id TEXT,revision INTEGER,active INTEGER)",
      ),
      db.prepare(
        "CREATE TABLE fixture_owner(community_id TEXT PRIMARY KEY,account_id TEXT,identity_id TEXT,assignment_id TEXT,revision INTEGER)",
      ),
      db.prepare(
        "CREATE TABLE fixture_media(id TEXT PRIMARY KEY,revision INTEGER,state TEXT,community_id TEXT,digest TEXT)",
      ),
      db.prepare("CREATE TABLE fixture_rules(revision INTEGER)"),
      db.prepare("INSERT INTO fixture_rules VALUES(1)"),
      db.prepare(
        "CREATE TABLE fixture_offer(revision INTEGER,admitted INTEGER,open INTEGER)",
      ),
      db.prepare("INSERT INTO fixture_offer VALUES(1,1,1)"),
    ]);
    const principals: Record<string, DancePrincipal> = {};
    for (const [i, id] of [
      "owner",
      "learner",
      "moderator",
      "stranger",
      "alternate",
    ].entries()) {
      principals[id] = {
        accountId: id,
        identityId: id === "alternate" ? "learner_identity" : `${id}_identity`,
        active: true,
        revision: 1,
        wallet: `0x${(i + 10).toString(16).repeat(40).slice(0, 40)}`,
      };
      await db
        .prepare("INSERT INTO fixture_authority VALUES(?,?,1,1)")
        .bind(id, principals[id].identityId)
        .run();
    }
    await db
      .prepare("INSERT INTO fixture_owner VALUES(?,?,?,?,1)")
      .bind(dh(1), "owner", principals.owner.identityId, "assignment_1")
      .run();
    const media = new Map<string, DanceReadyMedia>();
    let offerOpen = now - 1000,
      offerCutoff = now + 100000;
    const ports: DancePorts = {
      async authority(community, actor, learner) {
        const row = await db
          .prepare("SELECT * FROM fixture_owner WHERE community_id=?")
          .bind(community)
          .first<{
            account_id: string;
            identity_id: string;
            assignment_id: string;
            revision: number;
          }>();
        insist(row, "fixture_wrong_community", 403);
        const read = async (id: string) => {
          const a = await db
            .prepare("SELECT * FROM fixture_authority WHERE account_id=?")
            .bind(id)
            .first<{ identity_id: string; revision: number; active: number }>();
          insist(a, "fixture_unknown_account", 403);
          return {
            ...principals[id],
            identityId: a.identity_id,
            active: !!a.active,
            revision: a.revision,
          };
        };
        const a = await read(actor),
          l = await read(learner);
        return {
          actor: a,
          learner: l,
          owner: {
            accountId: row.account_id,
            identityId: row.identity_id,
            assignmentId: row.assignment_id,
          },
          fence: {
            sql: `EXISTS(SELECT 1 FROM fixture_owner WHERE community_id=? AND revision=?) AND
            EXISTS(SELECT 1 FROM fixture_authority WHERE account_id=? AND identity_id=? AND revision=? AND active=1) AND
            EXISTS(SELECT 1 FROM fixture_authority WHERE account_id=? AND identity_id=? AND revision=? AND active=1)`,
            values: [
              community,
              row.revision,
              actor,
              a.identityId,
              a.revision,
              learner,
              l.identityId,
              l.revision,
            ],
          },
        };
      },
      async admitCapture(community, actor, selection) {
        const p = principals[actor];
        const capture: Omit<DanceCapture, "captureId"> = {
          version: DANCE_VERSION,
          communityId: community,
          accountId: actor,
          identityId: p.identityId,
          accountRevision: p.revision,
          wallet: p.wallet,
          songKey: selection.songKey,
          songRevision: 1,
          audioSha256: dh(3),
          mediaPolicyVersion: "pirate.dance-private/1",
          reference: null,
          startSample: 0,
          durationSamples: 10 * 48000,
          policy: "moderator-review-policy-v2",
          rulesHash: dh(4),
          termsHash: dh(5),
          rubricHash: dh(6),
          expiresAtMs: Math.min(
            now + 10000,
            selection.offerId ? offerCutoff : now + 10000,
          ),
          offer: selection.offerId
            ? {
                offerId: selection.offerId,
                inputHash: dh(7),
                sourceId: dh(8),
                opensAtMs: offerOpen,
                cutoffAtMs: offerCutoff,
              }
            : null,
        };
        return {
          capture,
          fence: {
            sql: "EXISTS(SELECT 1 FROM fixture_rules WHERE revision=1)",
            values: [],
          },
        };
      },
      async media(id, _binding, _actor) {
        const m = media.get(id);
        insist(m, "fixture_media_missing", 404);
        return m;
      },
      async rules() {
        return {
          sql: "EXISTS(SELECT 1 FROM fixture_rules WHERE revision=1)",
          values: [],
        };
      },
      async offer() {
        const o = await db
          .prepare("SELECT * FROM fixture_offer")
          .first<{ revision: number; admitted: number; open: number }>();
        insist(o, "fixture_offer_missing");
        return {
          admitted: !!o.admitted,
          open: !!o.open,
          inputHash: dh(7),
          sourceId: dh(8),
          fence: {
            sql: "EXISTS(SELECT 1 FROM fixture_offer WHERE revision=?)",
            values: [o.revision],
          },
        };
      },
    };
    const service = new DanceReviewService(db, ports, dh(1));
    let sequence = 0;
    async function prepare(
      options: { offer?: boolean; actor?: string; digest?: string } = {},
    ) {
      const actor = options.actor ?? "learner",
        n = ++sequence;
      const capture = await service.capture(actor, `capture_${n}`, {
        songKey: dh(2),
        offerId: options.offer === false ? null : "offer_1",
        referenceId: null,
      });
      const id = `media_${n}`,
        digest = options.digest ?? dh(n + 100);
      await db
        .prepare("INSERT INTO fixture_media VALUES(?,1,'ready',?,?)")
        .bind(id, dh(1), digest)
        .run();
      const m: DanceReadyMedia = {
        id,
        revision: 1,
        purpose: "private-review",
        communityId: dh(1),
        accountId: actor,
        songKey: dh(2),
        songRevision: 1,
        audioSha256: dh(3),
        mediaPolicyVersion: "pirate.dance-private/1",
        recordingSha256: digest,
        startSample: 0,
        durationSamples: 10 * 48000,
        uploadedAtMs: optionsRealNow(),
        expiresAtMs: now + 8 * 86400000,
        fence: {
          sql: `EXISTS(SELECT 1 FROM fixture_media WHERE id=? AND revision=1 AND state='ready'
          AND community_id=? AND digest=?)`,
          values: [id, dh(1), digest],
        },
      };
      media.set(id, m);
      const receipt = await service.submit(
        actor,
        `submit_${n}`,
        capture.captureId,
        id,
      );
      return { capture, media: m, receipt, reviewId: capture.captureId };
    }
    function optionsRealNow() {
      return options.realClock ? Date.now() : now;
    }
    return {
      runtime,
      db,
      raw,
      ports,
      service,
      principals,
      media,
      prepare,
      now: () => now,
      setNow: (n: number) => {
        now = n;
      },
      setWindow: (opens: number, cutoff: number) => {
        offerOpen = opens;
        offerCutoff = cutoff;
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
