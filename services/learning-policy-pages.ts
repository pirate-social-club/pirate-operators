// Factual testnet pilot disclosures. The public-field policy is pinned at enrollment.
import { learningV3PolicyPage } from "./learning-policy-v3.ts";
import { learningV4PolicyPage } from "./learning-policy-v4.ts";
export const learningTerms = `This community is a testnet learning pilot. Sponsored practice is limited by the available community allowance and may pause when that allowance is exhausted. Testnet results do not earn money, prizes or funded rewards.

Enabling public learning results authorizes automatic publication of each Karaoke run, including abandoned, expired and unsuccessful runs. Results include your MOSS wallet address, the song and content revision, final per-line outcomes and grades, completion time, and the applicable assessment policies. You approve enrollment once, until its expiry or your revocation. Scoring policies can change prospectively within this disclosed public-data scope. You may decline enrollment; public-record Karaoke then remains unavailable.

Publication is permanent. Revoking enrollment stops first publications that have not yet landed on chain. It cannot erase earlier records. Authenticated corrections and invalidations of existing public records remain possible. Recorded grades identify the asserting grader and do not prove personhood or an honest performance.`;
export const learningPrivacy = `Your microphone audio is sent through the operator to ElevenLabs for speech recognition. Live processing is visible to those services. The pilot does not provide end-to-end encryption from the speech provider. The current realtime adapter enables provider logging, so ElevenLabs may retain audio and associated recognition data under its service terms. This pilot does not promise zero provider retention.

The operator retains private recognized words, timings, expected text and assessment evidence for 30 days after a run, then removes those history copies. Raw audio is used transiently for processing and is not part of the history export. You can download retained session history while signed in. This is an interim operator-held history service, not the future learner-controlled encrypted vault.

Transcripts, recognized words, optional tutor observations and raw audio are excluded from public result events. Public line grades can still reveal recurring difficulties. Using the same MOSS wallet in several communities makes their public histories linkable. Later pseudonyms cannot unlink existing public records. Private history imports and edits do not create official grades or rewards.`;
/** V3 pages stay served for historical links; V4 pages only in a V4 community. */
export function learningPolicyPage(path: string, v4 = false): Response | null {
  const text =
    path === "/terms"
      ? learningTerms
      : path === "/privacy"
        ? learningPrivacy
        : (learningV3PolicyPage(path) ??
          (v4 ? learningV4PolicyPage(path) : undefined));
  if (!text) return null;
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
