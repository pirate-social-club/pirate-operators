# Catalog coverage and next work

Current reference: `9e722d72cf8132ca6713eeecd7adae980cddeb3e`. The rebuilt catalog index contains 93 app stories, 237 vendored design-system stories and 62 docs entries. The app-side tier split is 34 screen stories, 49 flow stories and 10 part stories; 46 app stories carry play-function evidence. This supersedes the older 82-story baseline that previously appeared here.

## Coverage snapshot

| Area | Current catalog position | Important remaining gap |
| --- | --- | --- |
| Study | Route and surface stories cover loading, failure, auth, recording, grading, completion, missed attempts, expiry and the happy-path lesson flow. | Real microphone, account and lesson-service acceptance remain outside the catalog. |
| Karaoke | Route and practice stories cover ready, loading, empty, error, auth, start uncertainty, recovery, scoring and interrupted playback. | Real recording, playback, WebSocket and recovery acceptance remain outside the catalog. |
| Wallet | Learner wallet stories cover ready, loading, failure, zero balance and receive. Reward-operator stories cover ready, loading, load failure and guarded payment review. | Sponsored sending, claim effects, MOSS/account lifecycle and real signing remain uncovered. |
| Shell | Shell and membership stories cover session/resolution and optional naming slices. | The shell content is still fixture-like; full community composition and navigation coverage are thin. |
| Dance | Source, recovery and async-resize stories cover a broad repair matrix. | Real service/private-state acceptance and exact design review remain open. |
| Playback controls | Paused, playing, buffering and unavailable-seek states are covered. | Real media delivery, timing, seeking and persistence remain open. |
| Posting / video composer | No proper production story coverage yet. | Highest-priority gap: map restoration, song choice, playback checking, capture, preparation, recording, interruption, finalization, review, submission, retention and refresh states to stories. |
| Community pages | No proper production story coverage yet. | Feed, songs, song detail and account areas remain uncovered. |
| Profile / settings | No proper production story coverage yet. | Mounted profile, author and settings routes remain uncovered. |

## Verification state

The exact-head focused browser audit for ErrorState Blocked, ActionMenu Open, Karaoke Loading, Reward operator Ready and Reward operator Payment review recorded all 10 viewport loads with zero failures, zero axe violations and zero incomplete checks. This is focused repair evidence, not the full current-head matrix.

Static checks on this head pass: web typecheck, story-conformance tests, story tier conformance, token conformance, production-import reachability and the Storybook production build.

## Next expansion order

1. Production posting/video composer, with a short state-to-story map before implementation.
2. Community feed, songs, song detail and account areas.
3. Profile, author and settings routes.
4. Remaining wallet send/claim states and reward payment recovery paths.
5. Disposition the floating module inventory: mount, mark as harness-only, or retire each file with provenance.

The coverage map is still a planning document. It does not claim complete accessibility, localization, Paper parity, real provider/device effects or production acceptance.
