# Community composer ports at 2890b093

This source adds `CommunityComposerHost` and real decentralized song and video
adapters. The default entry and shared styles remain protected, so the exact
mount patch is a coordinator proposal. The current session projection does not
contain the private account ID required by the host. Default mounting remains
held until the real private account producer is joined. This packet is source,
not UI, storage, provider or release acceptance. No execution gate was granted
apart from the pinned formatter and diff whitespace check.

## Host and ownership

`apps/web/src/media/community-host.tsx` exports `CommunityComposerHost`,
`CommunityComposerHostProps` and `CommunityHostContext`. The host supplies:

- The real community ID, name, canonical origin and default language.
- The current authenticated MOSS cookie session, fresh CSRF and public author ID.
- A separately obtained **private** account UUID, matching community and public
  author ID, and an active owner/route generation. Neither the public author ID,
  wallet address nor shell profile's `account` is this private account ID.
- Actual community capabilities/feed and a canonical feed refresh callback.

`current()` must return null during account settling, sign-out or an obsolete
route lifetime. It must change generation when that lifetime changes. Requests
capture account/community/author/generation; fresh CSRF may change without
changing the original publication envelope. Unmount pauses byte upload and
aborts the owner. Ignored aborts may still produce canonical replies: those
receipts are durably saved, but no old callback, next command or successor
reactive write is allowed. Reload/reopen performs reads; continuing an upload,
sealing or resuming a job requires an explicit action. There is no automatic
publication across a route or account change.

`CommunityPostComposer` has only a backend-specific song composition slot,
initial song mode/restored ID/draft key, and a callback disposal fence added.
The reviewed media client, attempt controller, video flow, owner lifetime and
all copied reference machines/controllers are unchanged.

## Native song workflow

`CommunitySongController` uses existing same-origin handlers, not the legacy
`SongUpload` component. The private draft captures request ID, exact reserve
JSON/digest, three immutable Files and their hashes before its first POST.
Each command is persisted before dispatch. Native operations are:

1. `POST /api/uploads` with the original idempotency key and exact consent body.
2. `PUT /api/uploads/:submissionId/audio` with the original MP3.
3. For each fixed instrumental/vocals slot, POST its SHA/length then PUT its MP3.
4. Explicit Post seals the same submission; the actual seal response or owned
   upload row supplies its job ID. A ready upload is never a Post receipt.
5. Read the same canonical job. Explicit resume is allowed only for a canonical
   `uncertain` job with `resumable:true`, through its existing resume endpoint.
6. Only a `published` job plus matching real feed and publication proof yields
   the copied observer's published view and feed refresh.

Lost reserve replies retain the original Files/body/key; reconciliation is an
explicit replay of that same idempotent reservation, never a title lookup or
new identity. Lost master/stem/seal replies first consult owned uploads and
sealed digest/length facts. Auth failures and unknown replies retain the draft.
The current owned upload listing is bounded to 20 rows; inability to find a
saved submission fails closed. A targeted identity lookup is proposed for
long-lived recovery, not invented as a client endpoint.

Native `uncertain` projects as reconciling, not a false failure claiming nothing
published. `held`/`failed` project as stopped, nonretryable processing failures
using actual error codes; no moderation review receipt is invented. The
canonical raw job remains saved. The native Check and resume action preserves
the same job. Start another release only forgets local state after a known
terminal job and no pending command; it does not erase server evidence.

The existing protocol has no song-abandon/delete endpoint. Stop upload aborts
the byte request and retains its uncertainty and Files. Unknown/incomplete
uploads cannot be discarded for a different identity. A real closure producer
is a remaining feature gate, not a successful no-op adapter.

## Source UI reuse and necessary departures

The owned `community-ui` composition, footer and Song step start from exact
Git blobs in 289's reviewed media copies. They retain the pure Solid source
controller, composer step state, responsive card/flat layout, file/artwork
handling, Back/Next, same-call advancing guard, error-stays-step behavior and
Post callback. They use the existing copied observation machine/store,
`PostedSong`, buffered/device seams and design-system components. Runtime
imports are owned source or the pinned UI package, never a reference checkout.

