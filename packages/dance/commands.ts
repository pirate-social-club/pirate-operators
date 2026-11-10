import { exact, integer, insist, object } from "../community/common.ts";
import { danceId } from "./validation.ts";
/** Pure HTTP boundary decoder shared with focused tests. No actor/clock claim. */
export function decodeDanceDecision(value: unknown): {
  commandId: string;
  revision: number;
  verdict: "pass" | "not_passed";
  consentVersion: string;
} {
  const b = object(value);
  exact(b, ["commandId", "revision", "verdict", "consentVersion"]);
  insist(
    b.verdict === "pass" || b.verdict === "not_passed",
    "dance_verdict_invalid",
  );
  return {
    commandId: danceId(b.commandId),
    revision: integer(b.revision, 1, Number.MAX_SAFE_INTEGER),
    verdict: b.verdict,
    consentVersion: danceId(b.consentVersion),
  };
}
