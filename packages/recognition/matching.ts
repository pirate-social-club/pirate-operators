import { bytes32, canonical, insist } from "../community/common.ts";
import {
  associationId,
  verifiedPublication,
  type VerifiedPublication,
} from "./model.ts";
import type { RecognitionStore } from "./store.ts";

export type KnownMatchDecision =
  | {
      decision: "reuse" | "source_allowed";
      recordingId: string;
      source: VerifiedPublication;
    }
  | { decision: "hold" | "block"; reason: string };
/** Input candidates come from the retained identification response, not the browser.
 * This entrypoint never turns no-match into permission for an original publication. */
export async function resolveKnownMatch(
  store: RecognitionStore,
  creatorKey: string,
  candidates: readonly { kind: "music" | "custom_files"; id: string }[],
  declaredSource: { communityId: string; postId: string } | null,
  loadCurrentSource: (
    stored: VerifiedPublication,
  ) => Promise<VerifiedPublication | null>,
): Promise<KnownMatchDecision> {
  insist(
    /^eip155:6343:0x[0-9a-f]{40}$/.test(creatorKey) &&
      !creatorKey.endsWith("0".repeat(40)),
    "invalid_recognition_creator",
  );
  if (candidates.length !== 1 || candidates[0]!.kind !== "custom_files")
    return { decision: "hold", reason: "unknown_or_ambiguous_recording" };
  const r = await store.matched(candidates[0]!.id);
  if (!r) return { decision: "hold", reason: "recording_not_ready" };
  const stored = await store.active(
    r.recording_id,
    declaredSource ?? undefined,
  );
  if (!stored)
    return { decision: "hold", reason: "recording_not_referenceable" };
  const current = await loadCurrentSource(stored);
  if (!current)
    return { decision: "hold", reason: "source_authority_unavailable" };
  const source = verifiedPublication(current);
  if (canonical(source) !== canonical(stored))
    return { decision: "hold", reason: "source_revision_changed" };
  // Recheck the retained row after the asynchronous current-authority read.
  const association = await store.association(
      associationId(source),
      source.communityId,
    ),
    live = await store.matched(candidates[0]!.id);
  if (
    !live ||
    live.recording_id !== r.recording_id ||
    association?.state !== "active"
  )
    return { decision: "hold", reason: "source_revision_changed" };
  if (creatorKey === r.creator_key)
    return { decision: "reuse", recordingId: r.recording_id, source };
  if (
    !declaredSource ||
    bytes32(declaredSource.communityId) !== source.communityId ||
    bytes32(declaredSource.postId) !== source.postId
  )
    return { decision: "block", reason: "matched_recording_requires_source" };
  if (!source.allowsDerivatives)
    return { decision: "block", reason: "source_license_disallows_use" };
  return { decision: "source_allowed", recordingId: r.recording_id, source };
}
