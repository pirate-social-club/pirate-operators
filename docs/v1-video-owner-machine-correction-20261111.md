# Media composer source port

This source-only port targets reviewed main `af714492e1065970652d24f0644b32829d38b8ea`.
The exact selected reference is `pirate-web-solid` Git object
`c7cb87835a1858a1955c820b03d566365e6d42db`. Copies were read with `git show`
from that object, not from the checkout's older filesystem contents.
The source and test/story inventories record original blobs/digests separately
from the final adapted file digests. Copying establishes provenance, not acceptance.

The shell-owned Post action belongs beside community identity. Mount
`CommunityPostComposer` in `CommunityPageShell`'s main feed slot while composing.
The existing `TextPostPanel` supplies the desktop card and flat phone form,
including close, required title, body, Song/Video row and phone Post footer.
`PostComposer` supplies the actual song steps, rights and review composition and
its original controller/invariants. `VideoComposerSurface` retains the original
capture/song-choice/review/retained JSX composition. The host supplies explicit
ports. It owns navigation, Back, chrome, account admission and component lifetime.
The entry mount proposal is for `apps/web/src/live/entry.tsx`; that file was not edited.

## Flow ownership

The actual XState video statechart is copied, including restoring, choosingSong,
checkingPlayback, nested capture states, review, submitting, retained,
refreshing and startingOver. Its `ComposerOperations` seam now uses the actual
media HTTP adapter and the pinned browser media implementation. There is no
replacement reducer. The copied `useOwnedActor` preserves Solid 2 deferred sends.
The returned capture File goes directly through the machine's operation result;
upload does not immediately reread a deferred Solid signal.

The original text machine and application-owned store preserve the exact request
envelope/key through unknown replies, auth pause/resume, conflict reads and
definitive refusals. The store requires a real `TextSubmissionTransport` and a
pure envelope preparation port; centralized transport and session defaults were
removed. The source store is memory scoped and does not promise text reload
recovery. Its owner must outlive the composer. No decentralized text service is
currently supplied, so text Post remains unavailable until that port is admitted.

The original song observer and store preserve retry/read-after-unknown,
original-binding recovery, pause/resume and settled outcomes. The service port
projects its actual receipt to the typed `SongSubmissionView`; no generated
centralized client is imported. The original `PostedSong`/`PendingSongs` views
consume those actor results. Song publishing requires a real coordinator,
`SongFlowRuntime`, source and capability; no adapter currently supplies these.
No fake preparation, song identity, progress or publication receipt is returned.

## Backend-driven departures

- Media has reservation/upload/status/retry/withdraw endpoints, not the reference
  multipart reservation/start/finalize/Post protocol. `MediaAttemptController`
  implements this real protocol behind `ComposerOperations`; mapping it to fake
  central submission IDs or part receipts would be incorrect. Request ID,
  recording digest, File, song/revision/audio digest, command and job ID survive
  uncertainty in required durable exclusive account/community storage.
- Lost reserve replies replay the same intent. Lost upload/retry replies first
  read canonical job state. Receiving/queued/processing never cause another
  upload. A retry that may have completed requires another explicit author action
  before spending another retry. Pausing aborts bytes and retains late replies.
- Pending withdrawal denies local playback immediately and persists until a
  terminal server answer. Playback accepts only the exact same-origin authorized
  `/api/media/:id/playback` path. Ready receipts validate frozen authority/bindings.
- Media upload acceptance and media readiness are distinct from a published Post.
  Queued/processing means upload accepted; `onMediaReady` requires an actual ready
  receipt. No public Post ID/href or publication success is synthesized. Retained
  media stays recoverable after the composer closes.
- Source Post IDs and audio revisions are independent of decentralized song keys
  and song revisions. The required `pirate.video-song-resolution/1` port verifies
  that mapping, with canonical audio digest and community. It never equates the
  two revision domains or creates placeholder songs.
- Public posting remains explicitly denied by the existing owner policy. A fresh
  public attempt cannot reserve/upload. The independent public clip bound stays
  3–15 seconds. The picker clamps the service's advice to that bound; it cannot
  manufacture an accepted service verdict. Private Dance uses its existing
  isolated uploader, injected/versioned 6–30 second profile and trusted seven-day
  retention unchanged. None of the private backend/authorization/erase fences was
  changed, and no private attempt can restore into this public composer actor.
- Existing decentralized account authority replaces centralized persona/session
  runtime. There is no profile picker, localStorage auth fallback or centralized
  API implementation. Missing transports remove entry actions or show the existing
  unavailable note. Account/community changes dispose the previous composer.

## Reference comparison evidence

Coordinator capture receipts bind exact c7 Storybook renders in
`parallel-execution/design-correction-20261111/reference-storybook-c7cb8783/captures.json`
and `parent-reference-flow-captures/receipt.json`. This actor read those receipts
and visually inspected the existing `post-form-mobile.png`,
`post-form-desktop.png` and `feed-mixed-desktop.png` images. The phone form has a
flat surface and fixed footer; desktop replaces feed content inside the community
page; the mixed feed uses an authored PostCard with a compact SongPlayer.
No fixture account, profile, balance or song facts were copied into product ports.
The shell actor owns the actual page/feed/player hierarchy outside media scope.
No candidate rendering or visual equivalence is claimed.

## Tests and remaining gates

Exact c7 machine/coordinator transition tests and authoring/delivery story sources
are retained as `.reference` witnesses under `apps/web/test/media-reference`.
They keep their original Vitest/central protocol harness for comparison and are
not falsely represented as executable in this application. Extracted storyGuide,
canvasStream, captureDouble and generated-media helpers are separate test-only
source doubles, with the original timing/failure behavior; product imports none.

`apps/web/test/media-machine-adapters.test.ts` prepares bounded Node cases using
the actual XState actors and actual `mediaClient` over explicit in-memory HTTP
responses: same-intent replay after lost acknowledgement, canonical upload
recovery, abort/pause, pending erasure, server denial and public capability refusal,
text original-envelope/auth hold, song retry/original binding recovery and exact
ready receipt/authorized playback checks. The video interruption case follows
the c7 transition test. These cases have **not run**.

Only pinned Prettier 3.6.2 and `git diff --check` may execute in this source turn.
All typechecks, tests, Storybook/candidate visual comparison, browser/build and
device/Worker/chain checks remain coordinator-owned and unrun. XState 5.33.2 is
owner authorized under coordinator manifest custody. The copied exact browser
device/story implementation also imports c7's Mediabunny 1.55.5; its dependency
proposal requires coordinator disposition before those modules can typecheck or
run. No manifest, lock, dependency installation or shared mount was changed.

No provider, resource, credential, deployment, financial, public-chain or production
effects were performed. The final handback seals source, evidence and proposals;
it does not grant public posting, release acceptance or a new execution slot.

## Coordinator source closure, November 11

The first exact web typecheck reported the zero-parameter keyed Show callback, an optional spread for a required song-picker source, and a missing original capture/review surface. The coordinator supplies the keyed identity parameter, passes the already-required song source directly, and copies video-original-audio-surface.tsx from the exact c7 source blob 2b1fc38d138b002a75d2d72cd299c531d8cf6a20. Its only semantic seam is the owned design-system import; markup and interactions stay from the source. Earlier sealed manifests remain unchanged. Eleven real machine/HTTP-adapter cases passed before these typing/composition repairs; subsequent type/build/render qualification remains required.
