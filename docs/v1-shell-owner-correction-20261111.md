# Owner correction: established application compositions

This correction starts at `af714492e1065970652d24f0644b32829d38b8ea` in the
original admitted shell worktree. It supersedes the November 10 authored
shell presentation, not its integrated backend, MOSS, wallet or learning
services. Historical `.local` evidence is retained unchanged.

The selected Solid reference is the exact Git object
`c7cb87835a1858a1955c820b03d566365e6d42db` in `pirate-web-solid`. Source is read
with `git show`, never from the canonical checkout's older working files.
The centralized React/Storybook reference is
`dca054847b3d48237780dcf834b7924c5fede0af`; the design-system reference is
`10f3760f82507690c0894355733682df801648e9`. Neither is a runtime dependency.

The actual component hierarchy now uses `AppSidebar`, `AppHeader` only on
mobile routes selected by the copied `resolveApplicationChrome` policy,
`MobileFooterNav`, `CommunityPageShell`, `CommunityPostCard`, `SongPlayer`,
`YourSongsPage`, `NavigationDrawer`, `ProfileLayout` and `ProfileActivity`.
These are independently owned source
copies or existing pinned design-system components. The community cover,
identity/Post action row, FlatTabBar/FlatTabButton, feed dividers, compact
player and about rail come from the reference page composition. There is no
replacement hero, tagline, status-success banner or hand-drawn chrome.

Desktop has no application header bar. `AppSidebar.signInAction` remains at
the sidebar bottom. The community cover owns its controls. Song detail owns
its mobile header and hides the footer; Study/Karaoke use the reference bare
route policy. The route adapter maps the existing fragment/query routes into
the reference policy without adding Worker routes. `/operator` retains its
standalone behavior. Existing MOSS challenge/verification and permission
settlement, wallet/Very/operator mounts and learning transports remain in the
current entry rather than being overwritten with an older entry.

Necessary dependency-port substitutions are explicit. The copied player
receives the published same-origin audio URL instead of importing centralized
session/API code. A public audio URL has no fabricated grant expiry; the
original request/error/retry/playback/cleanup behavior and compact markup are
retained. Post cards accept permitted action and playback ports. Unavailable
votes, comments, timestamps and Boost operations are omitted rather than
supplied as zero counts or inert controls. API order is retained because the
current feed does not project ranking scores or publication time.

The manifest's 32-byte author commitment is retained as `technicalAuthorId`
for lookup/recovery. It is never copied into a handle/name or used as an
avatar initial. Only an unambiguous, community-bound `postAuthors` public
projection can supply a display identity. Without that producer the exact
source `Unknown author` presentation is used. The current live API supplies
no such public profile projection; its absence is an integration gap.

The community name is the actual API value passed into the reference
identity component. No description, handle, member/follower count, membership,
profile, artist or social activity is invented. The About rail only renders
provided metadata. Publisher permission exposes the existing Post action; it
does not assert membership or public video posting rights. Public video policy
remains pending. A single draw-summary port is at page level and remains absent
without an authoritative payment-lane projection. Song-library streak grouping
requires a complete account/community-bound factual projection. Unknown streaks
are not zero streaks. Profile fields and activity require a corresponding
projection and are never inferred from MOSS balance or reward eligibility.

`ProfileActivity` retains the source mounted-loading, abort/generation guard,
cursor advancement, deduplication, retry, Load more and disposal behavior.
Its mandatory `loadPage` port replaces the embedded centralized client and
session resolver. Engagement arrives as an authorized action port; no zero
counts are supplied. Without the bound profile projection, `/account` uses
the source account fallback. Private Dance remains account-keyed even when
profile metadata is unavailable. Settings is a separate route; its Sign out
label no longer claims a sign-out transition during unrelated busy work.

The phone drawer now uses the source `NavigationDrawer` rather than repeating
the desktop sidebar. Unavailable Notifications is an explicit omitted port.
Desktop selection retains the source policy, including no selected tab for
song detail and the Settings policy. The sidebar's community Home override
is the reference ApplicationChrome rule. Multi-persona switching, central
notification feeds and cross-community discovery have no current service;
they are not drawn as inert controls.

The reference playback endpoint adapter is justified by the exact base
`services/community-public.ts` projection: published audio is
`/api/public/posts/<post-id>/audio`. The shell does not import centralized
playback/session services or persist grants. `cacheAccess={false}` keeps
public playback bound to the actual card's injected read port.
Because that permanent URL can remain unchanged after a media error, a retry
explicitly reloads the existing audio element. The source metadata-ready
handler then resumes from its saved position. This replaces the rotating grant
URL assumption without substituting a different player or error flow.

The new [page inventory](./v1-shell-page-inventory-20261111.md) maps every
reachable learner page to actual components, stories, machines and adapters.
Each row also names the actual decentralized producer and mounted interaction,
or explicitly records that no producer/mount is bound. Profile/activity and
profile settings remain data and interaction gaps for coordinator/original
onboarding ownership. The original learning owner must reconcile the Study
and Karaoke surfaces. An undefined renderer or a copied layout is not parity.
The correction packet records exact copied/reference blobs, SHA-256 hashes
and explicit protected proposals. All 18 directly imported existing UI
modules match their exact c7 source bytes; this is provenance evidence only.

The first source preview is a partial correction, not a parity acceptance.
Wallet/Receive/Send, learning, media, Dance and song publishing implementations
outside this lane remain owned by their original actors. Their actual
component/story/state-machine and adapter inventory, protected proposals and
exact queued rendering inputs are recorded in the new correction packet.
No dependency is installed and no test, typecheck, build, server or browser is
run by this actor. Coordinator-rendered desktop/mobile comparison, focused
checks, independent review and the existing exact release process remain gates.

The sealed media interface `pirate.media-composer-interface/1.1` is consumed as
an integration proposal, not a runtime checkout import. Coordinator can bind
`CommunityPostComposer` from `../media/community-post-composer.tsx` into the
existing authenticated composer renderer once its actual account/media/text/song
ports exist. The current session view does not expose the media account ID;
neither `authorId` nor a wallet address may be relabeled as that account. Video
ports remain absent while public rights are unresolved. Until integration, the
protected existing SongUpload stays mounted for authorized publishers.

Song detail uses a fragment as a route identifier, not an in-page anchor. Its
old matching `song-<id>` element and `scrollIntoView` caused native fragment
scrolling underneath the fixed phone header. The element ID is removed and
detail navigation starts at the page top, matching the reference's distinct
public-post route frame. The pinned public-post composition places the activity
row after the card and available activity slots. Supplemental published lyrics
now follow that row. Two supported activities use two columns; the source's
third Dance action has no admitted route adapter here and is not fabricated.

Immutable Preview 1 remains unchanged. The coordinator reported its locked
installs and live build passed, with two typecheck diagnostics in app-shell:
`aria-busy` needed explicit string booleans and the ref callback needed
`HTMLButtonElement`. Both are repaired in ongoing source/Preview 2. The source
actor did not rerun those checks. Preview 2 is also immutable; the final source
manifest records any later owned changes. Neither preview is parity acceptance.
