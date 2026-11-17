import { check } from "../packages/protocol/index.ts";
import type { PreparedConsentCommandV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { ownedCommand, type CommandRow } from "./publication-command-store.ts";
import { parseCommand } from "./publication-command-contract.ts";
import { publicationObservation } from "./publication-app-journal.ts";
import { parsePublicationReceipt } from "./publication-app-transport.ts";
import type { PublicationOutbox } from "./publication-app-outbox.ts";

/** Concrete current D1 facts for a fresh queue, not authority to recover a
 * replacement. The accepted original's captured generation is never changed. */
export async function publicationGrantQueueContext(
  p: PublicationOutbox,
  row: CommandRow,
  command: PreparedConsentCommandV1,
): Promise<
  { kind: "current"; witness: CommandRow | null } | { kind: "original-only" }
> {
  check(
    command.action === "grant" &&
      command.commandId === row.command_id &&
      command.accountId === row.account_id &&
      command.message.purpose === row.purpose,
    "publication_original_changed",
  );
  const h = await p.db
    .prepare(
      `SELECT h.generation,h.stop_command_id,
    EXISTS(SELECT 1 FROM publication_v1_commands w WHERE w.community_id=h.community_id
      AND w.account_id=h.account_id AND w.source_id=h.source_id AND w.purpose=h.purpose AND w.action='withdraw'
      AND (w.fence_generation IS NULL OR w.fence_ack_json IS NULL OR
        COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld'))) AS pending
    FROM publication_v1_heads h WHERE h.community_id=? AND h.account_id=? AND h.source_id=? AND h.purpose=?`,
    )
    .bind(row.community_id, row.account_id, row.source_id, row.purpose)
    .first<{
      generation: number;
      stop_command_id: string | null;
      pending: number;
    }>();
  check(
    h && Number.isSafeInteger(h.generation) && h.generation >= 0,
    "publication_head_unavailable",
  );
  if (
    h.generation >= 9007199254740991 ||
    String(h.generation) !== command.localFenceGeneration ||
    h.pending
  )
    return { kind: "original-only" };
  if (h.generation === 0) {
    check(h.stop_command_id === null, "publication_fence_identity_changed");
    return { kind: "current", witness: null };
  }
  check(
    h.stop_command_id && /^0x[0-9a-f]{64}(?![\s\S])/.test(h.stop_command_id),
    "publication_fence_witness_missing",
  );
  const witness = await ownedCommand(p.db, h.stop_command_id as `0x${string}`, {
    communityId: row.community_id,
    accountId: row.account_id,
  });
  check(
    witness.action === "withdraw" &&
      witness.source_id === row.source_id &&
      witness.purpose === row.purpose &&
      witness.phase === "accepted" &&
      witness.typed_json !== null &&
      witness.observation_hash !== null &&
      witness.fence_generation === h.generation &&
      witness.fence_ack_json !== null &&
      ["recorded", "reverted", "withheld"].includes(witness.result_state ?? ""),
    "publication_fence_witness_changed",
  );
  const original = parseCommand(JSON.parse(witness.typed_json)),
    observed = await publicationObservation(p.db, witness);
  check(
    original.action === "withdraw" &&
      original.commandId === witness.command_id &&
      original.accountId === witness.account_id &&
      original.message.purpose === witness.purpose &&
      original.message.nonce === witness.nonce_hex &&
      original.localFenceGeneration === String(h.generation),
    "publication_fence_witness_changed",
  );
  check(observed, "publication_fence_observation_missing");
  const receipt = parsePublicationReceipt(observed, original);
  check(
    receipt.state === witness.result_state &&
      ["recorded", "reverted", "withheld"].includes(receipt.state),
    "publication_fence_witness_changed",
  );
  return { kind: "current", witness };
}
