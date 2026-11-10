// Immutable disclosure for the not-yet-deployed V3 testnet successor.
import { keccak256, stringToHex } from "viem";

export const learningV3Terms = `This is an early testing community offering Karaoke and Study for practising songs. The community covers the required service and publication costs while its allowance is available. Practice may pause if that allowance or a required service is unavailable. You do not need to join the community, set up a publishing wallet or complete identity verification to practise.

Enabling public learning results gives standing permission to automatically publish the final result of each Karaoke run and Study lesson for the activities you approve. This includes work that you stop early, leave unfinished, do not pass or allow to expire. The permission names the activities it covers and lasts until its stated end date or until you withdraw it. You may decline; activities that require public results will then remain unavailable. Closing a screen does not withdraw this permission.

Public records link your wallet address to the community, activity, song and song version. They include the session identifier, references identifying the source song and selected exercises, the assessor and assessment rules, start and completion times, completion status, result version and references to any earlier version it replaces. Karaoke publishes an outcome for every lyric line, with lyric and timing grades or a status explaining that no grade was recorded. Study publishes the selected lyric-line positions in lesson order and each line's first scored result: correct or incorrect, or unmeasured or unattempted when no scored result exists. Later successful retries do not replace misses from the first scored try. Recognized words and private retry history are not public result fields.

Study fixes four to ten distinct lyric lines before you record. Under the current qualification rules, you must complete the lesson, every selected line must have a grade from its first scored try, and at least seventy percent must be correct. Completing a lesson, getting its lines right after retries and qualifying on the first scored tries are different facts. Service failures are not wrong answers. Assessment and qualification rules may change for future practice within the public-data permission described here. Grades record an assessor's judgment; they do not prove a unique person or an honest live performance. Speech grades compare recognized words with lyrics and are not a validated pronunciation assessment.

Publishing results does not itself promise a reward. Rewards apply only when an explicit offer is shown for a song. That offer sets the eligible activities, deadlines, sharing rules and payment terms, and must distinguish money from simulated or practice-only balances. You may practise and build qualifying results without identity verification. If a reward offer applies, identity verification through Very/Palm is required when claiming winnings, rather than before practice. This publication permission does not authorize spending from your wallet.

Published results are permanent. Withdrawing permission stops results that have not yet been published; it cannot erase earlier public records. Authorized corrections or decisions that mark an existing result invalid can still be published after permission ends or is withdrawn. They keep the original learner, source song, selected exercises and completion period, and remain publicly linked to earlier versions. An older favorable result cannot replace a newer invalid or nonqualifying result.`;

export const learningV3Privacy = `Your microphone audio passes through the community operator to ElevenLabs for speech recognition. Karaoke sends audio as you sing; Study sends each recording for transcription. Both use provider logging. The operator and speech provider can process the audio and recognized words, and the provider may retain them under its service terms. The provider can access the audio: this pilot does not promise end-to-end encryption from that provider, zero provider retention or a fixed provider retention period.

The application uses raw audio temporarily for processing. It does not save raw audio in private history or include it in history downloads. Private history can contain expected lyric text, recognized words, timings, grades, selected lines and Study retries. While signed in, you can download supported history that is still retained. The Study menu currently offers the most recently opened lesson. The operator holds this downloadable data file; it is not a private encrypted vault controlled by you. Importing or editing a copy cannot create official grades or rewards.

You can download Study history for thirty days after the lesson's recorded completion time, or after its deadline if no completion time is recorded. Scheduled cleanup removes expired private lesson queues and attempts from active storage on its next successful run. Operator speech receipts expire thirty days after the recording is sent for processing. Karaoke history expires thirty days after the run. Failed cleanup is retried. The download deadline does not promise immediate physical deletion and does not control copies retained by the speech provider.

Public records remain permanent. For publication, later corrections or recovery of a result or payment, including already published results and unfinished or uncertain transactions, the operator may need to retain the source, compact result facts, publication permission, receipts, signed transaction data and conservative spending records. Uncertain connections to remote services are also kept until they can be reconciled. Copies of unpublished first-scored Study grades and selected lines held for publication are deleted only after checks of the public record prove that no result exists and no related operation is queued, signed or charged. If those checks cannot be completed, deletion is delayed. Ordinary private lesson queues, retries and attempts follow the scheduled cleanup above without needing that proof. Minimal records of used accounts, lessons and requests prevent repeated requests from creating new lessons or speech-processing calls. This pilot does not promise that all private or operational data disappears after thirty days.

Public results exclude transcripts, recognized words, optional tutor observations, recordings, private attempt identifiers and retry history. Public grades and selected lines can still reveal recurring difficulties. Using the same wallet address across communities links their public histories. Changing a display name or withdrawing permission cannot unlink records that are already public.`;

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
