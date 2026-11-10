# Community media v1

Written before implementation on 2026-11-10 for lane 3 at base
67cbe118ade39790bc1539999ca75d0d7ff10b6d. Repair 1 updates this specification
to version 2 from preserved source 9a58ff463f0e09dd89b5d60ef89e483d60c04a19.

The behavior reference is api-next origin/main
f017e8014001a31d07b9e2de891e0907ad194b50, particularly
packages/domain/src/video-submission.ts (interval policy revision 2), its
interval tests, and apps/media-processor-worker/src/video-workflow.ts. The
centralized product uses CloudConvert rendering and Stream delivery. No
centralized authentication, runtime, service bindings or source imports are
adopted. The code in this lane is independently implemented.

Each community owns its database, private object bucket and processor. D1
persists intent, generation and lifecycle before effects. R2 holds immutable
originals and MP4 renditions in community/media/generation scoped keys. A
community-operated FFmpeg runner verifies inputs and renders H.264/AAC MP4
with faststart for short phone playback. The reference's CloudConvert/Stream
provider choices are not required for community independence. No Containers
deployment is implied. Alchemy must admit any eventual provisioning; Infisical
owns eventual service credentials. This lane performs no provider writes.

R2 has no public bucket URL. Public feed playback goes through a community
GET/HEAD endpoint supporting byte ranges. Private review uses the same endpoint
but requires a current authenticated account and current review authority on
every request, including seeking. URLs carry no bearer token. Responses are
private/no-store with nosniff and same-origin resource policy. This short-clip
MVP deliberately uses revocable community delivery rather than irreversible
IPFS pinning for video, refining docs/contracts/media-publication.md for these
assets only. Songs keep their existing immutable publication path.

Public posting rights remain an owner decision. The server exposes
canPostPublic plus a reason; the unconfigured policy denies it to everyone.
Private Dance upload is independent and enabled for active accounts. A Dance
pass cannot change audience. A public post requires a separate upload intent,
explicit publication consent and an admitted posting capability, rechecked at
processing commit and playback. Moderation may revoke media independently of
Dance verdicts. Content-policy admission for public posts is an injected
server policy gate; absent permission never becomes permission by default.

Every reservation freezes community, account, published song key and exact
revision, song audio SHA-256, canonical audio sample count at 48 kHz, selected
half-open song interval, uploaded recording SHA-256 and byte length, purpose,
creation and expiry. The server resolves published song facts; client-provided
durations are never authoritative. Song video intervals are 3–15 seconds,
inclusive, and cannot exceed canonical song length. Private Dance requires an
explicit server-injected versioned 6–30-second policy from lane 4. Missing or
different bounds deny private reservation; there is no public-policy fallback.

The original is bounded at 32 MiB and uploaded through an authenticated binary
PUT. Actual received length and SHA-256 must match reservation. Processing
probes the source and exact canonical song bytes, requires a video stream and
enough source frames, strips source audio and metadata, and overlays the exact
selected song segment. Actual decoded video-frame timestamps and durations must
cover the interval without gaps; a long audio/container duration cannot extend
a short picture. Output video timing is checked independently again, and ready
duration comes from that visual timeline rather than container duration. A
ready record freezes recording and rendition digests, duration, codecs and
generation. Original bytes are never a playback fallback.

Lifecycle: uploading → queued → processing → ready; transient failures → failed
with a safe error and bounded retry; uploading/queued/processing/failed/ready →
withdrawn or revoked; any live record → expired at its exact expiry boundary.
An upload expires after one hour unless processed. Unsubmitted private media
has a separate 48-hour TTL. Actual accepted Dance submission atomically records
trusted database submission time and retains media for exactly seven days from
that time, with an exclusive deadline. The media retention plan must share the
winning D1 batch with the actual Dance acceptance and its identity/rules fences;
its mandatory final accepted-submission assertion rolls the batch back if no
matching acceptance exists. Replay retains original time and cannot extend the
deadline or retarget this recording into another submission. Public
delivery retention is 30 days until a reviewed policy replaces it. Worker
claims use a generation and expiring lease; a lost worker can be retried after
lease expiry. A maximum of three attempts prevents an endless retry loop.
Output keys include the worker claim token so a stale worker cannot overwrite
a later successful rendition. Only the current claim can commit readiness.
A lost write response is never treated as rollback. Cleanup reconciles the
canonical source/rendition reference first and must disarm the old conditional
commit with a newer revision before deleting an unreferenced object. Unknown
reads or fencing outcomes preserve objects for reconciliation.

