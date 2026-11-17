import type { Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import { consentDigest } from "../packages/protocol/publication-consent.ts";
import type {
  ConsentCommandReceiptV1,
  PreparedConsentCommandV1,
} from "../packages/protocol/publication-runtime-v1.ts";
import { sourceId } from "./publication-command-contract.ts";
import {
  publicationOriginal,
  PublicationRequestSession,
} from "./publication-app-request.ts";
import type { CommandRow } from "./publication-command-store.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";

const MAX = 9007199254740991;
const DB_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
/** The same local pending-withdrawal predicate is used by the read and the
 * accepting UPDATE. Acknowledged but not resolved withdrawals remain closed. */
const PENDING = `EXISTS(SELECT 1 FROM publication_v1_commands w
  WHERE w.community_id=h.community_id AND w.account_id=h.account_id
  AND w.source_id=h.source_id AND w.purpose=h.purpose AND w.action='withdraw'
  AND (w.fence_generation IS NULL OR w.fence_ack_json IS NULL OR
    COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld')))`;
export interface PublicationActivationHead {
  generation: number;
  stopped: number;
  stop_command_id: Hex | null;
  pending: number;
}
export async function publicationActivationHead(
  db: D1Database,
  row: CommandRow,
) {
  const h = await db
    .prepare(
      `SELECT h.generation,h.stopped,h.stop_command_id,
    ${PENDING} AS pending FROM publication_v1_heads h
    WHERE h.community_id=? AND h.account_id=? AND h.source_id=? AND h.purpose=?`,
    )
    .bind(row.community_id, row.account_id, row.source_id, row.purpose)
    .first<PublicationActivationHead>();
  check(
    h &&
      Number.isSafeInteger(h.generation) &&
      h.generation >= 0 &&
      h.generation < MAX &&
      (h.stopped === 0 || h.stopped === 1) &&
      (h.pending === 0 || h.pending === 1),
    "publication_head_unavailable",
  );
  if (h.stop_command_id !== null) consentDigest(h.stop_command_id);
  return h;
}
export function publicationOriginalFingerprint(row: CommandRow) {
  return canonical({
    commandId: row.command_id,
    communityId: row.community_id,
    accountId: row.account_id,
    sourceId: row.source_id,
    purpose: row.purpose,
    action: row.action,
    requestId: row.request_id,
    requestHash: row.request_hash,
    requestJson: row.request_json,
    nonce: row.nonce_hex,
    phase: row.phase,
    fenceGeneration: row.fence_generation,
    createdAt: row.created_at,
    typedJson: row.typed_json,
    digest: row.digest,
    signature: row.signature,
    acceptedJson: row.accepted_json,
    observationHash: row.observation_hash,
    resultState: row.result_state,
  });
}
/** Local completion only. The caller must first verify the actual generated
 * source/descriptor/epoch/grant at one canonical hash and finish that proof.
 * No study, karaoke, Dance attempt, result, binding or operator head is touched. */
export async function completeRecordedPublicationHead(
  p: PublicationApplicationPorts,
  input: {
    row: CommandRow;
    command: PreparedConsentCommandV1;
    receipt: ConsentCommandReceiptV1;
    head: PublicationActivationHead;
    validFromS: bigint;
    validUntilS: bigint;
  },
  session: PublicationRequestSession,
) {
  const { row, command, receipt, head, validFromS, validUntilS } = input;
  check(
    session instanceof PublicationRequestSession && session.db === p.db,
    "publication_request_session_required",
  );
  const original = publicationOriginal(row, p.catalog);
  session.assertOriginal(original.capture);
  check(
    p.catalog.active === original.source.releaseSelectionSha256 &&
      original.release.configuration.app.origin === session.context.origin &&
      original.source.communityId === session.context.communityId,
    "publication_active_release_changed",
  );
  check(
    row.action === "grant" &&
      command.action === "grant" &&
      row.phase === "accepted" &&
      row.command_id === command.commandId &&
      command.accountId === row.account_id &&
      command.requestId === row.request_id &&
      row.source_id === sourceId(command.source) &&
      canonical(command.source) === canonical(original.source) &&
      command.message.learner === original.capture.learner &&
      command.message.nonce === row.nonce_hex &&
      command.message.purpose === row.purpose &&
      canonical(command) === row.typed_json &&
      row.digest === command.digest &&
      row.signature !== null &&
      row.accepted_json !== null &&
      receipt.state === "recorded" &&
      row.result_state === "recorded" &&
      row.observation_hash === digest(receipt) &&
      receipt.commandId === command.commandId &&
      receipt.digest === command.digest &&
      receipt.action === "grant" &&
      receipt.purpose === command.message.purpose &&
      canonical(receipt.source) === canonical(command.source),
    "publication_recorded_original_changed",
  );
  check(
    head.pending === 0 &&
      head.generation === row.fence_generation &&
      String(head.generation) === command.localFenceGeneration,
    "publication_local_changed",
  );
  check(
    command.action === "grant" && receipt.state === "recorded",
    "publication_recorded_original_changed",
  );
  const now = p.clock.now();
  check(
    validFromS > 0n &&
      validFromS >= BigInt(command.message.validAfter) &&
      validFromS >= BigInt(receipt.observed.timestampS) &&
      validFromS < validUntilS &&
      validUntilS <= BigInt(command.message.expiresAt) &&
      validUntilS * 1000n <= BigInt(MAX) &&
      typeof now === "bigint" &&
      now >= validFromS &&
      now < validUntilS,
    "publication_activation_lease_expired",
  );
  const auth = session.observationFence({
    db: p.db,
    accountId: row.account_id,
    communityId: row.community_id,
  });
  const capture = original.capture;
  // Active catalog and chain state are separate observations, never SQL or
  // cross-store atomicity. Actual local predicates and the DB clock are atomic.
  const result = await p.db
    .prepare(
      `UPDATE publication_v1_heads AS h SET stopped=0
    WHERE h.community_id=? AND h.account_id=? AND h.source_id=? AND h.purpose=?
    AND h.generation=? AND h.generation<9007199254740991 AND h.stopped=?
    AND h.stop_command_id IS ? AND NOT (${PENDING})
    AND ${DB_NOW}>=? AND ${DB_NOW}<?
    AND EXISTS(SELECT 1 FROM application_identity i WHERE i.id=1 AND i.community_id=? AND i.community_origin=?)
    AND EXISTS(SELECT 1 FROM publication_v1_commands c
      JOIN publication_v1_observations o ON o.command_id=c.command_id AND o.proof_hash=c.observation_hash
      WHERE c.command_id=? AND c.community_id=h.community_id AND c.account_id=h.account_id
      AND c.source_id=h.source_id AND c.purpose=h.purpose AND c.action='grant'
      AND c.phase='accepted' AND c.result_state='recorded' AND c.version=? AND c.version<9007199254740991
      AND c.fence_generation=h.generation AND c.request_hash=? AND c.request_json=? AND c.nonce_hex=?
      AND c.typed_json=? AND c.digest=? AND c.signature=? AND c.accepted_json=?
      AND c.observation_hash=? AND o.value_json=?
      AND json_extract(c.request_json,'$.capture.accountId')=?
      AND json_extract(c.request_json,'$.capture.bindingId')=?
      AND json_extract(c.request_json,'$.capture.authorId')=?
      AND json_extract(c.request_json,'$.capture.learner')=?)
    AND (${auth.sql})`,
    )
    .bind(
      row.community_id,
      row.account_id,
      row.source_id,
      row.purpose,
      head.generation,
      head.stopped,
      head.stop_command_id,
      Number(validFromS * 1000n),
      Number(validUntilS * 1000n),
      session.context.communityId,
      session.context.origin,
      row.command_id,
      row.version,
      row.request_hash,
      row.request_json,
      row.nonce_hex,
      row.typed_json,
      row.digest,
      row.signature,
      row.accepted_json,
      row.observation_hash,
      canonical(receipt),
      capture.accountId,
      capture.bindingId,
      capture.authorId,
      capture.learner,
      ...auth.values,
    )
    .run();
  check(result.meta.changes === 1, "publication_activation_raced");
  await session.check();
  check(
    p.catalog.active === original.source.releaseSelectionSha256,
    "publication_active_release_changed",
  );
  const current = await publicationActivationHead(p.db, row);
  await session.check();
  check(
    current.generation === head.generation &&
      current.stopped === 0 &&
      current.pending === 0 &&
      current.stop_command_id === head.stop_command_id,
    "publication_local_changed",
  );
  return current;
}
