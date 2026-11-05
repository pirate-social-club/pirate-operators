import type { AcceptedRecording } from "./catalog-store.ts";
export type MatchDecision =
  | { decision: "reuse" | "source_allowed"; recording: AcceptedRecording }
  | {
      decision: "block";
      reason:
        | "matched_recording_requires_source"
        | "source_license_disallows_use"
        | "unknown_or_ambiguous_recording";
      matchAssetId: string | null;
    };
/** These facts come from authenticated creator identity and the verified catalog,
 * not from title, account display name, upload order or client-supplied ownership. */
export function decideRecordingMatch(
  creatorId: string,
  declaredSourceAssetId: string | null,
  matches: AcceptedRecording[],
): MatchDecision {
  if (matches.length !== 1)
    return {
      decision: "block",
      reason: "unknown_or_ambiguous_recording",
      matchAssetId: null,
    };
  const recording = matches[0]!;
  if (creatorId === recording.creatorId)
    return { decision: "reuse", recording };
  if (declaredSourceAssetId !== recording.assetId)
    return {
      decision: "block",
      reason: "matched_recording_requires_source",
      matchAssetId: recording.assetId,
    };
  if (!recording.allowsDerivatives)
    return {
      decision: "block",
      reason: "source_license_disallows_use",
      matchAssetId: recording.assetId,
    };
  return { decision: "source_allowed", recording };
}
