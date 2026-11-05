import {
  bytes32,
  canonical,
  exact,
  hashJson,
  hashText,
  insist,
  integer,
  object,
  token,
} from "../community/common.ts";
import type { ProviderResponse } from "../moderation/provider-http.ts";
import {
  ALIGNMENT_RESPONSE_BYTES,
  ALIGNMENT_REQUEST_BYTES,
  ALIGNMENT_RECEIPT_BYTES,
  ALIGNMENT_RESULT_BYTES,
  ALIGNMENT_ROW_BYTES,
  utf8Bytes,
} from "./limits.ts";

function receiptJson(value: ProviderResponse) {
  exact(object(value), [
    "status",
    "contentType",
    "requestId",
    "body",
    "bodySha256",
  ]);
  insist(
    typeof value.body === "string" &&
      utf8Bytes(value.body) <= ALIGNMENT_RESPONSE_BYTES &&
      hashText(value.body) === value.bodySha256 &&
      typeof value.contentType === "string" &&
      utf8Bytes(value.contentType) <= 1024 &&
      (value.requestId === null ||
        (typeof value.requestId === "string" &&
          utf8Bytes(value.requestId) <= 1024)),
    "invalid_alignment_receipt",
    503,
  );
  integer(value.status, 100, 599);
  const json = canonical(value);
  insist(
    utf8Bytes(json) <= ALIGNMENT_RECEIPT_BYTES,
    "alignment_receipt_too_large",
    503,
  );
  return json;
}
function rowBudget(request: string, receipt = "", result = "") {
  insist(
    utf8Bytes(request) + utf8Bytes(receipt) + utf8Bytes(result) + 4096 <=
      ALIGNMENT_ROW_BYTES,
    "alignment_row_too_large",
    503,
  );
}

export interface AlignmentIdentity {
  communityId: `0x${string}`;
  postId: `0x${string}`;
  lyricsRevision: number;
}
interface Row {
  operation_id: string;
  request_hash: string;
  request_json: string;
  state:
    | "planned"
    | "running"
    | "received"
    | "uncertain"
    | "complete"
    | "unavailable";
  response_json: string | null;
  result_json: string | null;
}
export interface AlignmentPorts {
  authorize(): Promise<void>;
  send(
    received: (receipt: ProviderResponse) => Promise<void>,
  ): Promise<unknown>;
  interpret(receipt: ProviderResponse): Record<string, unknown>;
}
async function load(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM song_alignments WHERE operation_id=?")
    .bind(id)
    .first<Row>();
  insist(row, "alignment_operation_missing", 503);
  return row;
}

/** This identity never includes a replaceable grant or transport capability.
 * Neither new authority nor a lease expiry replenishes the one-call allowance. */
export async function alignmentOperation(
  db: D1Database,
  identity: AlignmentIdentity,
  grantHash: `0x${string}`,
  intent: Record<string, unknown>,
  ports: AlignmentPorts,
  mode: "execute" | "reconcile" = "execute",
) {
  exact(object(identity), ["communityId", "postId", "lyricsRevision"]);
  bytes32(identity.communityId);
  bytes32(identity.postId);
  bytes32(grantHash);
  integer(identity.lyricsRevision, 1, Number.MAX_SAFE_INTEGER);
  const id = hashJson({ kind: "song_alignment", ...identity }),
    captured = canonical({ identity, grantHash, intent }),
    requestHash = hashText(captured);
  insist(
    utf8Bytes(captured) <= ALIGNMENT_REQUEST_BYTES,
    "alignment_request_too_large",
    413,
  );
  rowBudget(captured);
  let row = await db
    .prepare("SELECT * FROM song_alignments WHERE operation_id=?")
    .bind(id)
    .first<Row>();
  if (!row && mode === "reconcile")
    return { operationId: id, state: "absent" as const };
  if (!row) {
    await ports.authorize();
    await db
      .prepare(
        `INSERT INTO song_alignments(operation_id,community_id,post_id,lyrics_revision,
    grant_hash,request_hash,request_json,state) VALUES(?,?,?,?,?,?,?,'planned')
    ON CONFLICT(community_id,post_id,lyrics_revision) DO NOTHING`,
      )
      .bind(
        id,
        identity.communityId,
        identity.postId,
        identity.lyricsRevision,
        grantHash,
        requestHash,
        captured,
      )
      .run();
    row = await load(db, id);
  }
  insist(
    row.request_hash === requestHash && row.request_json === captured,
    "alignment_intent_changed",
    409,
  );
  if (row.state === "planned" && mode === "execute") {
    await ports.authorize();
    const execution = token(),
      claim = await db
        .prepare(
          `UPDATE song_alignments SET
      state='running',execution_token=?,started_at=? WHERE operation_id=? AND state='planned'`,
        )
        .bind(execution, Date.now(), id)
        .run();
    if (claim.meta.changes === 1) {
      try {
        await ports.send(async (receipt) => {
          const json = receiptJson(receipt);
          rowBudget(captured, json);
          const saved = await db
            .prepare(
              `UPDATE song_alignments SET state='received',response_json=?
            WHERE operation_id=? AND execution_token=? AND state IN ('running','uncertain')
            AND response_json IS NULL`,
            )
            .bind(json, id, execution)
            .run();
          insist(
            saved.meta.changes === 1 ||
              (await load(db, id)).response_json === json,
            "alignment_receipt_unconfirmed",
            503,
          );
        });
      } catch {
        await db
          .prepare(
            `UPDATE song_alignments SET state='uncertain'
          WHERE operation_id=? AND execution_token=? AND state='running'`,
          )
          .bind(id, execution)
          .run();
      }
    }
    row = await load(db, id);
  }
  if (row.state === "running" || row.state === "uncertain") {
    // A stale invocation can still deliver a retained receipt. It cannot resend.
    await db
      .prepare(
        "UPDATE song_alignments SET state='uncertain' WHERE operation_id=? AND state='running'",
      )
      .bind(id)
      .run();
    return { operationId: id, state: "uncertain" as const };
  }
  if (row.state === "received") {
    insist(row.response_json, "alignment_receipt_missing", 503);
    let result: string;
    try {
      const receipt = JSON.parse(row.response_json) as ProviderResponse;
      insist(
        receiptJson(receipt) === row.response_json,
        "alignment_receipt_changed",
        503,
      );
      result = canonical(ports.interpret(receipt));
      insist(
        utf8Bytes(result) <= ALIGNMENT_RESULT_BYTES,
        "alignment_result_too_large",
        503,
      );
      rowBudget(captured, row.response_json, result);
    } catch {
      await db
        .prepare(
          "UPDATE song_alignments SET state='unavailable',completed_at=? WHERE operation_id=? AND state='received'",
        )
        .bind(Date.now(), id)
        .run();
      return { operationId: id, state: "unavailable" as const };
    }
    const saved = await db
      .prepare(
        `UPDATE song_alignments SET state='complete',result_json=?,completed_at=?
      WHERE operation_id=? AND state='received' AND response_json=?`,
      )
      .bind(result, Date.now(), id, row.response_json)
      .run();
    insist(
      saved.meta.changes === 1 || (await load(db, id)).result_json === result,
      "alignment_result_conflict",
      503,
    );
    row = await load(db, id);
  }
  return {
    operationId: id,
    state: row.state,
    ...(row.state === "complete"
      ? { result: JSON.parse(row.result_json!) as Record<string, unknown> }
      : {}),
  };
}
