# Catalog coverage and next work

The viewport audit used an exact build of `9e20166902411c99c8c9e9b03b3534177082de37`. Its catalog index contains 332 stories, with 93 app stories and 239 vendored design-system stories.

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

The full viewport sweep recorded 634 rows, each exactly once. All stories rendered and all play functions passed. Raw axe reported 19 label-content-name findings on decorative avatar initials, including both Overflow Chat rows. The comparison with the 453-row reduced sweep found no changed outcomes in the overlapping rows.

The [avatar disposition ledger](../../scripts/storybook/avatar-dispositions.json) records the inspected stories, selectors, names, and text. The audit retains the raw axe findings and checks the live button against the ledger before accepting a match. These entries need review by December 2, 2026.

The full viewport sweep recorded 139 incomplete axe rule results across 451 node observations. A separate 104-row accessibility audit covered 13 stories across light and dark themes, LTR and RTL, and phone and desktop. It recorded zero violations and 28 incomplete rule results in VerticalFeed More Menu Open. Full-catalog theme and direction coverage is pending.

## Next expansion order

1. Production posting/video composer, with a short state-to-story map before implementation.
2. Community feed, songs, song detail and account areas.
3. Profile, author and settings routes.
4. Remaining wallet send/claim states and reward payment recovery paths.
5. Disposition the floating module inventory: mount, mark as harness-only, or retire each file with provenance.

The coverage map is still a planning document. It does not claim complete accessibility, localization, Paper parity, real provider/device effects or production acceptance.
