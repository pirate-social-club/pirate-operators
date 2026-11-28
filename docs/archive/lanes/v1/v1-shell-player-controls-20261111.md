# Established song playback presentation

Base is `83209be8033599c0aad059c24815e0fa75d433dc`. The frozen 60 review
observed working playback but native audio controls. That observation closes
neither centralized control parity nor this new source's acceptance.

Presentation comes from exact centralized
`src/components/compositions/posts/post-card/post-card-song-content.tsx` at
`dca054847b3d48237780dcf834b7924c5fede0af`: `deriveSongUI`, the play/pause/
buffering control, artwork/title grid, Scrubber and time labels. The original
`post-card.styles.ts` metadata class is retained. `SongContentFrame` and
`SongPlaybackControls` are independent Solid adaptations using the existing
c7 MediaControlButton, Scrubber, icons and Spinner. There is no React runtime,
central playback/auth client or new package.

`SongPlayer` retains the existing readAccess, grant validation, expiry/renewal,
per-post public cache, targeted cache opt-out, unchanged-URL retry and cleanup.
The hidden HTMLAudioElement owns playback truth. `playing`, `pause`, `waiting`,
metadata, duration, timeupdate, seek and error events update the controls;
calling play never fabricates a playing state. Unknown duration is `--:--` and
seeking is unavailable until finite real metadata exists. The disabled scrubber
range sentinel is the original presentation fallback, never a displayed time.

The keyed mount captures post ID/access-port identity. A→B routing disposes A,
pauses and clears its element, removes listeners/timers and creates B with no A
grant/progress. A late access response may populate only A's captured public
cache. Disposed callbacks and obsolete audio events cannot change or pause B.
Private/targeted mounts retain `cacheAccess={false}`. A same-URL retry reloads
the existing element, including a still-valid cached grant after media failure.

The protected caller patch replaces the older c7 compact artwork/title row
with `SongContentFrame`; title navigation and actual artwork/artist ports remain
explicit. Apply that patch together with the owned player and the protected
Tailwind source-scanning patch. Unknown artwork uses the original note glyph;
no artist, preview duration, entitlement, age proof or commerce state is made up.
Those source branches have no supplied decentralized capability in this slice.

Meaningful unrun cases cover real play/pause, keyboard seeking, missing/infinite
metadata, media refusal, failed/same-source retry, expired/renewed grants,
unmount cleanup and delayed A→B hash/history navigation. The packet records the
exact reference/source blobs and frozen review/image digests. Actual matched
desktop/mobile captures and all functional gates remain coordinator-owned.
