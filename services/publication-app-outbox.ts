import { canonical, check } from "../packages/protocol/index.ts";
import {
  exact,
  parseCommand,
  record,
  same,
  signature,
  capturedFee,
} from "./publication-command-contract.ts";
import {
  ownedCommand,
  saveFenceAck,
  saveObservation,
  type CommandRow,
} from "./publication-command-store.ts";
import {
  deferPublication,
  publicationDue,
  type PublicationDueCursor,
} from "./publication-app-journal.ts";
import { publicationOriginal } from "./publication-app-request.ts";
import { publicationGrantQueueContext } from "./publication-grant-queue-context.ts";
import type { PublicationReleaseCatalog } from "./publication-app-selection.ts";
import {
  PublicationOperatorTransport,
  parsePublicationReceipt,
} from "./publication-app-transport.ts";

export interface PublicationOutbox {
  db: D1Database;
  catalog: PublicationReleaseCatalog;
  transport: PublicationOperatorTransport;
  nowMs: () => number;
  retryDelayMs: number;
  observationDelayMs: number;
}
const read = (p: PublicationOutbox, r: CommandRow) =>
  ownedCommand(p.db, r.command_id, {
    communityId: r.community_id,
    accountId: r.account_id,
  });
function nextTime(p: PublicationOutbox, delay: number) {
  const now = p.nowMs();
  check(
    Number.isSafeInteger(now) &&
      now > 0 &&
      Number.isSafeInteger(delay) &&
      delay > 0 &&
      delay <= 86400000 &&
      Number.isSafeInteger(now + delay),
    "publication_outbox_clock_invalid",
  );
  return now + delay;
}
/** Durable original capture permits restart before typed preparation. This
 * propagates only an inhibition, never wallet signing or remote activation. */
export async function propagatePublicationFence(
  p: PublicationOutbox,
  input: CommandRow,
  mode: "missing-ack" | "replay-witness" = "missing-ack",
) {
  let row = await read(p, input);
  check(
    row.action === "withdraw" &&
      row.fence_generation !== null &&
      row.fence_generation > 0,
    "publication_fence_pending",
  );
  const original = publicationOriginal(row, p.catalog);
  if (row.fence_ack_json && mode === "missing-ack") return row;
  const body = {
    schema: "pirate.publication-inhibition/1",
    commandId: row.command_id,
    accountId: row.account_id,
    requestId: row.request_id,
    source: original.source,
    learner: original.capture.learner,
    purpose: row.purpose,
    generation: String(row.fence_generation),
    requestHash: row.request_hash,
  };
  const reply = record(
    await p.transport.request(
      "/publication/v1/fence",
      row,
      original.release,
      body,
    ),
  );
  exact(reply, ["commandId", "generation", "requestHash"]);
  check(
    reply.commandId === row.command_id &&
      reply.generation === row.fence_generation &&
      reply.requestHash === row.request_hash &&
      (row.fence_ack_json === null || row.fence_ack_json === canonical(reply)),
    "publication_fence_ack_changed",
  );
  row = await read(p, row);
  return saveFenceAck(p.db, row, {
    commandId: row.command_id,
    generation: row.fence_generation!,
    requestHash: row.request_hash,
  });
}
/** Queue/reconcile only the exact accepted original. No current grant, active
 * profile, fresh fee, replacement signature, nonce allocation or sender. */
