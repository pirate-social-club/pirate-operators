// Explicit private contract-V5 runtime. This is neither a ResultsTarget nor a
// public grant; grading-policy revisions keep their existing independent pins.
import type { Address, Hex } from "viem";
import type { LyricManifest } from "../community/lyric-manifest.ts";
import type { AdmittedStudyGrader } from "./grader-revision.ts";
import { canonical, check, digest } from "../protocol/index.ts";
import { studyId } from "./operator-contract.ts";
import { studySourceSelection } from "./public-source.ts";
import { STUDY_LESSON_NO_DEADLINE } from "./lesson.ts";

export interface StudyPrivateV5Profile {
  schema: "pirate.study-private-runtime/5";
  version: 5;
  chainId: 31337 | 6343;
  communityId: Hex;
  sourceChainId: 31337 | 6343;
  contract: Address;
  /** Reviewed release selection, not a runtime claim of deployed public code. */
  releaseHash: Hex;
  speechPolicyHash: Hex;
}
export interface StudyPrivateV5Entry {
  schema: "pirate.study-private-entry/5";
  version: 5;
  publication: { kind: "private" };
  profileHash: Hex;
  /** Original validated server source survives outages, crash and reload. */
  source: LyricManifest;
}
export interface StudyPrivateV5Offer {
  schema: "pirate.study-private-offer/5";
  version: 5;
  publication: { kind: "private" };
  profileHash: Hex;
  lessonId: string;
  accountId: string;
  learner: Address;
  source: LyricManifest;
  sourceDigest: Hex;
  startedAt: number;
  expiresAt: number;
  graderRevision: AdmittedStudyGrader;
  exercises: { ordinal: number; lineId: Hex; language: string }[];
}
export interface StudyPrivateV5Binding {
  schema: "pirate.study-private-binding/5";
  version: 5;
  publication: { kind: "private" };
  offer: StudyPrivateV5Offer;
  offerHash: Hex;
}
const keys = (value: object, expected: string[]) =>
  check(
    Object.keys(value).sort().join() === expected.sort().join(),
    "study_private_v5_shape",
  );
const nonzeroHash = (value: unknown) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{64}$/.test(value) &&
  !/^0x0+$/.test(value);
export function studyPrivateV5Profile(value: unknown): StudyPrivateV5Profile {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "study_private_v5_profile_required",
  );
  const v = value as StudyPrivateV5Profile;
  keys(v, [
    "schema",
    "version",
    "chainId",
    "communityId",
    "sourceChainId",
    "contract",
    "releaseHash",
    "speechPolicyHash",
  ]);
  check(
    v.schema === "pirate.study-private-runtime/5" &&
      v.version === 5 &&
      [31337, 6343].includes(v.chainId) &&
      [31337, 6343].includes(v.sourceChainId) &&
      nonzeroHash(v.communityId) &&
      /^0x[0-9a-f]{40}$/.test(v.contract) &&
      !/^0x0+$/.test(v.contract) &&
      nonzeroHash(v.releaseHash) &&
      nonzeroHash(v.speechPolicyHash),
    "study_private_v5_profile_required",
  );
  return Object.freeze({ ...v });
}
export function validatePrivateV5Offer(
  value: StudyPrivateV5Offer,
  profile: StudyPrivateV5Profile,
  nowS: number,
) {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "study_private_v5_offer_required",
  );
  keys(value, [
    "schema",
    "version",
    "publication",
    "profileHash",
    "lessonId",
    "accountId",
    "learner",
    "source",
    "sourceDigest",
    "startedAt",
    "expiresAt",
    "graderRevision",
    "exercises",
  ]);
  check(
    value.schema === "pirate.study-private-offer/5" &&
      value.version === 5 &&
      canonical(value.publication) === canonical({ kind: "private" }) &&
      value.profileHash === digest(profile) &&
      studyId(value.lessonId) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value.accountId,
      ) &&
      /^0x[0-9a-f]{40}$/.test(value.learner) &&
      !/^0x0+$/.test(value.learner) &&
      Number.isSafeInteger(value.startedAt) &&
      value.startedAt >= 0 &&
      value.startedAt <= nowS * 1000 + 5000 &&
      value.expiresAt === STUDY_LESSON_NO_DEADLINE &&
      [
        "script_aware_token_phonetic_v4",
        "script_aware_token_phonetic_v5",
      ].includes(value.graderRevision) &&
      Array.isArray(value.exercises),
    "study_private_v5_offer_required",
  );
  const selected = studySourceSelection(
    value.source,
    value.exercises.map((x) => x.ordinal),
  );
  check(
    value.source.communityId === profile.communityId &&
      value.source.chainId === profile.sourceChainId &&
      selected.hash === value.sourceDigest &&
      canonical(value.exercises) ===
        canonical(
          selected.selected.map((line, i) => ({
            ordinal: value.exercises[i].ordinal,
            lineId: line.lineId,
            language: line.language,
          })),
        ),
    "study_private_v5_source_changed",
  );
  return selected;
}
