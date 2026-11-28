# Reader-scoped player access correction

Base: `6e85419aa2e2f92fbe172315fce039de3f94328f`. This repairs the third P2
finding in the immutable `parent-profile-player-b94bcd1-audit/review.json`.
The frozen audited player is byte-identical to the starting player at this base.

SongPlayer already captures post/access-reader identity in a keyed instance.
Its old process cache and listeners nevertheless used only postId. A late grant
from reader A could enter reader B's mount for the same post, including a reader
that refused access. The actual exported default now uses a WeakMap keyed by
the captured readAccess function. Each reader owns its bounded 32-post cache and
listeners. Read, subscribe and publish all use that same captured reader/post
pair. Contexts are weakly owned, not held in a permanent reader registry.

The readAccess function is the immutable access-context port. The host must
replace it when account/access authority changes; mutating authority behind a
retained function cannot communicate a new identity. No new player prop or
shared caller change is required for the audited distinct-reader defect.
Targeted/private callers retain cacheAccess=false. Late A access may populate
only A's captured cache, enabling a genuine same-reader remount; B cannot read
or subscribe to it. Existing post identity, real grant expiry, unchanged-URL
retry, source validation, seek, renewal and disposed event guards remain intact.
No obsolete element can pause its successor through the player's onPlay path.

Presentation is unchanged: independently owned Solid adaptation of centralized
`src/components/compositions/posts/post-card/post-card-song-content.tsx` at
`dca054847b3d48237780dcf834b7924c5fede0af`, using exact c7cb8783
MediaControlButton/Scrubber primitives. The c7 SongPlayer origin and original
control provenance remain in source and `v1-shell-player-controls-20261111.md`.
The hidden real HTMLAudioElement owns progress, duration and playback state;
no native controls, duration estimate or optimistic played state are added.
The cache helper is a local access-boundary repair, not a copied presentation
primitive or an auth/provider substitute.

New unrun cases cover same-post live reader replacement and unmount/remount,
late A after B resolves, already cached A, B refusal and retry, positive
same-reader late reuse, per-post expiry, and old-element event cleanup.
ShellPlayerReaderInput uses actual SongPlayer with distinct function objects;
component cases use explicit media method doubles without claiming native
playback. Browser assertion exports require real decodable same-origin WAVs and
verify B playback survives obsolete A events. Prior A-to-B post navigation,
expiry/renewal, same-source retry, metadata and seek cases stay queued too.

No browser/server/build/type/component/Node execution ran. Source inspection
against frozen b94 is not rendered parity. Coordinator must run fresh tests,
review all actual reader lifetimes/callers, reconcile the historical protected
card/style proposals at the current base, and obtain desktop/mobile native
playback comparisons before acceptance. The base's external passes and prior
visual evidence remain historical, not qualification for this changed source.
