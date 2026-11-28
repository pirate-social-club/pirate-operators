# Learning UI reference comparison v1

The direct owner direction in `owner-ui-direction-20261110.json` applies to
this lane. The accepted centralized reference is pirate-web-solid revision
`c7cb87835a1858a1955c820b03d566365e6d42db`. Its canonical checkout currently
holds the older `667a6f22325cc7dd07ed7bcdfc088864e519f71d`, so this comparison
reads the exact accepted Git revision rather than assuming the working tree is
the current reference. Existing per-file adoption comments remain intact.

Source comparison confirms that all seven owned presentation components match
that reference after excluding import paths, type-only reexport paths, comments
and whitespace: Study surface, Study model, Study route states, Karaoke practice
surface, Karaoke lyric stage, activity progress header and activity results.
The independently owned copies retain the same pure Solid controls, callbacks,
progress, layouts and copy; they do not import centralized session, API or
persona code. File hashes and the token comparison are recorded in the private
`.local/learning-ui-reference/comparison.json` evidence.

The compared Storybook definitions are
`src/features/studying/studying-surface.stories.tsx`,
`src/features/karaoke/karaoke-practice-surface.stories.tsx` and
`src/features/activity/activity-progress-header.stories.tsx` at that revision.
Study's Idle, Listening, Checking and spent-miss stories retain Record, Stop,
in-flight disabling and a single Continue action. Its completion stories keep
Continue primary and Study again secondary. Karaoke's PausedPrimed, Connecting,
ScoringFeedback, Ended and interruption stories retain Start karaoke, live
feedback, Sing again/Continue and the existing tap-to-continue recovery. This
is inspection of source and Storybook definitions; no newly rendered Storybook,
browser or real-device acceptance is claimed.

The route seam `src/features/studying/studying-route-view.tsx` handles
`ungraded_rerecord` by retaining the same card, returning to idle, showing no
correct/incorrect sound and asking the learner to record again. The owned
Study adapter now uses its exact existing message: “That recording could not
be graded. Record it again.” It uses the already adopted surface's error slot
and Record action. There is no additional page, confirmation or control.

Backend-driven departures remain explicit. A confirmed speech refusal preserves
the current prompt and learning progress; the one-minute retry cooldown uses
specific busy/wait text because the community owns finite speech capacity.
An uncertain provider dispatch pauses recording until readback/reconciliation
because sending again could duplicate provider work. The established recording
and retry surface presents these actual states. No speculative recovery button
or payment step is added. Interrupted Karaoke reuses the same server take and
existing playback controls; shell query/history ownership stays with lane 1.

The centralized application route imports its own session, persona preparation
and API clients. Those imports were inspected as boundaries to exclude. The
owned route instead calls this community's authenticated services and preserves
MOSS sign-in and wallet access. Public result publication, revocation fences,
community/channel speech budgets and prospective grader policy remain server
facts. This UI comparison authorizes no new backend, public-chain action or
production activation.

Dance remains lane 4's source ownership. This lane introduces no Dance screen
or workflow. The same exact-source/Storybook comparison requirement remains a
coordinator acceptance gate for that lane. The sealed repair1 handback remains
unchanged; this UI reference evidence is delivered as a separate addendum.