export async function deliverPublicationOriginal(
  p: PublicationOutbox,
  input: CommandRow,
) {
  let row = await read(p, input);
  if (row.action === "withdraw") row = await propagatePublicationFence(p, row);
  if (row.phase !== "accepted") return row;
  const original = publicationOriginal(row, p.catalog);
  check(
    row.typed_json && row.accepted_json && row.signature,
    "publication_original_missing",
  );
  const command = parseCommand(JSON.parse(row.typed_json));
  const accepted = record(JSON.parse(row.accepted_json));
  exact(accepted, ["command", "signature", "fee"]);
  check(
    canonical(accepted) === row.accepted_json &&
      canonical(accepted.command) === row.typed_json &&
      signature(accepted.signature) === row.signature &&
      same(capturedFee(accepted.fee), original.release.fee),
    "publication_original_changed",
  );
  const originalOnly = async () => {
    row = await reconcilePublicationOriginal(p, row);
    await deferPublication(p.db, row, nextTime(p, p.observationDelayMs));
    return read(p, row);
  };
  if (command.action === "grant") {
    let current = false;
    try {
      let context = await publicationGrantQueueContext(p, row, command);
      if (context.kind === "current") {
        if (context.witness) {
          const witnessId = context.witness.command_id;
          await propagatePublicationFence(p, context.witness, "replay-witness");
          context = await publicationGrantQueueContext(p, row, command);
          if (context.kind === "current")
            check(
              context.witness?.command_id === witnessId,
              "publication_fence_witness_changed",
            );
        }
        current = context.kind === "current";
      }
    } catch {
      // Missing current admission closes fresh queueing. It cannot hide an
      // original receipt; reconciliation never grants or allocates a nonce.
    }
    if (!current) return originalOnly();
  }
  const receipt = parsePublicationReceipt(
    await p.transport.request(
      "/publication/v1/accept",
      row,
      original.release,
      accepted,
    ),
    command,
  );
  // The operator verifies canonical transaction and event proof. This app
  // stores that authenticated result without promoting queued to recorded.
  row = await saveObservation(
    p.db,
    row,
    { ...receipt },
    nextTime(p, p.observationDelayMs),
  );
  await deferPublication(p.db, row, nextTime(p, p.observationDelayMs));
  return read(p, row);
}
/** Original-only endpoint path; an existing operator job is not reaccepted.
 * Receipt status is independent of current descriptor/profile usability. */
export async function reconcilePublicationOriginal(
  p: PublicationOutbox,
  input: CommandRow,
) {
  const row = await read(p, input),
    original = publicationOriginal(row, p.catalog);
  check(row.phase === "accepted" && row.typed_json, "publication_not_accepted");
  const command = parseCommand(JSON.parse(row.typed_json));
  const receipt = parsePublicationReceipt(
    await p.transport.request(
      "/publication/v1/reconcile",
      row,
      original.release,
      { commandId: row.command_id },
    ),
    command,
  );
  return saveObservation(
    p.db,
    row,
    { ...receipt },
    nextTime(p, p.observationDelayMs),
  );
}
/** Root invokes bounded indexed discovery on restart and every alarm. Queue
 * delivery is only an optimization; no wake packet is a readiness assertion. */
export async function drainPublicationOutbox(
  p: PublicationOutbox,
  input: {
    maxCommands: number;
    maxDurationMs: number;
    after?: PublicationDueCursor | null;
  },
) {
  check(
    p.transport instanceof PublicationOperatorTransport &&
      Number.isSafeInteger(input.maxDurationMs) &&
      input.maxDurationMs > 0 &&
      input.maxDurationMs <= 30000,
    "publication_outbox_bounds_invalid",
  );
  const started = p.nowMs(),
    page = await publicationDue(
      p.db,
      started,
      input.maxCommands,
      input.after ?? null,
    );
  let processed = 0,
    failed = 0,
    last: PublicationDueCursor | null = input.after ?? null;
  for (const row of page.rows) {
    const now = p.nowMs();
    check(now >= started, "publication_outbox_clock_invalid");
    if (now - started >= input.maxDurationMs) break;
    try {
      await deliverPublicationOriginal(p, row);
    } catch {
      failed++;
      // Reread the actual version; an old worker cannot restore its old due.
      const current = await read(p, row);
      await deferPublication(p.db, current, nextTime(p, p.retryDelayMs));
    }
    // A fresh bounded scan starts at null next tick. The supplied cursor is
    // useful for a caller's finite snapshot pass, never for hiding old rows.
    last = page.cursors[processed]!;
    processed++;
  }
  return {
    processed,
    failed,
    more: processed < page.rows.length || page.next !== null,
    next: processed === page.rows.length ? page.next : last,
  };
}