The prior immutable copies originate from exact c7cb8783 source, with copied
transition witnesses and story doubles under `apps/web/test/media-reference`.
This packet records exact 289 blob hashes and prior lineage; it does not
mislabel adapted files as byte-identical c7 originals. No new Storybook/browser
comparison was run. Coordinator reference captures are evidence of the
reference presentation, not a render of this candidate.

Backend-driven departures are explicit:

- The existing reserve endpoint already requires publication-policy consent.
  Therefore Song Next enters the existing policy/rights step, and that step's
  Next performs preparation only after actual consent. The original async
  advancing guard and failed/uncertain preparation behavior are retained.
- Current owner policy `pirate-owner-curated/2026-11-08/1` requires an explicit
  general/18+ declaration. Pure Solid Checkbox/RadioGroup fields replace
  unsupported licensing allocations in the existing step composition. No
  automatic content rating is claimed under this deferred analysis policy.
- MP3 master and both MP3 stems are required, each at most 25 MiB. Title is at
  most 200 characters, lyrics 32768 characters/2000 nonblank lines, language
  at most 35 characters. The older release policy is retained independently;
  `pirate-owner-curated/2026-11-05/1` refuses new submissions.
- Private account authorization replaces no persona identity. Credits, royalty
  splits, remix rights and published cover art lack an accepted producer and
  are unavailable. Embedded art is a local preview only.
- Observation belongs to this scoped host lifetime and is disposed on route
  exit. The same native durable job is recovered read-only on reopen. A shell
  feed-wide pending owner would require a shared lifetime mount; it is not
  silently claimed by this route-scoped composition.

## Durable storage

`createScopedBrowserStorage` uses native IndexedDB structured clone for File
and Blob. A required Web Lock spans the complete asynchronous operation across
tabs/workers. The key is community/private account/kind; one store revision is
loaded under that lock. Every strict-durability write transaction compares its
revision before writing. Remove advances a tombstone revision, preventing ABA.
Unsupported capability, version blockage, clone/storage failure, foreign scope
and stale CAS fail closed. Session/CSRF is not stored. No localStorage,
centralized auth or provider is used. Storage pressure eviction remains a
browser/platform limitation and must not be represented as server closure.

The native browser/worker cases prepare actual File/Blob round trips, two
instance and separate-context lock exclusion, bypass-writer CAS failure,
tombstones, foreign-account denial and actual host receipt/lifetime recovery.
They are unrun; these semantics are implemented, not yet platform-proven.

## Video and unavailable producers

`createCommunityVideoPorts` reads actual feed/proof/public audio, binds Post,
author/community/transaction/revision and audio SHA/length, downloads bounded
canonical bytes and owns/revokes its Blob URL. It does not infer a sample count
from container duration or equate Post revision with audio/song revision.
`CanonicalVideoSongFacts` and canonical interval preflight are explicit missing
producer inputs. The public capability is still denied before any reservation;
the host does not expose an enabled video flow. Existing public 3–15 second
rules, private Dance isolation/6–30 second policy, media erasure and backend
quota protections remain unchanged. Public object URLs are never introduced
for private recordings. Ready media never becomes a publication receipt.

Text publication, collaborators/splits, image processing/publication and a
private-account profile join are absent from this pinned runtime. Exact ports
and protected producer/mount work are listed in the packet. No endpoint,
accepted preflight, progress, account fact or publication is fabricated.

## Queued verification

Coordinator owns the unchanged Node test command, scoped web types and browser
bundle/harness. New Node cases exercise actual HTTP/controller/copied observer
and controller paths. Native browser entries exercise actual storage, worker,
composition and host lifecycle; they require the coordinator's real browser
harness, not unsupported Node flags. Candidate mounted DOM, responsive visuals,
source/reference comparison, all required full checks and provider/device
acceptance remain unrun. No production rights decision or live effect is made.
