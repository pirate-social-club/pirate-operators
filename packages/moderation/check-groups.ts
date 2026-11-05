import { insist } from "../community/common.ts";
import type { EvidenceCheck } from "./evidence.ts";
export type ServiceMode = "recognition" | "content" | "all";
/** The all-check group exists for isolated combined fixtures. Production
 * entrypoints select exactly recognition or content. Check on enqueue AND run. */
export function assertCheckGroup(
  mode: ServiceMode,
  checks: readonly EvidenceCheck[],
) {
  insist(
    mode === "all" ||
      (mode === "recognition"
        ? checks.length === 1 && checks[0] === "audio.identification"
        : !checks.includes("audio.identification")),
    "wrong_service_checks",
    400,
  );
}
