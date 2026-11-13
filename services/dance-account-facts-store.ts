import { canonical, exact, hashText, insist, integer, object, text } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import type { DanceConsentPolicy, DanceFence } from "../packages/dance/contracts.ts";
import { danceId, wallet } from "../packages/dance/validation.ts";
import { DANCE_DB_NOW, DanceStore } from "../packages/dance/store.ts";

/** UNAPPLIED schema proposal; exported for actual SQLite test statements only.
 * No runtime initializer/writer is provided. Root owns verified projection
 * ingestion and migration selection. Empty/missing tables never admit Dance. */
export const DANCE_HOST_INPUTS_SCHEMA_PROPOSAL = `
CREATE TABLE dance_host_context (
 community_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 body_json TEXT NOT NULL CHECK(json_valid(body_json))
);
CREATE TABLE dance_host_accounts (
 community_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 body_json TEXT NOT NULL CHECK(json_valid(body_json)),PRIMARY KEY(community_id,account_id)
);
CREATE TABLE dance_host_selections (
 community_id TEXT NOT NULL,song_key TEXT NOT NULL,reference_id TEXT NOT NULL,offer_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 body_json TEXT NOT NULL CHECK(json_valid(body_json)),PRIMARY KEY(community_id,song_key,reference_id,offer_id)
);
CREATE TABLE dance_host_song_keys (
 community_id TEXT NOT NULL,song_key TEXT NOT NULL,post_id TEXT NOT NULL,
 PRIMARY KEY(community_id,song_key),UNIQUE(community_id,post_id)
);
CREATE TABLE dance_host_audio_probes (
 community_id TEXT NOT NULL,audio_sha256 TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,
 samples INTEGER NOT NULL CHECK(typeof(samples)='integer' AND samples>0),receipt_bytes TEXT NOT NULL,
 PRIMARY KEY(community_id,audio_sha256,evidence_sha256)
);
CREATE TRIGGER dance_host_probe_immutable_update BEFORE UPDATE ON dance_host_audio_probes
 BEGIN SELECT RAISE(ABORT,'dance_host_probe_immutable'); END;
CREATE TRIGGER dance_host_probe_immutable_delete BEFORE DELETE ON dance_host_audio_probes
 BEGIN SELECT RAISE(ABORT,'dance_host_probe_immutable'); END;
CREATE TRIGGER dance_host_probe_no_replace BEFORE INSERT ON dance_host_audio_probes
 WHEN EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE community_id=NEW.community_id
   AND audio_sha256=NEW.audio_sha256 AND evidence_sha256=NEW.evidence_sha256)
 BEGIN SELECT RAISE(ABORT,'dance_host_probe_immutable'); END;
CREATE TRIGGER dance_host_song_key_immutable_update BEFORE UPDATE ON dance_host_song_keys
 BEGIN SELECT RAISE(ABORT,'dance_host_song_key_immutable'); END;
CREATE TRIGGER dance_host_song_key_immutable_delete BEFORE DELETE ON dance_host_song_keys
 BEGIN SELECT RAISE(ABORT,'dance_host_song_key_immutable'); END;
CREATE TRIGGER dance_host_song_key_no_replace BEFORE INSERT ON dance_host_song_keys
 WHEN EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=NEW.community_id
   AND (song_key=NEW.song_key OR post_id=NEW.post_id))
 BEGIN SELECT RAISE(ABORT,'dance_host_song_key_immutable'); END;
CREATE TRIGGER dance_host_context_revision BEFORE UPDATE ON dance_host_context
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'dance_host_revision'); END;
CREATE TRIGGER dance_host_context_no_delete BEFORE DELETE ON dance_host_context
 BEGIN SELECT RAISE(ABORT,'dance_host_context_retained'); END;
CREATE TRIGGER dance_host_context_no_replace BEFORE INSERT ON dance_host_context
 WHEN EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=NEW.community_id)
 BEGIN SELECT RAISE(ABORT,'dance_host_context_retained'); END;
CREATE TRIGGER dance_host_account_revision BEFORE UPDATE ON dance_host_accounts
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.account_id IS NOT OLD.account_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'dance_host_revision'); END;
CREATE TRIGGER dance_host_selection_revision BEFORE UPDATE ON dance_host_selections
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.song_key IS NOT OLD.song_key
 OR NEW.reference_id IS NOT OLD.reference_id OR NEW.offer_id IS NOT OLD.offer_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'dance_host_revision'); END;
CREATE TRIGGER dance_host_selection_insert_generation AFTER INSERT ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_selection_update_generation AFTER UPDATE ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_selection_delete_generation AFTER DELETE ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=OLD.community_id; END;
CREATE TRIGGER dance_host_account_insert_generation AFTER INSERT ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_account_update_generation AFTER UPDATE ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_account_delete_generation AFTER DELETE ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=OLD.community_id; END;
`;

