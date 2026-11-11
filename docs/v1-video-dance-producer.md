# Media producer projection for Dance v2

The controlling review is dance-interface-review.final.txt and the proposed
successor is pirate.dance-admission-contract/2. Media remains the sole upload,
processing, retention and playback pipeline. The small producer projection in
packages/community-media/dance-projection.ts provides explicit facts for the
Dance-owned consumer adapter; it does not add a second pipeline or authority.

| Producer field/source | Consumer meaning | Unit and rule |
| --- | --- | --- |
| ReadyMedia.readyAt | DanceMediaFacts.readyAtMs | Same integer Unix milliseconds; no scaling, rounding or upload/submission inference |
| ReadyMedia.expiresAt | DanceMediaFacts.expiresAtMs | Same integer Unix milliseconds; current access expiry |
| MediaSubmissionReceipt.trustedSubmittedAtMs | Actual accepted Dance submission time | Trusted database receipt, stored once in the actual acceptance batch |
| MediaSubmissionReceipt.reviewDeadlineMs | Exclusive review deadline | trustedSubmittedAtMs + 604800000; never readyAt, reservation, upload or retry time |
| MediaSubmissionReceipt.mediaRevision | Submitted media lifecycle revision | Post-retention revision, not the earlier readiness witness |

Use readyForSubmission(id, exactBinding, uploader) for an authenticated active
uploader. Use readyForReview(id, exactBinding, reviewer) for a current authorized
non-self reviewer. Both recheck exact community/account/song/audio/recording,
policy, lifecycle and expiry. Pass the returned media/witness pair into
projectDanceMedia. Its result has explicit readyAtMs/expiresAtMs and contains
neither uploadedAtMs, submission time nor a playback/object URL. Projection is
not access authorization; consumers must obtain fresh accessor results and
recheck each private GET/HEAD/range through the existing playback service.

Unsubmitted private media has a separate 48-hour TTL and uploads have a one-hour
TTL. Actual submission uses prepareMediaSubmission beforeAcceptance and
afterAcceptance in the SAME D1 batch as accepted Dance submission and its live
authority/rules fences. The mandatory accepted-submission assertion prevents
retaining a recording without the actual accepted receipt. Identical retries
reconcile the same receipt, time, deadline and binding; they never extend the
window. Read mediaSubmissionReceipt after uncertain outcomes. After retention,
obtain fresh media facts and use projectDanceSubmission with that receipt. It
rejects a mismatched post-retention revision, earlier expiry or wrong seven-day
deadline; it never derives submission time from readiness.

Explicitly inject the independently versioned private Dance 6–30-second profile
(pirate.dance-private/1). Missing/different bounds deny private reservation.
Public song-clip/1 remains independently 3–15 seconds. The private bounds follow
the verified api-next f017e801 no-pose intake; no pose or numeric-score source is
introduced here.

MEDIA_COMMIT_GUARD fences a D1 pending intent only. Current actor/identity,
song/rules and offer fences must join that winning operation. It cannot cancel
an in-flight chain transaction or establish a final verdict timestamp. Final
eligibility follows the proposed canonical authority/media fence ordering and
canonical verdict block time; that source/contract integration remains held.

Local media withdrawal/revocation stops playback immediately when its local
denial is persisted, regardless of pending canonical confirmation. The Dance
consumer must compose pending withdrawal intent with local media denial and
must not leave media locally ready while calling its review withdrawn. Every
subsequent playback request observes the local denial; no public bucket or
bearer object URL bypasses it. Already delivered bytes cannot be recalled.

The observed Dance draft still has a single media port, uploadedAtMs and an
upload-derived deadline. It must migrate to the two accessors, explicit
readyAtMs/expiresAtMs projection and actual submission receipt before consumer
integration can pass. Do not alias readyAt into uploadedAtMs and leave its
deadline calculation in place. Those consumer changes are owned by Dance;
this lane does not edit its paths or claim integration acceptance.
