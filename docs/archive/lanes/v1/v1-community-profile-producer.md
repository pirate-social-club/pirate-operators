# Community-owned profile producer, version 1

Specification before implementation. Source base is
`83209be8033599c0aad059c24815e0fa75d433dc`; control receipt is
`10daf29ee7bd8dc0cdc18d5af3b64ec11710e4e4`. No migration, test, build or runtime
activation is performed by this source lane.

The community owns one local profile per existing account. The server resolves
ownership through `accountSession`/`authenticatedWrite`; request bodies never
select an account, binding or wallet. `application_identity` must match the
current community and origin. Account IDs remain private, while the existing
random public author ID is the public lookup key. Neither becomes a name.

`GET /api/profile/owner` returns a private, no-store owner view containing the
real account ID, public profile and revision. No metadata row is created by
viewing, signing in or reading activity. An absent row is revision zero with
null display name, biography, avatar and cover. The source's generic `Profile`
label is the empty state, not published metadata or a handle claim.

`GET /api/public/authors/:authorId` and bounded `GET /api/public/authors?ids=…`
return only public author IDs, explicitly supplied public fields and revisions.
They never return account/binding/session/wallet fields. Display name is a local
public field, never a verified handle. No handle purchasing, global name,
credential replacement, merge, signup or membership workflow is introduced.

An explicit `PUT /api/profile/owner` may replace the bounded nullable fields
with `expectedRevision` and a retained UUID `mutationId`. It requires the
current session, Origin and CSRF, exact fields and a live-session SQL fence.
The atomic D1 batch claims the command, applies exact revision/CAS, and stores
its original public result. Replaying the same command returns that result;
reusing its key with different bytes conflicts. Unknown transport outcome
retains the exact request and is resolved through the authenticated mutation
receipt endpoint before another save. A read never publishes metadata.

Display name is at most 80 Unicode characters; biography at most 2000. Control
characters and malformed Unicode are refused. Media refs must be same-origin
public resource paths proven by an injected resource validator. The current
producer has no profile-media upload/read capability, so non-null avatar/cover
writes are unavailable, not arbitrary remote URL inputs or server fetches.

`GET /api/public/authors/:authorId/activity` reads the existing canonical
`publicSongViews` producer, preserves its server order, and filters by public
author ID. Its current validated public catalogue is bounded to 100 records;
this slice does not advertise complete historical activity, text/video
publication, private history or learning results. Pages contain at most 20
genuinely public posts. Opaque expiring D1 cursor records bind community,
author, catalogue snapshot, offset and page size. Unknown, expired,
cross-author/community, changed-snapshot and malformed cursors fail closed.
Expired cursor rows are pruned; equivalent page requests share a bounded
cursor per snapshot/offset/time bucket. No raw cached post index bypasses
canonical validation.

Frontend exports load the real private owner, public authors and activity.
`CommunityProfilePage` imports the existing independently owned `ProfileLayout`
and `ProfileActivity`; new accounts render the real empty profile. Loading,
unavailable, retry, populated, pagination and stale-response cleanup are real
controller states. `CommunityAccountSettings` retains the exact c7 AccountPage
card/action composition, source pending/logout failure and owner-only Settings
link. It offers Sign in, View profile, Wallet and logout through actual ports.
Private-history, public-results, recording and Telegram controls appear only
when the host supplies genuine supported services. There is no centralized
session/persona client, localStorage auth or automatic reconsent.

The current handler trace supports `/api/logout`, private learning-history
exports and V4 public-results withdrawal/on handlers, each with its existing
authority. There is no generic recording deletion handler or default Telegram
account-management mount in the admitted community entry. Those remain absent
unless the original owner supplies the real port. The reference's recording
retention copy is not asserted for an unimplemented deletion service.

Every owner load, mutation and setting operation captures the current session
identity. Account/session changes abort requests, clear captured private data,
receipts and drafts, and discard late results. An ambiguous read is unavailable,
not anonymous or another account's profile. MOSS sign-in and all existing
operator/learning/withdrawal behavior stay under the original authorities.

Protected integration is delivered as exact-base patches: HTTP dispatch using
current context and `publicSongViews`; default App profile/settings route
mounts; public-author projection; and private media account identity from the
owner producer. Existing entry/components/contracts are not edited in this
lane. New DDL is only `packages/community-profile/schema.sql`; coordinator
chooses migration order and applies it after qualification. Held Dance and
authority branches are not migration inputs.

Reference pin is Solid `c7cb87835a1858a1955c820b03d566365e6d42db`: actual
ProfileLayout/ProfileActivity, PersonaPublicProfile/PublicProfilePage,
OwnProfileSettings, AccountPage/RecordingsSettings and their stories. The new
packet records exact source objects, adapter differences and unrun assertions.
Runtime reference imports and source-only parity claims are excluded.

The additional player correction independently ports the exact centralized
`post-card-song-content.tsx` presentation at
`dca054847b3d48237780dcf834b7924c5fede0af`, using the installed c7 Solid
MediaControlButton/Scrubber. Real hidden audio supplies play/pause, duration,
progress and seek; native controls and fictional time/progress are excluded.
Existing access/renewal/cache/disposal/error behavior remains authoritative.

Acceptance requires unrun real SQL/HTTP/session/CSRF/privacy/CAS/cursor and
stale-account cases, component transition assertions and exact desktop/mobile
reference/candidate comparisons. Source actor runs only the pinned formatter
and `git diff --check`; all functional gates are coordinator-owned.

## Implemented adapters and limits

The owned exports are real HTTP/D1/client/controller/page implementations.
Protected mount proposals include complete proposed source files, not only DTO
names. Public post projection is allowlisted and community-bound; no future
private addition to an internal producer is spread into activity JSON. Cursor
snapshots bind canonical publication IDs/receipts and profile revision without
serializing a second copy of every lyric body. A known invalidated/expired
cursor remounts the reused ProfileActivity loader from its first page, clearing
stale rows rather than appending a replacement first page.

Owner state is synchronously masked when its community/session scope changes,
before effects complete, and outstanding requests are aborted. Authentication
loss during ambiguous metadata recovery hides private owner state but retains
the command ID; it never declares a lost write refused. The current account's
real session can still log out during profile/configuration failure. Original
private-history callbacks are passed through unchanged; no download-cancellation
workaround or baseline browser fix is included.

The metadata API accepts canonical non-empty bounded strings or null to clear;
there is deliberately no new profile editor. The inspected source exposes
Settings and existing account actions, not an editing workflow to duplicate.
Profile image inputs remain unavailable until an actual public image producer
is admitted. Recording deletion and Telegram remain unmounted by default;
public-results controls require the existing owning service renderer, with no
new consent/reconsent prompt. The empty/local profile does not create a persona,
handle or membership.

All SQL/HTTP/controller/component/player cases in this handoff are UNRUN.
Only source formatting and diff whitespace checks are authorized. Historical
frozen-60 checks, native-control captures and the interrupted broad root check
do not qualify this successor source.
