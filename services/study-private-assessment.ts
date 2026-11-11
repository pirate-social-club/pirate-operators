import type { Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  minimalStudyGrade,
  reduceStudyGrade,
  gradeStudySpeech,
} from "../packages/study/assessment.ts";
import { studySourceSelection } from "../packages/study/public-source.ts";
import { STUDY_POLICY } from "../packages/study/contracts.ts";
import type {
  AnyStudyLessonOffer,
  StudySpeechReceipt,
} from "../packages/study/operator-contract.ts";
import type { StudyBinding } from "./study-operator.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { StudySpeechJob } from "./study-speech-receipt.ts";

export function privateStudySource(
  offer: AnyStudyLessonOffer,
  communityId?: string,
) {
  check(
    offer.speechChannel === "telegram-linked" && offer.privateSpeechSource,
    "study_private_grading_source_required",
  );
  const source = studySourceSelection(
    offer.privateSpeechSource,
    offer.exercises.map((e) => e.ordinal),
  );
  check(
    source.hash === offer.sourceDigest &&
      (!communityId || source.source.communityId === communityId) &&
      canonical(
        source.selected.map((l) => ({
          lineId: l.lineId,
          language: l.language,
        })),
      ) ===
        canonical(
          offer.exercises.map((e) => ({
            lineId: e.lineId,
            language: e.language,
          })),
        ),
    "study_private_grading_source_changed",
  );
  return source;
}
/** Both original and recovered transcripts pass this boundary before a
 * linked receipt can be persisted or returned. The evidence hash preserves
 * the exact original accounting observation without retaining its content. */
export function sanitizeStudySpeechReceipt(
  store: ResultStore,
  job: StudySpeechJob,
  receipt: StudySpeechReceipt,
): { receipt: StudySpeechReceipt; completionEvidence?: Hex } {
  if (receipt.state !== "assessed") return { receipt };
  check(
    Boolean(receipt.grade) !== Boolean(receipt.transcript),
    "study_private_assessment_required",
  );
  const binding = store.get<StudyBinding>(
    "studyBinding:" + job.parameters.lessonId,
  );
  check(binding || job.channel === "website-study", "study_lesson_not_bound");
  if (!binding) {
    check(
      receipt.transcript && !receipt.grade,
      "study_private_assessment_required",
    );
    return { receipt };
  }
  check(binding.offerHash === job.bindingHash, "study_speech_request_changed");
  const linked = binding.offer.speechChannel === "telegram-linked";
  check(
    job.channel === undefined ||
      job.channel === (linked ? "telegram-linked" : "website-study"),
    "study_speech_channel_changed",
  );
  if (!linked) {
    check(
      receipt.transcript && !receipt.grade,
      "study_private_assessment_required",
    );
    return { receipt };
  }
  const policy = binding.offer.graderRevision ?? STUDY_POLICY;
  const source = privateStudySource(
    binding.offer,
    binding.offer.telegramFence?.facts.actor.communityId,
  );
  const line = source.selected.find(
    (line) => line.lineId === job.parameters.lineId,
  );
  check(line, "study_reference_mismatch");
  const grade = receipt.grade
    ? minimalStudyGrade(receipt.grade, policy)
    : reduceStudyGrade(
        gradeStudySpeech(
          line,
          receipt.transcript!,
          policy,
          job.parameters.takeNumber,
        ),
      );
  check(
    job.parameters.takeNumber === 1 || !grade.rerecordReason,
    "study_minimal_grade_invalid",
  );
  return {
    receipt: { state: "assessed", grade },
    completionEvidence: job.completionEvidence ?? (digest(receipt) as Hex),
  };
}
