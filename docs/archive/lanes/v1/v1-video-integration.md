# Media v1 integration handback

The public interfaces are in packages/community-media/contracts.ts. Lane 3's
service constructor is CommunityMedia(CommunityMediaPorts), its HTTP adapter
is communityMediaApi(request, service, authorization), and its UI exports are
MediaFeed, MediaFeedCard and MediaUpload. All adapters are independently owned
here; the centralized runtime is not imported.

Coordinator applies packages/community-media/schema.sql through the next
contiguous migration ordinal. The lane deliberately reserves no ordinal and
does not initialize schema on public requests. Construct MediaRepository with
the existing community D1 database and verified community ID, and supply the
existing private MEDIA bucket. Object keys are isolated below community-media/.
No bucket public URL, new contract or chain write is needed for this media
slice. The existing song publication schema and manifests remain separate.

Mount communityMediaApi before the application's generic API 404. Return its
response only when it is defined. The authorization adapter must call the
existing authenticatedWrite for every mutation and map account_id to
accountId. For reads use accountSession; anonymous public reads may return
null on that function's 401 only. Preserve every other authorization failure.
Supply the exact configured HTTPS origin. The media adapter additionally
requires exact Origin on writes, but does not replace session/CSRF protection.
It must never accept account IDs, reviewer roles or community IDs from headers
or JSON supplied by the browser.

CommunityMediaPorts.active must consume lane 6's current community account
authority, including revocation and pending sign-in fences. song must read the
current published song and require the requested exact revision; map the
canonical server-probed audio sample count at 48 kHz and SHA-256, never a browser
duration or unverified gateway metadata. audioSha256 is lowercase hex without
0x. The song key remains the existing application's canonical song key.

Until the owner decides posting rights, use PUBLIC_POSTING_UNDECIDED for
publicPosting. This server gate is rechecked on reservation, ready commit,
feed inclusion and public playback. reviewAuthority must consume lane 4's
current owner/delegation reader in this community and recheck every private
media access. No injected function may turn an unknown or failed authority
read into permission. A public-post capability is not a Dance verdict.

The default atomic reservations are five active media records per account,
100 per community and 1 GiB of reserved source bytes per community. Limits may
be reduced in the server ports; zero/invalid values fail closed. Erasure-pending
records keep capacity reserved. Renditions are separately bounded at 32 MiB;
at most one successful rendition and one source per record are retained, with
temporary unique job outputs cleaned after refusal and by tombstone sweeps.
These are local conservative defaults, not approved production spending limits.

Route queue messages with an explicit discriminant, for example
{kind:"community-media/1",communityId,mediaId}. The queue consumer must verify
the configured community, await service.process(mediaId), and acknowledge
only after return; infrastructure/storage errors should retry. Processing
failures deliberately persist failed state and wait for a bounded explicit
retry. The scheduled handler should run service.recover(cursor) in bounded
pages and persist the returned cursor until null, then restart at the beginning
next sweep. It expires uploads and private media, recovers dead leases,
re-enqueues durable queued intent and retries object erasure, including late
objects under tombstones. Keep the existing song job envelope intact.

The Worker uses BoundMediaProcessor with a trusted private transport. A
community-operated Node host wraps communityMediaRender with
FFmpegMediaProcessor, a private temporary directory, a verified loadSong reader
and MediaRenderAuthority. That authority MUST authenticate the calling service,
read the authoritative current media claim and resolve current song facts.
Do not expose this route to browsers, accept a user-selected origin, or use
an always-true authorize callback outside the explicitly labeled local test.
The binary v1 protocol streams a bounded JSON frame and the sealed source;
output bytes and facts return to the Worker for final SHA-256 and claim checks.
FFmpeg is never imported by Worker source. The host and service authentication
are source-ready interfaces, not provisioned resources. Alchemy/Infisical and
processor-host selection remain coordinator-owned deployment work.

