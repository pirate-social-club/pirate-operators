# Media UI reference reconciliation, repair 1

The owner direction is owner-ui-direction-20261110.json: reuse the established
centralized app/Storybook UI, with no extra forms or speculative controls.
The exact adopted source is pirate-web-solid origin/main
c7cb87835a1858a1955c820b03d566365e6d42db, already pinned by this app's vendored
pure Solid package. Canonical and common Git were read-only; no fetch or package
upgrade was performed. No centralized authentication, personas, API or playback
mint runtime is imported.

The inspected reference files are the post-composer
video-original-audio-surface.tsx, video-feed/home-video-feed.tsx and its
Storybook, dance/dance-recorder-panel.tsx and dance/dance-review-page.tsx.
OriginalVideoCaptureSurface and OriginalVideoReviewSurface are independently
adopted in reference-capture.tsx, with imports redirected to the existing pinned
design-system modules through reference-ui.ts. They keep the viewfinder, record
control, camera errors, mobile header, footer action and review preview geometry.
MediaUpload now adapts those surfaces rather than rendering a new file form.
Private Dance specifically adopts the DanceReviewPage ActionFooterShell branch
in dance-review-surface.tsx: compact Your recording header, full-height private
preview and the existing submit/resume action. The public video review frame
is used only for public video. Private Back returns through the host route and
does not withdraw or discard the recording.

Private Dance provides the existing capture controller/preview and finished
recording. Its completed take uploads and prepares automatically, matching the
reference recorder-to-processing-to-review journey. The review action is Submit
for review and calls the injected actual Dance submission port. Upload/ready
does not submit or start retention. No extra approval step, per-verdict wallet
interaction or second capture pipeline is introduced. A missing submission or
capture adapter does not render an inert submit/record control. Central copy
such as Your recording, Your recording is being prepared, Resume upload, Check
again and Record again is retained. RecoverLostSubmit's Resume submission action
re-enters the same immutable media command through the Dance adapter, rather
than silently creating another submission. A completed public Post leaves the
review surface and never offers Post again.

Public video keeps Choose a video → Review video → Post. The native file input
is hidden behind the reference chooser action. Clicking Post supplies explicit
public consent; the bespoke consent checkbox is removed. Public capability
denial disables posting and explains current unavailability. Private Dance has
no public-posting toggle while owner policy is undecided. Private camera errors
do not offer an unwired upload fallback. Frozen song selection is rendered as
read-only text where changing it is unavailable, instead of an inert button.
These are permission/binding departures required by this backend, not new flows.

The public feed uses the actual pinned VerticalFeed, VideoPlayer and MediaMore.
It keeps full-height scroll snapping, ArrowUp/ArrowDown navigation, reference
phone/desktop 9:16 geometry, play/pause, muted playback, More → Mute/Unmute,
soundtrack navigation, loading/error/empty copy and bounded continuation.
Native feed video controls, hand-built bordered cards and the separate CSS
module are removed. The host-rendered-row seam supplies real media to the same
playback context. This avoids fabricating the author handle, profile, social
counts, report, follow or like actions that the media API does not supply.
No placeholder media rows or sample content are generated. The term placeholder
in the pure component's type names denotes its host-render callback, not a
fabricated feed item.

## Source and Storybook comparison evidence

This is a comparison of pinned source and Storybook interaction contracts, not
a claim that the Storybook play functions ran in this constrained lane.

| Reference story or source | Media mapping | Necessary departure or remaining gate |
| --- | --- | --- |
| HomeVideoFeed.PlayableLinked | Real full-height media, soundtrack callback and VideoPlayer; native feed controls absent | Author/social rail omitted because the media API provides neither identity projection nor social actions/counts |
| HomeVideoFeed.MuteControlPolicy, SignedInMobile, MobileMoreSheet | Same MediaMore menu/sheet and controlled muted state | Report omitted until an admitted report service exists; no inert Report or Boost |
| HomeVideoFeed.SongActivities | Existing soundtrack route reaches the song | Study/Karaoke rail buttons require shell-supplied authoritative readiness/actions; no speculative buttons in this media API |
| Dance Recording review.ReadyToSubmit, SubmitPrivately | Actual private preview and Submit for review, after automatic upload/preparation | Public-choice switch omitted while posting rights remain undecided; private submission proceeds |
| Dance Recording review.RecoverLostSubmit | Resume submission re-enters the same Dance-owned idempotent command | Consumer adapter must retain/reconcile original command and receipt; no new media or deadline |
| DanceReviewPage header and preview | Same compact Your recording header, flexible private preview and host Back route | Back does not erase; no public-video review frame for Dance |
| Dance Recording review.ChangePendingChoice, PostingAccessUnknown | No fabricated publication choice/check controls | Pending public choice remains outside admitted policy; owner decision and real authority service required |
| Dance Recording review.CancelPendingReview | Existing Dance review controller owns the confirmed cancellation flow | Media uploader does not duplicate review cancellation or promise that a D1 write cancels an already ordered verdict; canonical fence protocol remains held |

The Dance Storybook explicitly declares a 390 × 844 viewport and fixture-only
responses. Its dimensions are a reference target, not new device evidence.
Exact source hashes, story identifiers and target mapping are retained in
.local/media-owner-ui-comparison.json. The one new focused view-state regression
proves a completed public post cannot reopen Post while a prepared private
recording still requires actual submission.

Source hashes and mapping are in v1-video-source-provenance.json. Focused type
checks cover these adopted components. This repair deliberately performs no
browser/build sweep because the heavy-check slot was not granted. Exact visual,
keyboard and device comparison after shell mounting remains a coordinator gate;
the earlier bespoke-UI screenshot is not evidence for the repaired UI.
