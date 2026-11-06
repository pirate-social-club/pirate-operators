// D1 is the outbox: terminal lesson state and original bindings survive a
// browser exit or a lost operator response. Only the operator sends transactions.
import { digest } from "../packages/protocol/index.ts";
import {
  studyCheck,
  type StudyPrincipal,
} from "../packages/study/contracts.ts";
import {
  freezeStudyOutbox,
  studyOutboxRow,
  type StudyOutboxRow,
} from "./study-outbox.ts";
import type { StudyPublicationReceipt } from "../packages/study/publication.ts";
import type { LyricManifest } from "../packages/community/lyric-manifest.ts";
import type { StudyOperatorBinding } from "./study-operator.ts";
import {
  publishManagedStudy,
  type StudyOperatorPorts,
} from "./study-operator-client.ts";

export function studyPublicationQueue(
  db: D1Database,
  operator: StudyOperatorPorts,
  owner: StudyPrincipal,
  now = Date.now,
) {
  const load = (id: string) => studyOutboxRow(db, owner, id);
  const view = (row: StudyOutboxRow | null) => ({
    state: row?.state ?? "unbound",
    receipt: row?.receipt_json
      ? (JSON.parse(row.receipt_json) as StudyPublicationReceipt)
      : null,
  });
  return {
    get: async (id: string) => view(await load(id)),
    async sync(id: string) {
      const row = await freezeStudyOutbox(db, owner, id);
      if (!row) return null; // No recording authority was obtained.
      const prior = view(row).receipt;
      if (
        row.state === "private" ||
        row.state === "failed" ||
        (row.state === "published" &&
          prior?.confirmed &&
          row.updated_at > now() - 3600000)
      )
        return prior;
      const binding = JSON.parse(row.binding_json) as StudyOperatorBinding;
      studyCheck(
        binding.target.version === 3 &&
          binding.target.chainId === operator.authority.chainId &&
          binding.target.contract.toLowerCase() ===
            operator.authority.contract.toLowerCase(),
        "study_contract_changed",
        409,
      );
      // Preserve a retryable row before the request; publication cannot depend
      // on this HTTP response reaching either the app or its browser.
      await db
        .prepare(
          "UPDATE study_publications SET state=CASE WHEN state='bound' THEN 'pending' ELSE state END,updated_at=? WHERE lesson_id=? AND account_id=? AND community_id=?",
        )
        .bind(now(), id, owner.accountId, owner.communityId)
        .run();
      const receipt = await publishManagedStudy(operator, {
        lessonId: id,
        terminal: JSON.parse(row.terminal_json!),
        source: JSON.parse(row.source_json) as LyricManifest,
      });
      studyCheck(
        receipt.sessionId ===
          digest({
            schema: "pirate.study-result-id/1",
            enrollmentId: binding.enrollment.id,
            lessonId: id,
          }) &&
          receipt.chainId === binding.target.chainId &&
          receipt.contract.toLowerCase() ===
            binding.target.contract.toLowerCase() &&
          ["pending", "published", "private", "failed"].includes(
            receipt.state,
          ) &&
          /^0x[0-9a-f]{64}$/.test(receipt.commitment) &&
          (!prior || prior.commitment === receipt.commitment) &&
          typeof receipt.confirmed === "boolean" &&
          Number.isSafeInteger(receipt.checkedAt) &&
          (receipt.transactionHash === null ||
            /^0x[0-9a-f]{64}$/.test(receipt.transactionHash)),
        "study_publication_receipt_changed",
        503,
      );
      // Compare the old receipt, so an older pending response cannot replace a
      // concurrently saved public result. The next sweep reconciles any loser.
      await db
        .prepare(
          "UPDATE study_publications SET state=?,receipt_json=?,updated_at=? WHERE lesson_id=? AND account_id=? AND community_id=? AND receipt_json IS ?",
        )
        .bind(
          receipt.state,
          JSON.stringify(receipt),
          now(),
          id,
          owner.accountId,
          owner.communityId,
          row.receipt_json,
        )
        .run();
      return view(await load(id)).receipt;
    },
  };
}
