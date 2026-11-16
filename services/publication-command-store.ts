import type { Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import { consentDigest, publicationPurposes } from "../packages/protocol/publication-consent.ts";
import type { ConsentSourceV1, PreparedConsentCommandV1 } from
  "../packages/protocol/publication-runtime-v1.ts";
import { commandId, parseCommand, preparedCall, signature, source, sourceId } from
  "./publication-command-contract.ts";

export interface CommandSeed {
  source: ConsentSourceV1; accountId: string; requestId: string;
  purpose: string; action: "grant" | "withdraw"; nonce: Hex; nowMs: number;
  capture: Record<string, unknown>;
}
export interface CommandRow {
  command_id: Hex; community_id: Hex; account_id: string; source_id: Hex;
  purpose: string; action: "grant" | "withdraw"; request_id: string;
  request_hash: Hex; request_json: string; nonce_hex: Hex;
  phase: "preparing" | "prepared" | "accepted";
  version: number; fence_generation: number | null; created_at: number;
  typed_json: string | null; digest: Hex | null; signature: Hex | null;
  accepted_json: string | null; fence_ack_json: string | null;
  result_state: string | null; observation_hash: Hex | null;
}
const MAX = 9007199254740991;
const scope = (r: CommandRow) => [r.community_id,r.account_id,r.source_id,r.purpose];
async function read(db: D1Database, id: Hex) {
  const row = await db.prepare("SELECT * FROM publication_v1_commands WHERE command_id=?")
    .bind(id).first<CommandRow>();
  check(row, "publication_command_missing");
  check(Number.isSafeInteger(row.version) && row.version >= 0 && row.version <= MAX &&
    digest(JSON.parse(row.request_json)) === row.request_hash, "publication_journal_invalid");
  return row;
}
export async function ownedCommand(db: D1Database, id: Hex,
  owner: {communityId: Hex; accountId: string}) {
  const r = await read(db,id);
  check(r.community_id === owner.communityId && r.account_id === owner.accountId,
    "publication_command_not_owned");
  return r;
}
/** Call only after same-origin authenticatedWrite. No remote work in this batch. */
export async function beginCommand(db: D1Database, s: CommandSeed) {
  source(s.source); consentDigest(s.nonce);
  check(publicationPurposes.some(p => p === s.purpose) &&
    (s.action === "grant" || s.action === "withdraw") &&
    /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(s.accountId) &&
    /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(s.requestId) &&
    Number.isSafeInteger(s.nowMs) && s.nowMs > 0, "publication_seed_invalid");
  const id = commandId(s), sid = sourceId(s.source);
  const identity = [s.source.communityId,s.accountId,sid,s.purpose];
  const original = {schema:"pirate.publication-prepare/1", source:s.source,
    accountId:s.accountId, requestId:s.requestId, purpose:s.purpose,
    action:s.action, capture:s.capture};
  const requestJson = canonical(original), requestHash = digest(original);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO publication_v1_heads
      (community_id,account_id,source_id,purpose,generation,stopped)
      VALUES(?,?,?,?,0,1)`).bind(...identity),
    db.prepare(`INSERT OR IGNORE INTO publication_v1_commands
      (command_id,community_id,account_id,source_id,purpose,action,request_id,
       request_hash,request_json,nonce_hex,phase,version,created_at,due_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,'preparing',0,?,?)`)
      .bind(id,...identity,s.action,s.requestId,requestHash,requestJson,s.nonce,s.nowMs,s.nowMs),
    db.prepare(`UPDATE publication_v1_heads SET generation=generation+1,
      stopped=1,stop_command_id=? WHERE community_id=? AND account_id=?
      AND source_id=? AND purpose=? AND generation<9007199254740991
      AND EXISTS(SELECT 1 FROM publication_v1_commands c WHERE c.command_id=?
        AND c.action='withdraw' AND c.fence_generation IS NULL AND c.version<9007199254740991)`)
      .bind(id,...identity,id),
    db.prepare(`UPDATE publication_v1_commands SET fence_generation=(
      SELECT generation FROM publication_v1_heads h
      WHERE h.community_id=publication_v1_commands.community_id
      AND h.account_id=publication_v1_commands.account_id
      AND h.source_id=publication_v1_commands.source_id
      AND h.purpose=publication_v1_commands.purpose),version=version+1
      WHERE command_id=? AND fence_generation IS NULL AND version<9007199254740991 AND
      (action='grant' OR EXISTS(SELECT 1 FROM publication_v1_heads h
        WHERE h.community_id=publication_v1_commands.community_id
        AND h.account_id=publication_v1_commands.account_id
        AND h.source_id=publication_v1_commands.source_id
        AND h.purpose=publication_v1_commands.purpose
        AND h.stop_command_id=publication_v1_commands.command_id))`).bind(id),
  ]);
  const row = await read(db,id);
  check(row.request_hash === requestHash && row.request_json === requestJson,
    "publication_command_changed");
  check(row.fence_generation !== null && row.fence_generation < MAX,
    "publication_fence_pending");
  return row;
}
/** Public admission reads pending unfenced withdrawals too, including exhaustion. */
export async function publicHead(db: D1Database, r: CommandRow) {
  const h = await db.prepare(`SELECT generation,stopped,
    EXISTS(SELECT 1 FROM publication_v1_commands c WHERE c.community_id=h.community_id
      AND c.account_id=h.account_id AND c.source_id=h.source_id AND c.purpose=h.purpose
      AND c.action='withdraw' AND (c.fence_generation IS NULL OR c.fence_ack_json IS NULL)) AS dirty
    FROM publication_v1_heads h WHERE community_id=? AND account_id=? AND source_id=? AND purpose=?`)
    .bind(...scope(r)).first<{generation:number;stopped:number;dirty:number}>();
  check(h && Number.isSafeInteger(h.generation) && h.generation < MAX,
    "publication_head_unavailable");
  return h;
}
export async function savePrepared(db: D1Database, row: CommandRow,
  message: unknown, nowMs: number) {
  if (row.typed_json) {
    const original = parseCommand(JSON.parse(row.typed_json));
    check(canonical(original.message) === canonical(message) &&
      original.message.nonce === row.nonce_hex, "publication_prepare_changed");
    return row;
  }
  check(row.version < MAX, "publication_mutation_exhausted");
  const original = JSON.parse(row.request_json) as {source:ConsentSourceV1};
  const c = parseCommand({schema:"pirate.publication-command/1",commandId:row.command_id,
    requestId:row.request_id,accountId:row.account_id,source:original.source,
    action:row.action,message,digest:preparedCall({action:row.action,
      source:original.source,message} as PreparedConsentCommandV1,"0x").digest,
    preparedAtMs:nowMs,localFenceGeneration:String(row.fence_generation)});
  check(c.message.nonce === row.nonce_hex && c.message.purpose === row.purpose,
    "publication_preparation_changed");
  const json = canonical(c);
  await db.prepare(`UPDATE publication_v1_commands SET phase='prepared',typed_json=?,
    digest=?,version=version+1 WHERE command_id=? AND version=? AND version<9007199254740991 AND phase='preparing'
    AND EXISTS(SELECT 1 FROM publication_v1_heads h
      WHERE h.community_id=publication_v1_commands.community_id
      AND h.account_id=publication_v1_commands.account_id
      AND h.source_id=publication_v1_commands.source_id
      AND h.purpose=publication_v1_commands.purpose
      AND h.generation=publication_v1_commands.fence_generation)
    AND (action='withdraw' OR NOT EXISTS(SELECT 1 FROM publication_v1_commands w
      WHERE w.community_id=publication_v1_commands.community_id
      AND w.account_id=publication_v1_commands.account_id
      AND w.source_id=publication_v1_commands.source_id
      AND w.purpose=publication_v1_commands.purpose AND w.action='withdraw'
      AND COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld')))`)
    .bind(json,c.digest,row.command_id,row.version).run();
  const current = await read(db,row.command_id);
  check(current.typed_json === json && current.digest === c.digest,
    "publication_prepare_changed");
  return current;
}
export async function acceptCommandSignature(db: D1Database, row: CommandRow,
  sig: unknown, accepted: Record<string,unknown>, nowMs: number) {
  const value = signature(sig), json = canonical(accepted);
  check(row.typed_json && row.digest, "publication_not_prepared");
  const input = accepted as {command?:unknown;signature?:unknown};
  check(canonical(input.command) === row.typed_json && input.signature === value,
    "publication_command_changed");
  if (row.phase === "accepted") {
    check(row.signature === value && row.accepted_json === json, "publication_command_changed");
    return row;
  }
  check(row.version < MAX, "publication_mutation_exhausted");
  await db.prepare(`UPDATE publication_v1_commands SET phase='accepted',signature=?,
    accepted_json=?,due_ms=?,version=version+1 WHERE command_id=? AND version=? AND version<9007199254740991
    AND phase='prepared' AND typed_json=? AND digest=?
    AND EXISTS(SELECT 1 FROM publication_v1_heads h
      WHERE h.community_id=publication_v1_commands.community_id
      AND h.account_id=publication_v1_commands.account_id
      AND h.source_id=publication_v1_commands.source_id
      AND h.purpose=publication_v1_commands.purpose
      AND h.generation=publication_v1_commands.fence_generation)
    AND (action='withdraw' OR NOT EXISTS(SELECT 1 FROM publication_v1_commands w
      WHERE w.community_id=publication_v1_commands.community_id
      AND w.account_id=publication_v1_commands.account_id
      AND w.source_id=publication_v1_commands.source_id
      AND w.purpose=publication_v1_commands.purpose AND w.action='withdraw'
      AND COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld')))`)
    .bind(value,json,nowMs,row.command_id,row.version,row.typed_json,row.digest).run();
  const current = await read(db,row.command_id);
  check(current.phase === "accepted" && current.signature === value &&
    current.accepted_json === json, "publication_command_changed");
  return current;
}
export async function saveObservation(db: D1Database, row: CommandRow,
  observation: {state:string;[key:string]:unknown}, dueMs: number) {
  const hash = digest(observation), json = canonical(observation);
  const current = await read(db,row.command_id);
  check(row.phase === "accepted" && row.accepted_json !== null &&
    current.accepted_json === row.accepted_json && current.request_hash === row.request_hash &&
    current.typed_json === row.typed_json && current.nonce_hex === row.nonce_hex,
    "publication_original_changed");
  if (current.observation_hash === hash) {
    const saved = await db.prepare(`SELECT value_json FROM publication_v1_observations
      WHERE command_id=? AND proof_hash=?`).bind(row.command_id,hash).first<{value_json:string}>();
    check(saved?.value_json === json,"publication_observation_changed");
    return current;
  }
  check(current.version < MAX, "publication_mutation_exhausted");
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO publication_v1_observations
      (command_id,proof_hash,value_json) SELECT ?,?,? WHERE EXISTS(
        SELECT 1 FROM publication_v1_commands WHERE command_id=?
        AND version<9007199254740991 AND accepted_json=? AND request_hash=?
        AND typed_json=? AND nonce_hex=?)`)
      .bind(row.command_id,hash,json,row.command_id,row.accepted_json,row.request_hash,
        row.typed_json,row.nonce_hex),
    db.prepare(`UPDATE publication_v1_commands SET observation_hash=?,result_state=?,
      due_ms=?,version=version+1 WHERE command_id=? AND version=?
      AND version<9007199254740991 AND accepted_json=? AND request_hash=?
      AND typed_json=? AND nonce_hex=? AND EXISTS(SELECT 1 FROM publication_v1_observations o
        WHERE o.command_id=publication_v1_commands.command_id AND o.proof_hash=? AND o.value_json=?)`)
      .bind(hash,observation.state,dueMs,row.command_id,row.version,row.accepted_json,
        row.request_hash,row.typed_json,row.nonce_hex,hash,json),
  ]);
  const saved = await db.prepare(`SELECT value_json FROM publication_v1_observations
    WHERE command_id=? AND proof_hash=?`).bind(row.command_id,hash).first<{value_json:string}>();
  check(saved?.value_json === json,"publication_observation_changed");
  const latest = await read(db,row.command_id);
  // Throw AFTER the batch commits: authentic stale audit is retained, while
  // this older worker cannot claim it became the latest observation.
  check(latest.observation_hash === hash, "publication_observation_raced");
  return latest;
}
export async function saveFenceAck(db: D1Database, row: CommandRow,
  ack: {commandId:Hex;generation:number;requestHash:Hex}) {
  check(row.action === "withdraw" && ack.commandId === row.command_id &&
    ack.generation === row.fence_generation && ack.requestHash === row.request_hash,
    "publication_fence_ack_changed");
  const json = canonical(ack);
  if (row.fence_ack_json === json) return row;
  check(row.version < MAX, "publication_mutation_exhausted");
  await db.prepare(`UPDATE publication_v1_commands SET fence_ack_json=?,version=version+1
    WHERE command_id=? AND version=? AND version<9007199254740991
    AND (fence_ack_json IS NULL OR fence_ack_json=?)`)
    .bind(json,row.command_id,row.version,json).run();
  const current = await read(db,row.command_id);
  check(current.fence_ack_json === json, "publication_fence_ack_raced");
  return current;
}
