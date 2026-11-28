# Karaoke learner handoff

This branch adds the centralized Karaoke lyric display to the decentralized
client. It is the first of three slices recorded in the control-plane task
pirate-karaoke-learner-20261105. Its base is first-song
f0f081563a452b93553b74ce279f22a60ab9b39d. Every change is a new file. The
first-song coordinator keeps sign-in, routes, schemas, migrations, publication,
the alignment operation, timed song revisions, canonical song identity and the
live application. The MOSS-consent lane keeps account activation and consent.

Nothing here captures a microphone, calls a speech provider, buys a segment or
publishes a learning record. Starting a take in the standalone acceptance page
is simulated as an immediately active take.

## What this slice delivers

The screen plays the instrumental and highlights each word on the backing
track's clock. The active line fills word by word, completed words stay lit and
the next line waits below, as in the centralized app. Provider word timings
without punctuation are mapped back onto the canonical lyric text, so displayed
spacing and punctuation follow the published lyrics. Lines and words outside
the audio duration are clamped as before. Lines keep their published line IDs,
so a repeated chorus line stays distinct.

`packages/karaoke/manifest-lines.ts` is the only new logic. It converts the
protocol's `ManifestLine` and `ManifestWord` values in `packages/protocol/payments.ts`
into the adopted display model, in manifest ordinal order. The same timed
manifest therefore feeds the display and, in slice 2, the existing grader.

## Source and transformations

The upstream is pirate-web-solid 667a6f22325cc7dd07ed7bcdfc088864e519f71d,
under `src/features/`. These are independently owned copies; nothing imports
the centralized application at runtime. Each copy starts with a provenance
comment. Other changes are listed beside each file.

| Upstream file | SHA-256 | Copy | Change |
|---|---|---|---|
| karaoke/lyric-transform.ts | `46dd695e352310776c45c394a00f852fcb67acab9c3f2385d164dbd3c84a77f6` | packages/karaoke/lyric-transform.ts | none |
| karaoke/karaoke-timing.ts | `e3fee6c5b393e06f7b9bafc95366873c5396f276acdd6f8b0b25478b7c790a29` | packages/karaoke/karaoke-timing.ts | import path |
| karaoke/capture/karaoke-playback-clock.ts | `e0dd80ce353ec4e7f177851ce49d420505d984e08df484fc599b6e38d16d191c` | packages/karaoke/playback-clock.ts | constructor fields |
| karaoke/capture/karaoke-playback-graph.ts | `3bc2ea78c3300963ab250a49bc10f7d03ef1b9416cd5a3ba1cfc17235cfba27a` | apps/web/src/karaoke/playback-graph.ts | constructor fields |
| karaoke/karaoke-lyric-stage.tsx | `e09c4ee9490013b5249abe565431394f3293a216ee289c855137bb0c9cf836ae` | apps/web/src/karaoke/lyric-stage.tsx | import paths |
| karaoke/karaoke.css | `49c4c371a1535bb143a9a9c5c8d4d97fb330ead5cf5c38c32a359cd4a212dd53` | apps/web/src/karaoke/karaoke.css | none |
| karaoke/karaoke-practice-surface.tsx | `bedd46e049cc57fdc11d46f94ad2ada31b4f51a1130fa1415782330b44a08e1b` | apps/web/src/karaoke/practice-surface.tsx | import paths |
| karaoke/karaoke-playback-renewal.ts | `f0c6581cdfa99ca213cbe52855a7bd80c1720f9c7d002ad5df0b37cf2555cc0b` | apps/web/src/karaoke/playback-renewal.ts | none |
| karaoke/karaoke-results-model.ts | `8e1d5a75fb81aea70e9cce69ff2830934d5a2ff45eede96720e515f1b70e7209` | apps/web/src/karaoke/results-model.ts | import paths |
| activity/activity-progress-header.tsx | `2e129ac14d7292adf77f286a0858061e27d268bb8bc380205b3150ea667bf6d1` | apps/web/src/karaoke/activity-progress-header.tsx | import paths |
| activity/activity-results.tsx | `1940098e823feee9eaadad3703442a24b97a4c8ed9470715eea6d1e75b0e7317` | apps/web/src/karaoke/activity-results.tsx | import paths |

