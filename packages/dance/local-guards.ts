import type { DanceFence, DanceOutbox, ReviewerContext } from "./contracts.ts";
export const LOCAL_REVIEWER_ALLOWED_SQL =
  "NOT EXISTS(SELECT 1 FROM dance_control_intents WHERE community_id=? AND operation='revoke' AND (account_id=? OR lower(wallet)=?))";
export function localReviewerFences(
  community: string,
  reviewer: Pick<ReviewerContext, "accountId" | "wallet" | "authority">,
): DanceFence[] {
  return reviewer.authority.startsWith("delegation:")
    ? [
        {
          sql: LOCAL_REVIEWER_ALLOWED_SQL,
          values: [
            community,
            reviewer.accountId,
            reviewer.wallet.toLowerCase(),
          ],
        },
      ]
    : [];
}
export function dispatchable(status: DanceOutbox["status"]) {
  return status === "ready" || status === "unknown" || status === "orphaned";
}
/** Local dispatch admission only. Canonical execution remains authoritative. */
export function dispatchFence(commandId: string): DanceFence {
  return {
    sql: "EXISTS(SELECT 1 FROM dance_outbox b WHERE b.command_id=? AND b.status IN ('ready','unknown','orphaned') AND (b.kind<>'decision' OR EXISTS(SELECT 1 FROM dance_reviews r JOIN dance_decision_intents i ON i.review_id=r.review_id WHERE r.review_id=b.subject_id AND r.community_id=b.community_id AND i.command_id=b.command_id AND i.local_integrity_hash=b.local_integrity_hash AND i.preimage_json=b.payload_json AND r.state='decision_pending' AND r.local_denied=0 AND COALESCE((SELECT json_extract(e.evidence_json,'$.canonical') FROM dance_chain_observations e WHERE e.review_id=r.review_id ORDER BY rowid DESC LIMIT 1),0)=0 AND CAST(unixepoch('subsec')*1000 AS INTEGER)<json_extract(r.receipt_json,'$.reviewDeadlineMs') AND (json_extract(i.preimage_json,'$.reviewer.authority') LIKE 'owner:%' OR NOT EXISTS(SELECT 1 FROM dance_control_intents c WHERE c.community_id=r.community_id AND c.operation='revoke' AND (c.account_id=json_extract(i.preimage_json,'$.reviewer.accountId') OR lower(c.wallet)=lower(json_extract(i.preimage_json,'$.reviewer.wallet'))))))))",
    values: [commandId],
  };
}
