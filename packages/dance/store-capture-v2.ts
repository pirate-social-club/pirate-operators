/** Capture writes use the existing Store transaction and the same D1 tables.
 * This is an implementation boundary, not another command or nonce journal. */
import { canonical, insist, token } from "../community/common.ts";
import type { DanceFence, SqlValue } from "./contracts.ts";
import type { DanceCaptureV2 } from "./capture-v2.ts";
import { parseDanceCaptureV2 } from "./capture-v2.ts";
import type { CaptureAtomicJoinV2 } from "./repository.ts";
import { DANCE_DB_NOW } from "./fence.ts";

interface CaptureStoreV2 {
  stmt(sql: string, ...values: SqlValue[]): D1PreparedStatement;
  now(): Promise<number>;
  assert(fences: DanceFence[]): Promise<void>;
  atomic(
    fences: DanceFence[],
    statements: D1PreparedStatement[],
  ): Promise<void>;
}

export async function captureDocument(store: CaptureStoreV2, id: string) {
  const r = await store
    .stmt(
      "SELECT c.capture_json,s.consent_json FROM dance_captures c LEFT JOIN dance_consents s ON s.capture_id=c.capture_id WHERE c.capture_id=?",
      id,
    )
    .first<{ capture_json: string; consent_json: string | null }>();
  insist(r, "dance_not_found", 404);
  return {
    json: r.capture_json,
    capture: {
      ...JSON.parse(r.capture_json),
      consent: r.consent_json ? JSON.parse(r.consent_json) : null,
    },
  };
}

export async function reserveCaptureV2(
  store: CaptureStoreV2,
  value: DanceCaptureV2,
  actor: string,
  command: string,
  hash: string,
  fences: readonly DanceFence[],
  join: CaptureAtomicJoinV2,
) {
  const c = parseDanceCaptureV2(value, false);
  insist(
    c.consent === null && actor === c.learner.accountId && fences.length > 0,
    "dance_v2_capture_join_invalid",
    409,
  );
  const statements: D1PreparedStatement[] = [];
  const current: DanceFence[] = [
    ...fences,
    {
      sql: "EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=?)",
      values: [c.communityId],
    },
    {
      sql: DANCE_DB_NOW + ">=? AND " + DANCE_DB_NOW + "<?",
      values: [c.reservedAtMs, c.expiresAtMs],
    },
  ];
  if (c.publication.kind === "private") {
    insist(
      join.kind === "private" && Object.keys(join).length === 1,
      "dance_v2_capture_join_invalid",
      409,
    );
  } else {
    insist(
      join.kind === "publication-bound",
      "dance_v2_capture_join_invalid",
      409,
    );
    const plan = join.bindingPlan;
    insist(
      plan.commandId === c.publication.publicationCommandId &&
        plan.captureHash === c.captureHash &&
        plan.grant.accountId === actor &&
        canonical(plan.grant.binding) === canonical(c.publication.binding) &&
        plan.fences.length > 0 &&
        plan.statements.length > 0,
      "dance_v2_capture_join_invalid",
      409,
    );
    current.push(...plan.fences);
    statements.push(...plan.statements);
    // Check the actual immutable binding after its writes, in this SAME
    // accepting batch. No supplied plan can replace the retained identity.
    const expected = c as import("./capture-v2.ts").PublicationCaptureV2;
    statements.push(
      store.stmt(
        "INSERT INTO dance_transaction_guards SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM dance_publication_bindings WHERE community_id=? AND capture_id=? AND capture_hash=? AND account_id=? AND purpose='dance-verdict' AND command_id=? AND json_extract(value_json,'$.kind')='capture' AND json_extract(value_json,'$.binding')=? AND json_extract(value_json,'$.configurationRevision')=? AND json_extract(value_json,'$.ownerEpoch')=? AND json_extract(value_json,'$.boundAtMs')=?) THEN 1 ELSE 0 END",
        token(),
        c.communityId,
        c.captureId,
        c.captureHash,
        actor,
        expected.publication.publicationCommandId,
        canonical(expected.publication.binding),
        expected.expected.configurationRevision,
        expected.expected.ownerEpoch,
        c.reservedAtMs,
      ),
    );
  }
  statements.push(
    store.stmt(
      "INSERT INTO dance_captures VALUES(?,?,?,?,?,?)",
      c.captureId,
      c.communityId,
      actor,
      command,
      hash,
      JSON.stringify(c),
    ),
  );
  await store.atomic(current, statements);
}
export async function acceptConsentV2(
  store: CaptureStoreV2,
  value: DanceCaptureV2,
  acceptance: import("./contracts.ts").DanceConsentAcceptance,
  command: string,
  fences: readonly DanceFence[],
): Promise<DanceCaptureV2> {
  const c = parseDanceCaptureV2(value, false),
    row = await captureDocument(store, c.captureId);
  const saved = parseDanceCaptureV2(row.capture, false);
  const core = (capture: DanceCaptureV2) => {
    const { consent: _consent, ...snapshot } = capture;
    return canonical(snapshot);
  };
  insist(
    core(c) === core(saved) &&
      acceptance.accepted === true &&
      fences.length > 0,
    "dance_consent_binding_mismatch",
    409,
  );
  const matches = (capture: DanceCaptureV2) => {
    const receipt = capture.consent;
    insist(
      receipt &&
        receipt.receiptId === command &&
        receipt.version === acceptance.version &&
        receipt.termsHash === acceptance.termsHash &&
        receipt.publicityPolicyHash === acceptance.publicityPolicyHash,
      "dance_consent_conflict",
      409,
    );
  };
  if (saved.consent) {
    matches(saved);
    await store.assert([...fences]);
    return saved;
  }
  // Validate the exact policy fields BEFORE the immutable INSERT. Actual
  // acceptance time still comes from the SQL clock in the guarded batch.
  parseDanceCaptureV2({
    ...saved,
    consent: {
      ...acceptance,
      receiptId: command,
      accountId: saved.learner.accountId,
      captureId: saved.captureId,
      captureHash: saved.captureHash,
      acceptedAtMs: await store.now(),
    },
  });
  await store.atomic(
    [
      ...fences,
      {
        sql: "EXISTS(SELECT 1 FROM dance_captures WHERE capture_id=? AND community_id=? AND account_id=? AND capture_json=?)",
        values: [
          saved.captureId,
          saved.communityId,
          saved.learner.accountId,
          row.json,
        ],
      },
      {
        sql: DANCE_DB_NOW + ">=? AND " + DANCE_DB_NOW + "<?",
        values: [saved.reservedAtMs, saved.expiresAtMs],
      },
    ],
    [
      store.stmt(
        "INSERT INTO dance_consents SELECT ?,json_object('accepted',json('true'),'version',?,'termsHash',?,'publicityPolicyHash',?,'receiptId',?,'accountId',?,'captureId',?,'captureHash',?,'acceptedAtMs'," +
          DANCE_DB_NOW +
          ") ON CONFLICT DO NOTHING",
        saved.captureId,
        acceptance.version,
        acceptance.termsHash,
        acceptance.publicityPolicyHash,
        command,
        saved.learner.accountId,
        saved.captureId,
        saved.captureHash,
      ),
    ],
  );
  const accepted = parseDanceCaptureV2(
    (await captureDocument(store, saved.captureId)).capture,
  );
  matches(accepted);
  return accepted;
}