Repair 1 consumes the proposed pirate.dance-admission-contract/2. Lane 4 first
uses readyForSubmission(id, exactBinding, uploader), which verifies current
uploader authority, song, recording binding, private policy version/bounds,
readiness and unsubmitted expiry without requiring a reviewer role. If a
prospective capture omits recordingSha256, the adapter may read the owned record
for that one field; it must never replace expected community/account/song/policy
or segment fields with stored values to bypass prospective binding checks.

Prepare retention with prepareMediaSubmission(repository, witness, submissionId,
bindingCommitment, acceptedSubmissionFence). Execute beforeAcceptance, the
actual Dance acceptance statements, then afterAcceptance in ONE D1 batch with
the current identity/rules/capture fences. The final trusted SQL fence must
prove a matching accepted Dance receipt, including media ID, binding commitment,
trusted time, deadline and media revision. Omit or fail actual acceptance and
the entire batch rolls back. Do not execute retention separately before submit.
No browser retain endpoint exists.

The winning insert into community_media_submissions captures database time
once. Dance inserts its actual receipt by SELECTing submitted_at_ms, deadline_ms
and media_revision from that row, bound to community/submission ID. deadline_ms
is submitted_at_ms + 604800000 and is exclusive. Unsubmitted private media has a
separate 48-hour TTL, independent of the one-hour upload TTL. Identical replay
retains original time/deadline. A different binding or submission ID cannot
retarget this recording. Read mediaSubmissionReceipt after an unknown batch
response before retrying the same identity. Missing/unreadable receipt is
unknown, not proof of rollback.

Retention increments the lifecycle revision once. Freeze the receipt's
mediaRevision in Dance, not the pre-retention witness revision. readyForReview
continues to require an authorized non-self reviewer. For a D1 pending decision
intent, include MEDIA_COMMIT_GUARD and mediaCommitValues(witness, trustedTimeMs)
in its conditional insert with current reviewer, identity, rules and offer
fences. Do not implement read-then-unconditional-insert. This fences local
pending intents only: final canonical on-chain verdict/control ordering remains
held under the successor Dance contract. Local access denial and byte erasure
never promise cancellation of a transaction already ordered on chain.

Dance must explicitly inject DANCE_PRIVATE_MEDIA_POLICY (pirate.dance-private/1)
with 6–30-second integer sample bounds. Missing or different bounds deny private
reservation/capability. The ready facts freeze mediaPolicyVersion. Public clips
always keep song-clip/1 (3–15 seconds). Apply the appended lane-local submission
tables through coordinator-assigned contiguous migration sequencing.

Shell mounts MediaFeed with a MediaClient and the existing song-route callback.
MediaUpload receives purpose, frozen selection, permission capability, optional
initialMediaId and a real onClose route callback. Private Dance provides its
existing capture controller and finished recording via capture/recording props;
this adapter creates no second recorder or file-picker form. It uploads and
prepares the finished take, then uses the actual DanceReviewPage pure layout
(compact Your recording header and full-height private preview). Private Back
invokes onClose and does not discard/withdraw. The public video frame remains
only in public review, which ends after Post succeeds. onReady is readiness
only. onSubmit must call actual trusted Dance acceptance and is the only
submission action; no submit control appears without that adapter. It must own
one durable command identity for this exact capture/media and reconcile it when
re-entered through Resume submission after an unknown response. Never generate
a new submission or deadline merely because that callback is called again. Persist
the media ID in the existing Dance draft, not new localStorage authentication.

Public consent is the reference Post action. The centralized Dance public
posting toggle stays omitted while the owner policy is unresolved. The pinned
pure Solid design system and independently adopted capture surfaces replace
the bespoke CSS/form/cards. See [UI reconciliation](v1-video-ui-reference.md).

Repair validation is limited to single-worker media tests and focused backend
and UI type programs. No full npm check, browser or build sweep was admitted.
Real clip, physical phone/another member, actual deployed erasure, private host
authentication, canonical ordering, independent review and required release
checks remain separate coordinator gates.

Workers binding details were checked against the official R2 Workers API and
D1 database documentation on 2026-11-10:
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