"Constructor fields" means TypeScript parameter properties were written out as
explicit fields assigned in the constructor, because Node's strip-only
TypeScript cannot run parameter properties. Behavior is unchanged.
Design-system imports resolve through `apps/web/src/karaoke/ui.ts` to the same
vendored component modules. The results model reads `KaraokeSessionSummary` and
`KaraokeTimingTrend` from `packages/scoring/scoring.ts`, which on this base is
identical to api-next a5c63b8 `karaoke-runtime/scoring.ts` apart from its two
phonetics import lines.

The upstream tests below run unchanged apart from imports. Their bun:test and
vitest calls go through `test/karaoke-expect.ts`, a small compatibility layer
that provides only the matchers and spies those tests use.

| Upstream test | SHA-256 | Copy |
|---|---|---|
| karaoke/lyric-transform.test.ts | `c663e11292492829c846074bcde06c0a900ca2b6e52e742a264ea959ab1418a9` | test/karaoke-lyric-transform.test.ts |
| karaoke/karaoke-timing.test.ts | `13a10c9085e569f5f14f42051128838660ce8050db8d3362e17c1cbd6e78c3f6` | test/karaoke-timing.test.ts |
| karaoke/capture/karaoke-playback-clock.test.ts | `53cce38dade4e3750b07a6e3f36262c2c93334b54c61e22c5ab35be01c92aa23` | test/karaoke-playback-clock.test.ts |
| karaoke/karaoke-lyric-layout.test.ts | `3c527f5bec5ef12dfa227b0639703fcf7c58b12e2adb6e328589080bd4b66f5b` | test/karaoke-lyric-layout.test.ts |
| karaoke/capture/karaoke-playback-graph.test.ts | `9d253ea0bada2a5f47d0b9d79b3afe7bb796a8aab56cd960049e130527da7e10` | apps/web/test/karaoke-playback-graph.test.ts |

All 42 upstream test cases in those files are present and pass. The upstream
results-model test is not yet adopted, because its subject imports a Solid
component that Node cannot load without a JSX transform. It moves to slice 2,
where finished-take results are exercised in the browser.

One inherited behavior is kept deliberately: when provider words omit
punctuation, punctuation after a line's last word is not shown. "Hello, world!"
displays as "Hello, world". This matches the centralized app and is left for a
separate decision rather than changed silently in a parity port.

## Local acceptance

`apps/web/karaoke-e2e/host.ts` is a loopback-only host that serves the built
screen, a three-line fixture manifest and a generated eight-second backing
track. It is never packaged or deployed. Run from apps/web:

    node_modules/.bin/vite build --config vite.karaoke.config.ts
    node_modules/.bin/playwright test --config playwright.karaoke.config.ts

The first scenario plays the actual track in Chromium and samples the audio
clock and every word state together, checking each word against its published
range, the order of completion and the punctuation mapping, until all three
lines have played and the results view appears. The second checks that a
320-pixel phone keeps a short line on one row without horizontal overflow.
`.github/workflows/karaoke.yml` runs the unit tests, the web typecheck, the
build and both browser scenarios in a hosted job with external networking
unavailable.

## Wiring for the coordinator

1. Adopt the new files onto the reviewed first-song successor. No migration,
   dependency or existing file changes.
2. Serve the published song's timed karaoke manifest from the existing public
   read path, after the alignment operation has produced word timings that
   preserve the published line IDs and lyric revision. Pass its `lines` through
   `karaokeStageLinesOf` and mount `KaraokePracticeSurface` from the live
   router with the song title and instrumental URL. The standalone entry in
   `apps/web/src/karaoke/entry.tsx` is an acceptance page, not a route.
3. Supply `playbackAccess` when the instrumental is a private stem read through
   a short-lived capability; the adopted renewal logic refreshes it without
   losing the take position.
4. Until slice 2 lands, do not show Start karaoke on a live page: the surface
   would play the track without capture or scoring.

## Next slices

Slice 2 adds microphone capture, capture lifecycle, the scoring session
orchestration and an operator realtime Scribe v2 transcription adapter in place
of the simulated `words` frames, with an explicitly simulated provider for local
acceptance. Slice 3 connects tickets, segment purchases, consented
LearningRecords publication, real song identity and alignment parity, including
the character-timing fallback, together with the coordinator and the
MOSS-consent lane.
