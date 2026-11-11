import type { DanceFence, DanceOutbox, ReviewerContext } from "./contracts.ts";
import type { DanceRevokeContext } from "./control-contracts.ts";
const max = 9007199254740991;
const now = "CAST(unixepoch('subsec')*1000 AS INTEGER)";
const integer = (s: string, min: number, upper = max) => {
  // Bound JavaScript numbers may have SQLite REAL storage class. Require an
  // exact safe integer for context parameters; persisted rows remain INTEGER.
  const type = s.startsWith("ctx.")
    ? `typeof(${s}) IN ('integer','real') AND ${s}=CAST(${s} AS INTEGER)`
    : `typeof(${s})='integer'`;
  return `(${type} AND ${s} BETWEEN ${min} AND ${upper})`;
};
/** CASE makes NULL, malformed rows and account-only cross-wallet matches veto. */
function allowed(context: string, captured: boolean) {
  const e = "json_extract(c.body_json,'$.expectedReviewerEpoch')";
  const rowValid = `c.operation IN ('grant','revoke') AND json_extract(c.body_json,'$.version')='pirate.dance-control-intent/1'
    AND json_extract(c.body_json,'$.status')='pending_canonical' AND (SELECT count(*) FROM json_each(c.body_json))=15
    AND json_extract(c.body_json,'$.actorId')=c.actor_id AND json_extract(c.body_json,'$.delegationId')=c.delegation_id
    AND json_type(c.body_json,'$.ownerAssignment')='text' AND json_type(c.body_json,'$.expiresAtMs')='integer'
    AND ((c.operation='revoke' AND json_extract(c.body_json,'$.expiresAtMs')=0) OR
      (c.operation='grant' AND json_extract(c.body_json,'$.expiresAtMs') BETWEEN 1 AND ${max}))
    AND json_extract(c.body_json,'$.operation')=c.operation
    AND json_extract(c.body_json,'$.commandId')=c.command_id AND json_extract(c.body_json,'$.communityId')=c.community_id
    AND json_extract(c.body_json,'$.accountId')=c.account_id AND lower(json_extract(c.body_json,'$.wallet'))=lower(c.wallet)
    AND json_extract(c.body_json,'$.localIntegrityHash')=c.local_integrity_hash
    AND json_type(c.body_json,'$.expectedReviewerEpoch')='integer' AND ${e} BETWEEN 0 AND ${max - 1}
    AND json_type(c.body_json,'$.ownerEpoch')='integer' AND json_extract(c.body_json,'$.ownerEpoch') BETWEEN 1 AND ${max}
    AND json_type(c.body_json,'$.expectedConfigurationRevision')='integer'
    AND json_extract(c.body_json,'$.expectedConfigurationRevision') BETWEEN 1 AND ${max}`;
  const clear = `lower(c.wallet)=ctx.wallet AND EXISTS(
    SELECT 1 FROM dance_control_bindings b JOIN dance_control_projection p ON p.command_id=b.command_id
    JOIN dance_reviewer_projection r ON r.community_id=ctx.community AND r.source_hash=ctx.source AND r.wallet=ctx.wallet
    WHERE b.command_id=c.command_id AND b.intent_hash=c.local_integrity_hash AND b.source_hash=ctx.source
    AND b.wallet=ctx.wallet AND p.binding_hash=b.binding_hash AND p.source_hash=ctx.source AND p.wallet=ctx.wallet
    AND p.state='canonical' AND p.guarded=1 AND ${integer("p.revision", 1)} AND ${integer("p.result_epoch", 1)} AND p.result_epoch=${e}+1
    AND r.state='active' AND ${integer("r.revision", 1)} AND ${integer("r.role_epoch", 1)} AND ${integer("ctx.epoch", 1)}
    AND r.role_epoch=ctx.epoch AND ctx.epoch>p.result_epoch
    AND ${integer("ctx.owner_epoch", 1)} AND r.owner_epoch=ctx.owner_epoch
    AND ${integer("ctx.configuration", 1)} AND r.configuration_revision=ctx.configuration
    AND ${integer("r.owner_valid_from_ms", 1)} AND ${integer("r.owner_expires_at_ms", 1)} AND ${integer("r.role_expires_at_ms", 1)}
    AND r.owner_valid_from_ms<=${now} AND ${now}<r.owner_expires_at_ms AND ${now}<r.role_expires_at_ms
    AND ${integer("r.anchor_number", 0)} AND r.anchor_number=p.anchor_number AND r.anchor_hash=p.anchor_hash
    ${captured ? "" : "AND r.revision=ctx.revision AND r.anchor_number=ctx.head AND r.anchor_hash=ctx.hash"}
  )`;
  const compatible = `EXISTS(SELECT 1 FROM dance_reviewer_projection r WHERE r.community_id=ctx.community
    AND r.source_hash=ctx.source AND r.wallet=ctx.wallet AND r.state='active'
    AND ${integer("ctx.epoch", 1)} AND r.role_epoch=ctx.epoch AND r.owner_epoch=ctx.owner_epoch AND r.configuration_revision=ctx.configuration
    AND r.owner_valid_from_ms<=${now} AND ${now}<r.owner_expires_at_ms AND ${now}<r.role_expires_at_ms
    ${captured ? "" : "AND r.revision=ctx.revision AND r.anchor_number=ctx.head AND r.anchor_hash=ctx.hash"})`;
  const projection = captured
    ? `(NOT EXISTS(SELECT 1 FROM dance_reviewer_projection r WHERE r.community_id=ctx.community AND r.source_hash=ctx.source AND r.wallet=ctx.wallet) OR ${compatible})`
    : `(ctx.revision IS NULL OR ${compatible})`;
  return `(SELECT NOT EXISTS(SELECT 1 FROM dance_control_intents c WHERE c.community_id=ctx.community
    AND (c.account_id=ctx.account OR lower(c.wallet)=ctx.wallet OR typeof(c.wallet)<>'text' OR typeof(c.account_id)<>'text')
    AND CASE WHEN json_valid(c.body_json) THEN CASE WHEN ${rowValid} THEN
      CASE WHEN c.operation='grant' THEN 0 WHEN ${clear} THEN 0 ELSE 1 END ELSE 1 END ELSE 1 END=1
    ) AND ${projection} FROM (${context}) ctx)`;
}
export const LOCAL_REVIEWER_ALLOWED_SQL = allowed(
  "SELECT ? community,? account,? wallet,? source,? epoch,? owner_epoch,? configuration,? revision,? head,? hash",
  false,
);
export const CAPTURED_REVIEWER_ALLOWED_SQL = allowed(
  "SELECT ? community,? account,? wallet,? source,? epoch,? owner_epoch,? configuration",
  true,
);
export function localReviewerFence(
  community: string,
  account: string,
  wallet: string,
  context?: DanceRevokeContext,
): DanceFence {
  const stamp = context?.observation;
  const observation =
    stamp &&
    stamp.sourceHash === context?.sourceHash &&
    typeof stamp.wallet === "string" &&
    stamp.wallet.toLowerCase() === wallet.toLowerCase()
      ? stamp
      : undefined;
  return {
    sql: LOCAL_REVIEWER_ALLOWED_SQL,
    values: [
      community,
      account,
      wallet.toLowerCase(),
      context?.sourceHash ?? null,
      context?.roleEpoch ?? null,
      context?.ownerEpoch ?? null,
      context?.configurationRevision ?? null,
      observation?.revision ?? null,
      observation?.blockNumber ?? null,
      observation?.blockHash ?? null,
    ],
  };
}
export function localReviewerFences(
  community: string,
  reviewer: Pick<
    ReviewerContext,
    | "accountId"
    | "wallet"
    | "authority"
    | "roleEpoch"
    | "ownerEpoch"
    | "expectedConfigurationRevision"
  > &
    Partial<Pick<ReviewerContext, "roleProjection">>,
  sourceHash?: string,
  captured = false,
): DanceFence[] {
  if (reviewer.authority.startsWith("owner:")) return [];
  if (!reviewer.authority.startsWith("delegation:"))
    return [{ sql: "0", values: [] }];
  if (!captured)
    return [
      localReviewerFence(community, reviewer.accountId, reviewer.wallet, {
        sourceHash: sourceHash ?? reviewer.roleProjection?.sourceHash,
        roleEpoch: reviewer.roleEpoch,
        ownerEpoch: reviewer.ownerEpoch,
        configurationRevision: reviewer.expectedConfigurationRevision,
        observation: reviewer.roleProjection,
      }),
    ];
  return [
    {
      sql: CAPTURED_REVIEWER_ALLOWED_SQL,
      values: [
        community,
        reviewer.accountId,
        reviewer.wallet.toLowerCase(),
        sourceHash ?? null,
        reviewer.roleEpoch,
        reviewer.ownerEpoch,
        reviewer.expectedConfigurationRevision,
      ],
    },
  ];
}
export function dispatchable(status: DanceOutbox["status"]) {
  return status === "ready" || status === "unknown" || status === "orphaned";
}
export function dispatchFence(commandId: string): DanceFence {
  const captured = allowed(
    `SELECT r.community_id community,json_extract(i.preimage_json,'$.reviewer.accountId') account,
    lower(json_extract(i.preimage_json,'$.reviewer.wallet')) wallet,json_extract(i.preimage_json,'$.capture.source.sourceHash') source,
    json_extract(i.preimage_json,'$.reviewer.roleEpoch') epoch,json_extract(i.preimage_json,'$.reviewer.ownerEpoch') owner_epoch,
    json_extract(i.preimage_json,'$.reviewer.expectedConfigurationRevision') configuration`,
    true,
  );
  return {
    sql: `EXISTS(SELECT 1 FROM dance_outbox b WHERE b.command_id=? AND b.status IN ('ready','unknown','orphaned') AND
    (b.kind<>'decision' OR EXISTS(SELECT 1 FROM dance_reviews r JOIN dance_decision_intents i ON i.review_id=r.review_id
      WHERE r.review_id=b.subject_id AND r.community_id=b.community_id AND i.command_id=b.command_id
      AND i.local_integrity_hash=b.local_integrity_hash AND i.preimage_json=b.payload_json AND r.state='decision_pending' AND r.local_denied=0
      AND COALESCE((SELECT json_extract(e.evidence_json,'$.canonical') FROM dance_chain_observations e WHERE e.review_id=r.review_id ORDER BY rowid DESC LIMIT 1),0)=0
      AND ${now}<json_extract(r.receipt_json,'$.reviewDeadlineMs')
      AND json_type(i.preimage_json,'$.reviewer.roleEpoch')='integer'
      AND json_type(i.preimage_json,'$.reviewer.ownerEpoch')='integer'
      AND json_type(i.preimage_json,'$.reviewer.expectedConfigurationRevision')='integer'
      AND (json_extract(i.preimage_json,'$.reviewer.authority') LIKE 'owner:%' OR ${captured})
    )))`,
    values: [commandId],
  };
}