export interface DanceHostContext {
  version: "pirate.dance-host-context/1";
  sourceHash: string;
  configurationRevision: number;
  ownerEpoch: number;
  rulesEpoch: number;
  mediaEpoch: number;
  owner: { accountId: string; wallet: string; assignmentId: string; validFromMs: number; expiresAtMs: number };
  captureTtlMs: number;
  consent: DanceConsentPolicy;
  rulesDocument: string;
  rubricText: string;
  mediaPolicyDocument: string;
}
export interface DanceAccountSelection {
  version: "pirate.dance-account-selection/1";
  sourceHash: string;
  bindingId: string;
  authorizationId: string;
  identityEpoch: number;
  groupId: string;
  groupEpoch: number;
  knownAliases: string[];
  active: boolean;
}
export interface HostRow { revision: number; body_json: string }
export const hostCount = (value: unknown, min = 0) => integer(value, min, Number.MAX_SAFE_INTEGER);
export function hostBody(row: HostRow): Record<string, unknown> {
  hostCount(row.revision, 1);
  text(row.body_json, 128 * 1024);
  return object(JSON.parse(row.body_json));
}
const joined = new WeakMap<DanceFence, { sql: string; payload: string; leaves: DanceFence[] }>();
let fenceAlias = 0;
/** Preserve every leaf predicate in ONE statement/atomic batch while binding
 * its values once as JSON. The existing DanceStore adds one guard-token bind:
 * this fence therefore uses two of D1's 100 slots, even for a complete page.
 * Exact duplicate conjuncts alone are idempotent; differing snapshots remain.
 * The private leaf snapshots prevent nested joins from repeatedly packing the
 * same account/rules bytes. No predicate is prechecked outside the transaction. */
export function joinDanceFences(...fences: DanceFence[]): DanceFence {
  insist(fences.length > 0, "dance_host_fence_missing", 503);
  const unique = new Map<string, DanceFence>();
  for (const f of fences) {
    const prior = joined.get(f);
    const leaves = prior && f.sql === prior.sql && f.values.length === 1 && f.values[0] === prior.payload ? prior.leaves : [f];
    for (const leaf of leaves) {
      insist(typeof leaf.sql === "string" && !!leaf.sql.trim() && Array.isArray(leaf.values) &&
        Array.from(leaf.values).every(v => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))),
        "dance_host_fence_invalid", 503);
      const copy = { sql: leaf.sql, values: [...leaf.values] };
      unique.set(JSON.stringify([copy.sql, copy.values]), copy);
    }
  }
  const leaves = [...unique.values()];
  let alias: string;
  do {
    insist(Number.isSafeInteger(++fenceAlias), "dance_host_fence_alias_exhausted", 503);
    alias = "_dh" + fenceAlias;
  } while (leaves.some(f => f.sql.includes(alias)));
  const values: DanceFence["values"] = [], predicates: string[] = [];
  for (const leaf of leaves) {
    const offset = values.length;
    predicates.push("(" + bindFenceSql(leaf, index => `json_extract(${alias}.v,'$[${offset + index}]')`) + ")");
    values.push(...leaf.values);
  }
  const payload = JSON.stringify(values);
  const result = { sql: `EXISTS(SELECT 1 FROM (SELECT ? AS v) AS ${alias} WHERE ${predicates.join(" AND ")})`, values: [payload] };
  joined.set(result, { sql: result.sql, payload, leaves });
  return result;
}
/** SQLite positional parameter numbering, excluding quoted SQL and comments.
 * D1 guards use anonymous/?NNN binds. Unsupported named binds fail closed;
 * values are never embedded as SQL text, and a literal '?' stays a literal. */
