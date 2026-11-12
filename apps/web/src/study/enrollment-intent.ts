import { post } from "../live/api.ts";
import {
  ensureStudyEnrollment,
  type StudyEnrollmentView,
} from "../live/study-enrollment.ts";
import type { KaraokeWallet } from "../live/learning-consent.ts";

/** Owned adapter for the existing V3 MOSS enrollment choreography. The account
 * is captured once for BOTH actual requests; it is an expected-identity fence,
 * never a replacement for the cookie, CSRF, Origin or learner signature.
 */
export function enrollStudyForAccount(options: {
  account(): string;
  csrf(): string;
  active(): boolean;
  wallet: KaraokeWallet;
}): Promise<void> {
  const account = options.account();
  const headers = Object.freeze({ "x-study-account": account });
  return ensureStudyEnrollment({
    active: () => options.active() && options.account() === account,
    wallet: options.wallet,
    request: () =>
      post<StudyEnrollmentView>(
        "/api/karaoke/enrollment",
        { activity: "study" },
        options.csrf(),
        headers,
      ),
    submit: (request, signature) =>
      post<{ state: string }>(
        "/api/karaoke/enrollment",
        {
          enrollment: request.message,
          target: request.target,
          signature,
        },
        options.csrf(),
        headers,
      ),
  });
}
