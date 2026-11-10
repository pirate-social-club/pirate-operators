// D1 may erase an unpublished outbox only after the managed publisher attests
// absence of native work. Unknown operations never receive this proof.
import { zeroHash } from "viem";
import type { StudyPublicationReceipt } from "../packages/study/publication.ts";
import type { StudyPrincipal } from "../packages/study/contracts.ts";

export const erasedStudyReceipt = (receipt: StudyPublicationReceipt | null) =>
  !!(
    receipt?.state === "private" &&
    receipt.neverSubmitted === true &&
    receipt.privateHistoryErased === true &&
    receipt.commitment === zeroHash &&
    receipt.transactionHash === null &&
    receipt.confirmed === false
  );

export async function erasePrivateStudyOutbox(
  db: D1Database,
  owner: StudyPrincipal,
  id: string,
) {
  const row = await db
    .prepare(
      `SELECT p.receipt_json FROM study_publications p
    JOIN study_lessons l ON l.lesson_id=p.lesson_id AND l.account_id=p.account_id AND l.community_id=p.community_id
    WHERE p.lesson_id=? AND p.account_id=? AND p.community_id=? AND l.history_deleted_at IS NOT NULL`,
    )
    .bind(id, owner.accountId, owner.communityId)
    .first<{ receipt_json: string | null }>();
  const receipt = row?.receipt_json
    ? (JSON.parse(row.receipt_json) as StudyPublicationReceipt)
    : null;
  if (
    !receipt ||
    receipt.state !== "private" ||
    receipt.neverSubmitted !== true ||
    receipt.transactionHash !== null ||
    receipt.confirmed
  )
    return false;
  const closed: StudyPublicationReceipt = {
    state: "private",
    sessionId: receipt.sessionId,
    chainId: receipt.chainId,
    contract: receipt.contract,
    commitment: zeroHash,
    transactionHash: null,
    confirmed: false,
    checkedAt: receipt.checkedAt,
    reason: "private_history_expired",
    neverSubmitted: true,
    privateHistoryErased: true,
  };
  const result = await db.batch([
    db
      .prepare(
        `UPDATE study_publications SET terminal_json=NULL,binding_json='{}',source_json='{}',receipt_json=?
    WHERE lesson_id=? AND account_id=? AND community_id=? AND state='private' AND receipt_json IS ?
    AND EXISTS(SELECT 1 FROM study_lessons WHERE lesson_id=study_publications.lesson_id AND history_deleted_at IS NOT NULL)`,
      )
      .bind(
        JSON.stringify(closed),
        id,
        owner.accountId,
        owner.communityId,
        row!.receipt_json,
      ),
    db
      .prepare(
        `UPDATE study_lessons SET song_json='{}',started_at=0
      WHERE lesson_id=? AND account_id=? AND community_id=? AND history_deleted_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM study_publications WHERE lesson_id=study_lessons.lesson_id AND state='private' AND receipt_json=?)`,
      )
      .bind(id, owner.accountId, owner.communityId, JSON.stringify(closed)),
  ]);
  return result[0].meta.changes === 1;
}