function bindFenceSql(f: DanceFence, value: (index: number) => string) {
  let out = "", i = 0, highest = 0;
  while (i < f.sql.length) {
    const start = i, c = f.sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = c === "[" ? "]" : c;
      let closed = false; i++;
      while (i < f.sql.length) {
        if (f.sql[i++] !== end) continue;
        if (f.sql[i] === end) { i++; continue; }
        closed = true; break;
      }
      insist(closed, "dance_host_fence_sql_invalid", 503);
      out += f.sql.slice(start, i); continue;
    }
    if (f.sql.startsWith("--", i)) {
      const end = f.sql.indexOf("\n", i); i = end < 0 ? f.sql.length : end + 1;
      out += f.sql.slice(start, i); continue;
    }
    if (f.sql.startsWith("/*", i)) {
      const end = f.sql.indexOf("*/", i + 2);
      insist(end >= 0, "dance_host_fence_sql_invalid", 503);
      i = end + 2; out += f.sql.slice(start, i); continue;
    }
    if (c === "?") {
      i++; const digits = i;
      while (/[0-9]/.test(f.sql[i] ?? "")) i++;
      const number = i === digits ? highest + 1 : Number(f.sql.slice(digits, i));
      insist(Number.isSafeInteger(number) && number > 0 && number <= f.values.length,
        "dance_host_fence_bind_mismatch", 503);
      highest = Math.max(highest, number); out += value(number - 1); continue;
    }
    insist(!((c === ":" || c === "@" || c === "$") && /[a-zA-Z_]/.test(f.sql[i + 1] ?? "")),
      "dance_host_named_parameters_unsupported", 503);
    out += c; i++;
  }
  insist(highest === f.values.length, "dance_host_fence_bind_mismatch", 503);
  return out;
}
export function hostRowFence(table: "dance_host_context" | "dance_host_accounts" | "dance_host_selections",
  where: string, keys: (string | number)[], row: HostRow): DanceFence {
  return { sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${where} AND revision=? AND body_json=?)`,
    values: [...keys, row.revision, row.body_json] };
}
export async function readDanceHostContext(input: {
  db: D1Database; source: DanceCanonicalSource; config: CommunityConfig;
}) {
  const { db, source, config } = input;
  const community = source.domain.communityId;
  insist(source.domain.chainId === 6343n && config.chainId === 6343 && config.communityId === community &&
    config.postsContract === source.pin.posts && config.learningRecords === source.pin.v4 &&
    config.directory === source.pin.directory && config.publisher === source.pin.fixedPublisher,
    "dance_host_source_changed", 503);
  const row = await db.prepare("SELECT revision,body_json FROM dance_host_context WHERE community_id=?")
    .bind(community).first<HostRow>();
  insist(row, "dance_host_context_missing", 503);
  const body = hostBody(row);
  exact(body, ["version", "sourceHash", "configurationRevision", "ownerEpoch", "rulesEpoch", "mediaEpoch",
    "owner", "captureTtlMs", "consent", "rulesDocument", "rubricText", "mediaPolicyDocument"]);
  const c = body as unknown as DanceHostContext;
  insist(c.version === "pirate.dance-host-context/1" && c.sourceHash === source.sourceHash &&
    c.configurationRevision === config.configurationRevision && c.rulesEpoch === 0 && c.mediaEpoch === 0,
    "dance_host_context_changed", 409);
  hostCount(c.configurationRevision, 1); hostCount(c.ownerEpoch, 1); hostCount(c.captureTtlMs, 1);
  exact(object(c.owner), ["accountId", "wallet", "assignmentId", "validFromMs", "expiresAtMs"]);
  danceId(c.owner.accountId); danceId(c.owner.assignmentId); wallet(c.owner.wallet);
  hostCount(c.owner.validFromMs, 1); hostCount(c.owner.expiresAtMs, 1);
  insist(c.owner.validFromMs < c.owner.expiresAtMs, "dance_host_owner_changed", 409);
  const configuration = await db.prepare(`SELECT manifest_sha256,manifest_json,publisher,block_hash,manifest_uri,block_number,transaction_hash FROM public_configurations
    WHERE community_id=? AND revision=?`).bind(community, config.configurationRevision)
    .first<{ manifest_sha256: string; manifest_json: string; publisher: string; block_hash: string;
      manifest_uri: string; block_number: string; transaction_hash: string }>();
  insist(configuration && canonical(JSON.parse(configuration.manifest_json)) === canonical(config) &&
    hashText(configuration.manifest_json) === configuration.manifest_sha256 && configuration.publisher === config.publisher,
    "dance_host_configuration_projection_missing", 503);
  const fence = joinDanceFences(hostRowFence("dance_host_context", "community_id=?", [community], row), {
    sql: `EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)
      AND ${DANCE_DB_NOW}>=? AND ${DANCE_DB_NOW}<?`,
    values: [community, config.app.origin, c.owner.validFromMs, c.owner.expiresAtMs],
  }, {
    sql: `EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision=? AND manifest_sha256=?
      AND manifest_json=? AND publisher=? AND block_hash=? AND manifest_uri=? AND block_number=? AND transaction_hash=?)
      AND NOT EXISTS(SELECT 1 FROM public_configurations WHERE community_id=? AND revision>?)`,
    values: [community, config.configurationRevision, configuration.manifest_sha256, configuration.manifest_json,
      configuration.publisher, configuration.block_hash, configuration.manifest_uri, configuration.block_number,
      configuration.transaction_hash, community, config.configurationRevision],
  });
  await new DanceStore(db).assert([fence]);
  return { context: c, fence, row };
}
