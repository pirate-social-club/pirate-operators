import type { Hex } from "viem";
import type { PublicationPurpose } from "../packages/protocol/publication-consent.ts";
import {
  consentDigest,
  consentUint64,
} from "../packages/protocol/publication-consent.ts";
import type { PublicationPermissionViewV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { check } from "../packages/protocol/index.ts";
import { ownedCommand } from "./publication-command-store.ts";
import { record, source, sourceId } from "./publication-command-contract.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { publicationCurrentState } from "./publication-app-state.ts";
import type { PublicationRequestSession } from "./publication-app-request.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";

const denials = [
  "local_withdrawal",
  "unknown_grant",
  "wrong_scope",
  "inactive_registry",
  "superseded_descriptor",
  "changed_target_code",
  "withdrawn",
  "not_effective",
  "expired",
] as const;

/** Purpose-keyed read model, separate from immutable command consumption.
 * Newest recorded creation wins, with command ID as a deterministic tie-break.
 * An unsigned preparation does not replace it. A denied/unavailable selected
 * grant never falls back to an older grant; commands expose pending progress. */
export async function publicationPurposeView(
  p: PublicationApplicationPorts,
  session: PublicationRequestSession,
  purpose: PublicationPurpose,
): Promise<PublicationPermissionViewV1> {
  const common = {
    schema: "pirate.publication-permission/1" as const,
    purpose,
  };
  if (!p.catalog.active)
    return {
      ...common,
      commandId: null,
      sourceId: null,
      state: "denied",
      reason: "unknown_grant",
    };
  const release = p.catalog.get(p.catalog.active),
    sid = sourceId(publicationSelectionSource(release));
  const found = await p.db
    .prepare(
      `SELECT command_id FROM publication_v1_commands
    WHERE community_id=? AND account_id=? AND source_id=? AND purpose=? AND action='grant'
    AND json_extract(request_json,'$.capture.bindingId')=?
    AND json_extract(request_json,'$.capture.authorId')=?
    AND json_extract(request_json,'$.capture.learner')=?
    AND json_extract(request_json,'$.capture.releaseSelectionSha256')=?
    ORDER BY CASE WHEN result_state='recorded' THEN 1 ELSE 0 END DESC,created_at DESC,command_id DESC LIMIT 1`,
    )
    .bind(
      session.context.communityId,
      session.original.account_id,
      sid,
      purpose,
      session.original.binding_id,
      session.original.author_id,
      session.original.wallet.toLowerCase(),
      p.catalog.active,
    )
    .first<{ command_id: Hex }>();
  await session.check();
  if (!found)
    return {
      ...common,
      commandId: null,
      sourceId: sid,
      state: "denied",
      reason: "unknown_grant",
    };
  const row = await ownedCommand(p.db, found.command_id, {
    communityId: session.context.communityId,
    accountId: session.original.account_id,
  });
  await session.check();
  const observed = record(await publicationCurrentState(p, row, session));
  await session.check();
  const identity = {
    ...common,
    commandId: row.command_id,
    sourceId: row.source_id,
  };
  if (observed.state === "allowed") {
    check(
      observed.purpose === purpose,
      "publication_observation_scope_changed",
    );
    const canonical = record(observed.observed);
    consentUint64(canonical.blockNumber);
    consentUint64(canonical.timestampS);
    return {
      ...identity,
      state: "allowed",
      grantId: consentDigest(observed.grantId),
      source: source(observed.source),
      observed: {
        blockNumber: canonical.blockNumber as string,
        blockHash: consentDigest(canonical.blockHash),
        timestampS: canonical.timestampS as string,
      },
    };
  }
  if (
    observed.state === "denied" &&
    denials.some((reason) => reason === observed.reason)
  )
    return {
      ...identity,
      state: "denied",
      reason: observed.reason as (typeof denials)[number],
    };
  return {
    ...identity,
    state: "unavailable",
    reason:
      typeof observed.reason === "string"
        ? observed.reason
        : "publication_current_state_unavailable",
  };
}
