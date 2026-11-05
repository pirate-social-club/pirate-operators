import type { PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { ContentProfile } from "./content-profile.ts";
import {
  signEvidence,
  evidenceSchemas,
  type EvidenceCheck,
  type EvidenceRecord,
} from "./evidence.ts";
export function admissionSigner(
  signer: PrivateKeyAccount,
  row: { submission_id: string; community_id: string; job_id: string },
  evidence: EvidenceRecord[],
  issuedAt: number,
  profile: ContentProfile,
) {
  return async (
    check: EvidenceCheck,
    subject: Hex,
    result: string,
    inputs: Record<string, unknown>,
    details: Record<string, unknown>,
  ) => {
    evidence.push(
      await signEvidence(
        signer,
        {
          check,
          schema: evidenceSchemas[check],
          submissionId: row.submission_id,
          communityId: row.community_id,
          jobId: row.job_id,
          subject,
          evaluator: `pirate-admission/2;acr-raw/1;${profile.moderationModel};${profile.classificationModel}`,
          policy: "pirate-release/2026-08-29",
          result,
          issuedAt,
          expiresAt: issuedAt + 3600,
        },
        inputs,
        details,
      ),
    );
  };
}
