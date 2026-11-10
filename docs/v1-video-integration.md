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

Lane 4 consumes readyForReview(id, exactBinding, reviewer), then includes
MEDIA_COMMIT_GUARD and mediaCommitValues(witness, authoritativeCommitMs) in
its verdict INSERT ... SELECT ... WHERE. Every guard uses positional bindings.
The verdict write must include current reviewer delegation, identity,
self-review, current song/rules revision and offer-window predicates in the
same authoritative operation. The media predicate alone does not confer review
authority or qualification. A stale revision after withdrawal/expiry inserts
zero rows. Do not implement read-then-unconditional-insert. The seven-day media
retention starts at reservation; if Dance needs a later submit deadline it must
bound its review deadline to media expiry or admit a versioned retention change.

Dance can supply privateReviewPolicy with a frozen version and integer sample
bounds. The ready facts carry mediaPolicyVersion; lane 4 must freeze and verify
it along with its selected reference/rules. Public clips always keep song-clip/1
(3–15 seconds); changing the private policy cannot widen public publication.

Shell mounts MediaFeed with a MediaClient and its existing song-route callback.
Mount MediaUpload with purpose, server-selected song interval, the relevant
permission capability, a fresh CSRF getter in mediaClient and optional
initialMediaId. Persist a private Dance media ID in the Dance draft, so a
refresh can resume status; do not put account credentials or recordings in
localStorage. onReady receives immutable ReadyMedia for submission binding.
Withdraw and erase is available independently of review; lane 4 must handle
withdrawn media at verdict commit. Public consent is separate and explicit.
Feature styles are a local CSS module; no shared stylesheet edit is needed.

Tests: node --test --test-concurrency=1 test/community-media*.test.ts, root
npm run typecheck and apps/web npm run typecheck. Local synthetic media exercises
D1, R2, render transport, FFmpeg and range HTTP. A fixture viewport screenshot
does not establish real member/phone or deployed provider acceptance. Before a
release the coordinator still needs exact-head independent review and all
required CI, shell mounting, physical phone playback by another account, an
admitted real clip, bounded processing-host deployment and erasure readback.

Workers binding details were checked against the official R2 Workers API and
D1 database documentation on 2026-11-10:
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
