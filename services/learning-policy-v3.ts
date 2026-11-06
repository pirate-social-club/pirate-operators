// Immutable disclosure for the not-yet-deployed V3 testnet successor.
import { keccak256, stringToHex } from "viem";

export const learningV3Terms = `This community is a testnet learning pilot for Karaoke and Study. Sponsored transactions depend on the available community allowance. Practice may pause when a required service is unavailable. Testnet results do not currently earn money, prizes or funded rewards.

Enabling public learning results authorizes automatic publication of each terminal Karaoke run and Study lesson covered by your enrollment, including abandoned, expired, incomplete and unsuccessful work. Enrollment names the activities you authorize and lasts until its expiry or your revocation. You may decline; activities that require public results then remain unavailable. Closing a screen does not revoke enrollment.

Public records identify your MOSS wallet, community, activity, song and content revision, session identifier, source and selected exercise commitments, grader, assessment policies, start and completion times, terminal status, result revision and any superseded commitment. Karaoke publishes an outcome for every lyric line, with lyric and timing grades or an absence status. Study publishes the frozen selected lyric-line ordinals in lesson order and each first-pass outcome: correct, incorrect, unmeasured or unattempted. Later successful retries do not replace first-pass misses. Private retry history and recognized words are not public result fields.

Study selects four to ten distinct lyric lines before recording. Under the current qualification policy, a lesson must be completed, every selected first pass must be graded, and at least seventy percent must be correct. Completing a lesson, mastering its lines after retries and qualifying under a prospective policy are different facts. Policies may change prospectively within the enrolled public-data scope. Recorded grades identify the asserting grader and do not prove personhood or an honest performance.

Publication is permanent. Revocation stops first publications that have not landed on chain; it cannot erase earlier records. Authenticated corrections and invalidations of an existing result remain possible after enrollment expires or is revoked. They preserve the original learner, source, selected set and completion period, and remain publicly linked to earlier revisions. An invalidated or nonqualifying latest result cannot fall back to an older favorable one.`;

export const learningV3Privacy = `Microphone audio passes through the operator to ElevenLabs for speech recognition. Karaoke uses realtime recognition and Study sends individual recordings for transcription. Both adapters enable provider logging. Those services can process and retain audio and recognition data under their service terms. This pilot provides neither end-to-end encryption from the provider nor a promise of zero provider retention or a fixed provider retention period.

Raw audio is used transiently for processing and is not stored in the application's private history or included in its history export. Private history can contain expected lyric text, recognized words, timings, grades, selected lines and Study retries. While signed in, you can download supported retained history; the Study menu currently offers the most recently opened lesson. This is an operator-held JSON export, not a learner-controlled encrypted vault. Importing or editing a copy cannot create official grades or rewards.

The Study export window ends thirty days after the lesson's saved completion time or deadline. Scheduled cleanup removes expired private queues and attempts from active service stores at the next successful sweep. Operator speech receipts expire thirty days after dispatch. Karaoke history expires thirty days after the run. A failed cleanup is retried; the access deadline does not guarantee immediate physical deletion or control the provider's copies.

Public records remain permanent. Pending, unknown or published transactions can require retained source, compact result facts, enrollment authority, receipts, signed transaction bytes and conservative spending records for recovery. Uncertain remote bindings are also retained for reconciliation. Retained publication copies of unpublished first-pass Study grades and selection are erased only after canonical chain checks prove no result and no queued, signed or charged operation; unavailable proof delays that erasure. Ordinary private queues, retries and attempts follow the scheduled cleanup above without requiring that chain proof. Minimal account, lesson and request tombstones prevent replay from creating new lessons or provider starts. This pilot does not promise that all private or operational data disappears at thirty days.

Public result events exclude transcripts, recognized words, optional tutor observations, recordings, private attempt identifiers and retry history. Public grades and selected lines can still reveal recurring difficulties. Reusing a MOSS wallet across communities links their public histories. Later pseudonyms or revocation cannot unlink existing public records.`;

// Exact UTF-8 concatenation, without normalization or trailing newline.
export const learningV3PublicityDocument = `${learningV3Terms}\n\n${learningV3Privacy}`;
export const learningV3PublicityPolicy = keccak256(
  stringToHex(learningV3PublicityDocument),
);
export const learningV3Disclosure = {
  version: 3 as const,
  termsUrl: "/learning/v3/terms",
  privacyUrl: "/learning/v3/privacy",
  publicityPolicy: learningV3PublicityPolicy,
};

export function learningV3PolicyPage(path: string): string | undefined {
  return path === learningV3Disclosure.termsUrl
    ? learningV3Terms
    : path === learningV3Disclosure.privacyUrl
      ? learningV3Privacy
      : undefined;
}
