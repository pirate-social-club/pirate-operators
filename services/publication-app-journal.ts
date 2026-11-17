import type { Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import type { ConsentCommandReceiptV1 } from "../packages/protocol/publication-runtime-v1.ts";
import type { PublicationInstallation } from "./publication-installed-selection.ts";
import {
  publicationJournalFence,
  ownedCommand,
  type CommandRow,
} from "./publication-command-store.ts";

/** Resolve retry identity BEFORE consulting the active release. Never select a
 * latest grant or reinterpret an accepted request under another deployment. */
export async function publicationRequestOriginal(
  db: D1Database,
  input: {
    communityId: Hex;
    accountId: string;
    requestId: string;
    purpose: string;
    action: "grant" | "withdraw";
  },
) {
  const result = await db
    .prepare(
      `SELECT command_id FROM publication_v1_commands
    WHERE community_id=? AND account_id=? AND request_id=? AND purpose=? AND action=?
    ORDER BY command_id LIMIT 2`,
    )
    .bind(
      input.communityId,
      input.accountId,
      input.requestId,
      input.purpose,
      input.action,
    )
    .all<{ command_id: Hex }>();
  check(result.results.length <= 1, "publication_request_ambiguous");
  const id = result.results[0]?.command_id;
  return id ? ownedCommand(db, id, input) : null;
}
/** A browser source ID selects only this account's retained server records. */
export async function publicationRetainedSource(
  db: D1Database,
  input: {
    communityId: Hex;
    accountId: string;
    purpose: string;
    sourceId: Hex;
    bindingId: string;
    authorId: string;
    learner: string;
  },
) {
  const scope = [
    input.communityId,
    input.accountId,
    input.purpose,
    input.sourceId,
  ];
  const row = await db
    .prepare(
      `SELECT command_id,
    (json_extract(request_json,'$.capture.bindingId')=? AND
     json_extract(request_json,'$.capture.authorId')=? AND
     json_extract(request_json,'$.capture.learner')=?) AS current_subject
    FROM publication_v1_commands
    WHERE community_id=? AND account_id=? AND purpose=? AND source_id=?
    ORDER BY current_subject DESC,created_at DESC,command_id DESC LIMIT 1`,
    )
    .bind(input.bindingId, input.authorId, input.learner, ...scope)
    .first<{ command_id: Hex; current_subject: number }>();
  if (!row) return null;
  if (!row.current_subject) {
    // A source is registry-scoped. A stop may retain one historical subject,
    // but must not silently choose one wallet from several owned subjects.
    const subjects = await db
      .prepare(
        `SELECT DISTINCT
      json_extract(request_json,'$.capture.bindingId') AS binding_id,
      json_extract(request_json,'$.capture.authorId') AS author_id,
      json_extract(request_json,'$.capture.learner') AS learner
      FROM publication_v1_commands
      WHERE community_id=? AND account_id=? AND purpose=? AND source_id=? LIMIT 2`,
      )
      .bind(...scope)
      .all();
    check(subjects.results.length === 1, "publication_source_ambiguous");
  }
  return ownedCommand(db, row.command_id, input);
}
export interface PublicationDueCursor {
  dueMs: number;
  commandId: Hex;
}
export async function publicationDue(
  db: D1Database,
  nowMs: number,
  limit: number,
  after: PublicationDueCursor | null,
) {
  check(
    Number.isSafeInteger(nowMs) &&
      nowMs > 0 &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= 100,
    "publication_due_bounds_invalid",
  );
  if (after)
    check(
      Number.isSafeInteger(after.dueMs) &&
        after.dueMs >= 0 &&
        /^0x[0-9a-f]{64}(?![\s\S])/.test(after.commandId),
      "publication_due_cursor_invalid",
    );
  const values: unknown[] = [nowMs];
  const cursor = after ? " AND (due_ms>? OR (due_ms=? AND command_id>?))" : "";
  if (after) values.push(after.dueMs, after.dueMs, after.commandId);
  values.push(limit);
  const page = await db
    .prepare(
      `SELECT command_id,community_id,account_id,due_ms
    FROM publication_v1_commands WHERE due_ms<=? AND
    ((action='withdraw' AND fence_ack_json IS NULL) OR phase='accepted')${cursor}
    ORDER BY due_ms,command_id LIMIT ?`,
    )
    .bind(...values)
    .all<{
      command_id: Hex;
      community_id: Hex;
      account_id: string;
      due_ms: number;
    }>();
  const rows: CommandRow[] = [];
  for (const r of page.results)
    rows.push(
      await ownedCommand(db, r.command_id, {
        communityId: r.community_id,
        accountId: r.account_id,
      }),
    );
  const last = page.results.at(-1);
  return {
    rows,
    cursors: page.results.map((r) => ({
      dueMs: r.due_ms,
      commandId: r.command_id,
    })),
    next:
      page.results.length === limit && last
        ? { dueMs: last.due_ms, commandId: last.command_id }
        : null,
  };
}
/** Scheduling is a versioned app-journal update; it cannot change an original.
 * Competing workers are idempotent and cannot overwrite a newer due decision. */
export async function deferPublication(
  db: D1Database,
  row: CommandRow,
  dueMs: number,
  installation?: PublicationInstallation,
) {
  const installed = publicationJournalFence(db, row, installation);
  await installation?.check();
  check(Number.isSafeInteger(dueMs) && dueMs > 0, "publication_due_invalid");
  await db
    .prepare(
      `UPDATE publication_v1_commands SET due_ms=?,version=version+1
    WHERE command_id=? AND version=? AND version<9007199254740991
    AND request_hash=? AND request_json=? AND nonce_hex=? AND (${installed.sql})`,
    )
    .bind(
      dueMs,
      row.command_id,
      row.version,
      row.request_hash,
      row.request_json,
      row.nonce_hex,
      ...installed.values,
    )
    .run();
  await installation?.check();
}
export async function publicationObservation(db: D1Database, row: CommandRow) {
  if (!row.observation_hash) return null;
  const saved = await db
    .prepare(
      `SELECT value_json FROM publication_v1_observations
    WHERE command_id=? AND proof_hash=?`,
    )
    .bind(row.command_id, row.observation_hash)
    .first<{ value_json: string }>();
  check(saved, "publication_observation_missing");
  const receipt = JSON.parse(saved.value_json) as ConsentCommandReceiptV1;
  check(
    canonical(receipt) === saved.value_json &&
      digest(receipt) === row.observation_hash,
    "publication_observation_invalid",
  );
  return receipt;
}
