import type { StudyTranscriptGradeV2 } from "./transcript-grading.ts";

export const STUDY_SCHEMA = "pirate.study.attempt/1" as const;
export const STUDY_POLICY = "script_aware_token_phonetic_v4" as const;
export const MAX_STUDY_AUDIO_BYTES = 524_288;
export const MIN_STUDY_RECORDING_MS = 1_000;
export const MAX_STUDY_RECORDING_MS = 60_000;
export const STUDY_SHORT_RECORDING_MESSAGE =
  "Record for at least one second, then try again.";
export interface StudyAttemptLesson {
  lessonId: string;
  presentationNumber: number;
  takeNumber: number;
}
export interface StudySelection {
  chainId: number;
  postsContract: string;
  communityId: string;
  postId: string;
  lyricRevision: number;
  lineId: string;
}
export interface StudyLine extends StudySelection {
  lineVersion: number;
  text: string;
  language: string;
  manifestDigest: string;
}
export interface StudyAttempt {
  schema: typeof STUDY_SCHEMA;
  kind: "say-it-back";
  attemptId: string;
  line: StudyLine;
  policy: typeof STUDY_POLICY;
  startedAt: number;
  completedAt: number | null;
  state: "ready" | "assessing" | "assessed" | "unavailable" | "uncertain";
  grade: StudyTranscriptGradeV2 | null;
  failure: string | null;
  lesson: StudyAttemptLesson | null;
  recordingDurationMs: number | null;
  qualification: "not_evaluated";
}
export interface StudyPrincipal {
  accountId: string;
  communityId: string;
}
export class StudyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function studyCheck(
  value: unknown,
  code: string,
  status = 400,
): asserts value {
  if (!value) throw new StudyError(code, status);
}
export function selection(value: unknown): StudySelection {
  studyCheck(
    value !== null && typeof value === "object",
    "invalid_study_selection",
  );
  const v = value as Record<string, unknown>;
  studyCheck(
    Object.keys(v).sort().join() ===
      [
        "chainId",
        "postsContract",
        "communityId",
        "postId",
        "lyricRevision",
        "lineId",
      ]
        .sort()
        .join(),
    "invalid_study_selection",
  );
  studyCheck(
    Number.isSafeInteger(v.chainId) && Number(v.chainId) > 0,
    "invalid_chain",
  );
  studyCheck(
    typeof v.postsContract === "string" &&
      /^0x[0-9a-f]{40}$/.test(v.postsContract) &&
      !/^0x0+$/.test(v.postsContract),
    "invalid_posts_contract",
  );
  for (const key of ["communityId", "postId", "lineId"]) {
    studyCheck(
      typeof v[key] === "string" &&
        /^0x[0-9a-f]{64}$/.test(v[key]) &&
        !/^0x0+$/.test(v[key]),
      "invalid_study_identity",
    );
  }
  studyCheck(
    Number.isSafeInteger(v.lyricRevision) && Number(v.lyricRevision) > 0,
    "invalid_lyric_revision",
  );
  return {
    chainId: Number(v.chainId),
    postsContract: v.postsContract,
    communityId: String(v.communityId),
    postId: String(v.postId),
    lyricRevision: Number(v.lyricRevision),
    lineId: String(v.lineId),
  };
}
export const selectionOf = (line: StudyLine): StudySelection => ({
  chainId: line.chainId,
  postsContract: line.postsContract,
  communityId: line.communityId,
  postId: line.postId,
  lyricRevision: line.lyricRevision,
  lineId: line.lineId,
});
export function validateStudyLine(
  line: StudyLine,
  requested: StudySelection,
): StudyLine {
  studyCheck(
    JSON.stringify(selection(selectionOf(line))) === JSON.stringify(requested),
    "study_reference_mismatch",
    409,
  );
  studyCheck(
    Number.isSafeInteger(line.lineVersion) && line.lineVersion > 0,
    "invalid_line_version",
  );
  studyCheck(
    typeof line.text === "string" &&
      line.text.trim().length > 0 &&
      line.text.length <= 512 &&
      !line.text.includes("\0"),
    "unsupported_line_length",
  );
  studyCheck(
    typeof line.language === "string" &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(line.language),
    "invalid_study_language",
  );
  studyCheck(
    /^0x[0-9a-f]{64}$/.test(line.manifestDigest),
    "invalid_manifest_digest",
  );
  return {
    ...requested,
    lineVersion: line.lineVersion,
    text: line.text,
    language: line.language,
    manifestDigest: line.manifestDigest,
  };
}