The implementation names the upload-in-progress lease state receiving. Atomic
reservations default to five active records per account, 100 per community and
1 GiB of reserved source bytes. Pending erasure keeps its capacity reservation.
Private Dance can supply a server-selected versioned duration policy; ready
facts freeze mediaPolicyVersion. Public intervals always retain song-clip/1.
The private processing transport streams a v1 frame to an authenticated
community runner, which rechecks the current claim and song before rendering.

Cancellation/withdrawal invalidates access immediately in D1, increments its
revision and erases all object keys under the media prefix. A running worker
rechecks lifecycle before commit and deletes its late output after refusal.
Every terminal sweep restores/persists erasePending before touching late
objects, even after a previous successful sweep. Failed cleanup therefore
retains quota accounting. Scheduled recovery requeues durable queued records, recovers expired leases,
expires records and retries erasure. Erasure failure remains recorded for
recovery, with no playback while pending. Minimal tombstones keep binding and
deduplication facts; they retain no media bytes. Downloaded copies and bytes
already delivered cannot be recalled. Physical erasure/retention of any future
provider copies needs its own acceptance evidence.

Feed ordering is readyAt descending, then media ID descending, using an opaque
exclusive cursor. Only ready public-feed items with unexpired media and valid
current publication authority appear. Private IDs, objects, account IDs and
processing details are never serialized into the public feed. The established
pure Solid VerticalFeed, VideoPlayer and MediaMore provide full-height snapping,
play/pause, muted playback and the soundtrack link, without native feed controls.
Capture/review uses independently adopted pure centralized surfaces. No
autoplay with sound. Empty, waiting, failed, unavailable and revoked states
are explicit. No fake feed rows or counts are generated.

## Dance interface successor

packages/community-media/contracts.ts defines private-review purpose,
MediaBinding, ReadyMedia and MediaReviewWitness. services/community-media.ts
provides uploader-authorized readyForSubmission(id, binding, uploader), distinct
from readyForReview(id, binding, reviewer), rechecking current actor authority,
owner self-review exclusion, exact binding, song revision, state and expiry.
It returns a witness containing media ID, community, revision, digest and
expiry; the witness is not a playback capability. Lane 4 must insert a pending
intent with the exported media predicate in the SAME D1 operation, using the
trusted database clock and rechecked reviewer authority. A
separate read followed by an unconditional verdict write is unsafe. Withdrawal,
revocation and lease changes increment revision, so stale witnesses fail.
The media record never fabricates qualification or score. Lane 4 owns frozen
rules, seven-day verdict timing, decision uniqueness and economic admission.
This D1 predicate fences pending intents only. Final verdict/control ordering
and authoritative verdict commit time belong to the proposed canonical on-chain
source in dance-admission-contract/2 and remain held.

## Evidence and integration gates

Focused tests must exercise actual HTTP handlers, D1/R2, FFmpeg rendering,
digest mismatch, revision mismatch, range/HEAD playback, private/public
isolation, capability denial, worker races, withdrawal/expiry and retry.
Synthetic local AV proves pipeline execution only. A permitted real clip,
another account on a physical phone, provider deployment, policy/rights
decision, production processing budget and actual erasure readback remain
coordinator acceptance work. Shared mounts, schema application and configuration
are delivered as .local proposals; this lane edits no shared entrypoint.
