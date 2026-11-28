# Application-owned song lifetime

This continuation is source-only at `79a6946f`. The default entry proposal is
pinned separately to immutable coordinator `6ad6b817`; no shared source was
edited. Earlier source clearance and 179 Node passes do not validate this delta.

Call `createCommunityComposerScope` once during App construction, under its
actual Solid owner. Pass its route-independent `current` accessor the actual
config/community/name/origin/language, session/author/CSRF, capabilities/feed,
and the genuine `profileIntegration.ownerAccountId()` result. The coordinator
mount already supplies this producer; the proposal keeps it and removes only
the route condition. It never substitutes a caller, wallet or public author ID.
The local random generation rotates on genuine authority/unknown boundaries,
not home/songs/profile navigation. Factories are never invoked by tracked prop
getters. The scope and each authority runtime own explicit Solid roots and
cleanup; route components borrow them.

`CommunityComposerHost` accepts the scope and the original open/close props.
Its cleanup releases a view lease, pauses the native upload controller and
preserves any pending command/original Files. Accepted observation belongs to
another controller in the same application authority and continues through
composer close, history exit and community page navigation. If a PUT or seal
ignores abort, its late reply remains under the original native lock; only a
read reconciliation may attach its actual accepted job after the operation
finishes. Reopening reads/reconciles the same draft; it never automatically
reserves, uploads, seals, resumes or chooses a new UUID. Existing isolated Host
props remain compatible for the prior browser fixture, but production must
pass the persistent application scope.

Each accepted job gets `bindCommunitySongJob`, which wraps the actual native
storage/controller with immutable account/community/author/request/body/
submission/post/job bindings. Every observer load/save checks that binding
before HTTP. Its source therefore cannot follow the upload controller into a
different release after known closure. Observation cannot remove storage.
Polling and explicit native resume serialize through this same bound source;
queued operations recheck authority and abort before dispatch. The original
observer is paused/resumed around the explicit native resume, preserving its
existing transitions while an ignored read abort finishes under its lock.
The reviewed upload protocol, File hashes, pending commands, native CAS and
unknown outcomes are unchanged.

The original `createSongSubmissionStore`, XState observation machine,
composer controller/steps, `PostedSong` and `PendingSongs` remain the runtime
source. `CommunityPendingSongs` supplies its actual scoped items, check/retry,
dismiss and Status callbacks. Count is the actual item array length. Dismiss
only stops in-memory watching; it never erases a durable unknown. Source retry
guards remain unchanged. A native uncertain job is reconciling, so its actual
Check and resume action stays in the existing status surface; the adapter does
not fabricate a retryable failure. Accepted handover is not publication:
matching canonical job, feed and proof still gate published UI and deduplicated
feed refresh.

Authority captures private account, community/origin, author, MOSS identity,
generation and CSRF. Accessors mask old items and refuse commands immediately
when the genuine context differs or becomes unknown. Application boundary
handlers invalidate synchronously before sign-in/logout/session replacement.
401/403 response headers revoke before body parsing, including a delayed or
unreadable body. Revocation pauses uploads, aborts the captured owner, disposes
the original observer and masks its UI; late canonical replies may still save
under the old scoped lock, but cannot notify a successor or dispatch another
command. The new authority begins without adopting a draft. Explicit reopening
under the genuine same account may read the original durable identity. No
CSRF, cookie, secret or private playback URL is persisted in a draft.

Missing native IndexedDB File storage or Web Locks yields the concrete existing
unavailable message and no service dispatch. There is no unsafe memory fallback.
As with the original memory observer store, a full application reload ends that
observer; explicit composer reopening restores the durable native release.

The pinned CommunityPages proposal composes pending cards into existing
`feedLead` alongside the unchanged draw/public-feed slots, and passes the real
count to `feedLeadCount` so pending cards suppress a misleading empty feed.
Post identity, profile, learning, wallet and operator mounts remain untouched.
The current shared styles already scan owned media and pinned UI source. No new
screen, reducer, visual language or stylesheet is introduced.

Allowing route disposal during an upload also exposes two local source-view
awaits: the footer's preparation and SongStep's ID3 read. Those protected
components remain unchanged in this lane. A separately pinned minimal proposal
adds disposal/selection fences around their local signal writes and navigation,
preserving transitions, markup and assertions. Coordinator review/application
of that proposal and the actual source-preparation disposal case are required
before mounted disposal acceptance. Host callbacks already check the view lease
before accepting a late controlled draft edit.

All prior c7 source copies, assertions, story doubles, manifests and handbacks
are protected. The extraction derives from the reviewed 79a Host; original
controllers/machines/components and native protocol sources remain unchanged.
New Node binding cases and a real-browser entry are prepared but unrun. The
browser cases use actual native storage, scope, Host, original cards and machine
with explicitly simulated HTTP. They cover route-independent polling/publication,
Status/reopen, native resume, original retry refusal, check/dismiss retention,
upload exit/late acknowledgement and authority/body/header races. They do not
establish actual handler/provider or device acceptance. The existing native
Worker/storage entries and their assertions remain intact.
An additional integration-only proposal case imports the real immutable W1
profile integration/client/controller, exercises `/api/profile/owner` private
UUID selection and original Status routing, and proves a 403 need not decode a
body to drop authority. It belongs to the coordinator's combined source because
that profile producer is not part of this lane's pinned W3 tree.

Coordinator applies the pinned shared/harness proposals and owns every test,
type, component, browser, build, render and release gate. Public video remains
denied; missing text/splits/image/video timing/processor/unfinished closure
producers remain separate holds. Private Dance, codecs, policies, terminal
selection, providers, credentials, resources and financial actions are unchanged.
