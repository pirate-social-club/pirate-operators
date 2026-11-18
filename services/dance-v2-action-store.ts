import type { Address, Hex } from "viem";
import { canonical, hashJson, insist } from "../packages/community/common.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW, DanceStore } from "../packages/dance/store.ts";

/** Alpha assigns an additive expanded-only migration. Both originals are
 * immutable, including failed-to-deliver and safe-head-pending work. */
export const DANCE_V2_ACTIONS_SCHEMA_PROPOSAL = [
  "CREATE TABLE dance_v2_action_originals(community_id TEXT NOT NULL,capture_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('register','verdict')),account_id TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,request_sha256 TEXT NOT NULL,bound_at_ms INTEGER NOT NULL CHECK(bound_at_ms>0),input_json TEXT NOT NULL CHECK(json_valid(input_json)),context_sha256 TEXT NOT NULL,PRIMARY KEY(community_id,capture_id,kind))",
  "CREATE TABLE dance_v2_ready_commands(command_id TEXT PRIMARY KEY REFERENCES dance_v2_action_originals(command_id),source_hash TEXT NOT NULL,publisher TEXT NOT NULL,command_hash TEXT NOT NULL,encoded TEXT NOT NULL,calldata TEXT NOT NULL,resource_id TEXT NOT NULL)",
  ...["dance_v2_action_originals", "dance_v2_ready_commands"].flatMap(
    (table) => [
      `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'dance_v2_action_immutable'); END`,
      `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'dance_v2_action_immutable'); END`,
      `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE command_id=NEW.command_id${table === "dance_v2_action_originals" ? " OR (community_id=NEW.community_id AND capture_id=NEW.capture_id AND kind=NEW.kind)" : ""}) BEGIN SELECT RAISE(ABORT,'dance_v2_action_immutable'); END`,
    ],
  ),
] as const;

type Kind = "register" | "verdict";
export interface DanceV2Action {
  community_id: Hex;
  capture_id: Hex;
  account_id: string;
  kind: Kind;
  command_id: Hex;
  request_sha256: Hex;
  bound_at_ms: number;
  input_json: string;
  context_sha256: Hex;
}
export interface DanceV2ReadyCommand {
  command_id: Hex;
  source_hash: Hex;
  publisher: Address;
  command_hash: Hex;
  encoded: Hex;
  calldata: Hex;
  resource_id: Hex;
}

export class DanceV2ActionStore extends DanceStore {
  read(community: Hex, capture: Hex, kind: Kind) {
    return this.stmt(
      "SELECT * FROM dance_v2_action_originals WHERE community_id=? AND capture_id=? AND kind=?",
      community,
      capture,
      kind,
    ).first<DanceV2Action>();
  }
  ready(id: Hex) {
    return this.stmt(
      "SELECT * FROM dance_v2_ready_commands WHERE command_id=?",
      id,
    ).first<DanceV2ReadyCommand>();
  }
  original(
    community: Hex,
    capture: Hex,
    kind: Kind,
    account: string,
    request: object,
  ) {
    const requestSha256 = hashJson(request);
    return {
      community_id: community,
      capture_id: capture,
      kind,
      account_id: account,
      command_id: hashJson({
        schema: "pirate.dance-v2-action/1",
        community,
        capture,
        kind,
        account,
        requestSha256,
      }),
      request_sha256: requestSha256,
      input_json: canonical(request),
    };
  }
  same(
    saved: DanceV2Action | null,
    original: Omit<DanceV2Action, "bound_at_ms" | "context_sha256">,
  ) {
    insist(saved, "dance_idempotency_conflict", 409);
    const { bound_at_ms: _at, context_sha256: _context, ...request } = saved;
    insist(
      canonical(request) === canonical(original),
      "dance_idempotency_conflict",
      409,
    );
    return saved;
  }
  fence(a: DanceV2Action): DanceFence {
    return {
      sql: "EXISTS(SELECT 1 FROM dance_v2_action_originals WHERE community_id=? AND capture_id=? AND kind=? AND account_id=? AND command_id=? AND request_sha256=? AND bound_at_ms=? AND input_json=? AND context_sha256=?)",
      values: [
        a.community_id,
        a.capture_id,
        a.kind,
        a.account_id,
        a.command_id,
        a.request_sha256,
        a.bound_at_ms,
        a.input_json,
        a.context_sha256,
      ],
    };
  }
  reserve(
    a: Omit<DanceV2Action, "bound_at_ms" | "context_sha256">,
    contextSha256: Hex,
    submittedMedia = false,
  ) {
    const timing = submittedMedia
      ? "(SELECT submitted_at_ms FROM community_media_submissions WHERE community_id=? AND submission_id=? AND account_id=?)"
      : DANCE_DB_NOW;
    return this.stmt(
      "INSERT INTO dance_v2_action_originals VALUES(?,?,?,?,?,?," +
        timing +
        ",?,?)",
      a.community_id,
      a.capture_id,
      a.kind,
      a.account_id,
      a.command_id,
      a.request_sha256,
      ...(submittedMedia ? [a.community_id, a.capture_id, a.account_id] : []),
      a.input_json,
      contextSha256,
    );
  }
  prepare(value: DanceV2ReadyCommand) {
    return this.stmt(
      "INSERT INTO dance_v2_ready_commands VALUES(?,?,?,?,?,?,?)",
      value.command_id,
      value.source_hash,
      value.publisher,
      value.command_hash,
      value.encoded,
      value.calldata,
      value.resource_id,
    );
  }
}
