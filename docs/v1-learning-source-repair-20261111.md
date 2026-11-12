# Learning source repair, version 2

Exact base: `f962044e8b4bad8528a6e3b6f27135874a541f98`. This bounded repair
addresses the three findings in `owner-learning-surface-exact-review.final.txt`.
All tests, typechecks, builds and renders are **unrun**. The earlier 29 component
passes and type evidence remain evidence for f962 only. The coordinator owns
review, every gate, integration, acceptance and release.

## Request and upload outcomes

`LearningServiceError` now carries immutable request-stage evidence. An error
before dispatch means no endpoint call occurred. A structured refusal from the
actual ticket endpoint preserves its status/code as refusal evidence. A lost or
malformed body, transport failure, or session failure after dispatch is uncertain,
even when its status is 401 or 409. The ticket adapter requires the matching
endpoint, method and refusal evidence before permitting another explicit create.
An arbitrary error with a low HTTP status cannot release that hold.

A successful ticket POST followed by a failed account check stays held. Empty
or finished observations do not authorize a replacement create while that start
is unknown. An observed open take can recover the existing ticket. No provider
token, charge, reservation, sequence or dispatch identity is changed here.

Study treats `ready`, `assessing`, `uncertain` and an assessed response without
a grade as unresolved; only an authoritative `unavailable` result supplies
provider-refusal evidence. The server can read audio before claiming assessing,
so a `ready` observation cannot establish that an earlier upload stopped. An
unknown upload retains its original lesson, attempt and audio identity in the
adapter across reads. It never replays the recording or admits replacement
audio. Readback clears the marker only for a real outcome or terminal lesson;
an explicit successful restart must close the old lesson first.

A fresh adapter also blocks an existing `ready` attempt. This deliberately
prefers the source Recording paused recovery over guessing whether an earlier
body is still arriving. A ticket opened before a lost upload may need the
existing explicit Study again/leave flow or authoritative operator resolution.
No browser storage, new backend authority or invented result is introduced.

## Callback and private-action lifetimes

The adapter has an explicit disposal boundary, operation generations and an
optional current-owner guard. It checks after asynchronous reads, opens and
uploads, and before invoking `onLesson`. The route controller's later active
check is no longer the first lifetime fence.

`StudyScreen` keys its child by client, account, post and lesson, and freezes
the callbacks belonging to that child. Exit, auth hold and disposal invalidate
the adapter and cancel recording before external callbacks can run. The new
`onLessonCleared` event clears private history actions on load/restart, auth
hold and disposal. A late body cannot restore the old action after replacement.

`StudyPage` keys account/post/lesson lifetimes, fences requests and download
closures, and publishes `null` to clear its private-action sink on replacement
or disposal. `KaraokePage` likewise clears its retained history action when its
owned lifetime ends. The optional action callback now accepts an action or null.
The versioned interface is in the new local packet.

Current protected defaults still mount `LiveStudy`/`LiveKaraoke`. The packet
therefore supplies exact current-blob default-mount and legacy-clear proposals.
The coordinator must wire the clear event into the old seam until it replaces
that seam, and prove deep links, reload/back, account/post/lesson changes and
callback clearing on the actual mounted application. No protected mount was
edited here; this source repair does not claim integrated all-page acceptance.

## Restored source and new unrun regressions

The remainder of the pinned c7
`src/features/karaoke/karaoke-practice-playback.test.tsx` is restored: renewal,
same-element/clock continuation, refusal, tail flush, reconnect, context resume,
late recovery cancellation, take changes and terminal boundaries. Its original
assertion expressions are retained. Imports and the original controller double
are adapted to owned operator types; that double is explicitly identified.
The exact reference Git object was compared with the immutable export.

Additional tests exercise the actual owned hook, capture controller, operator
audio client, capture lifecycle, playback graph and surface together. Browser
context, microphone hardware and socket I/O are memory fixtures. They assert
one original take across reconnect, a fresh capture epoch, and rejection of
late recovery after finish/detach/disposal. These are prepared tests, not proof
of a device, provider or all-page result.

New regressions also cover post-commit 401/409, a delayed successful ticket
body followed by account change, malformed endpoint bodies, unscoped refusal
errors, an original Study upload still live during same-ready readback, a fresh
adapter's ready hold, delayed submit bodies after each ownership boundary, and
the actual page's null history-action callback. Existing relevant assertions
and historical evidence remain preserved. No harness, dependency or discovery
file was changed.

## Protected integration and remaining holds

The new packet contains proposals at exact f962 Git blob bases. The JSON API
account fence compares expected identity with the authenticated session before
private reads, proof exposure and work. Existing settings/enrollment/history
callers must be reconciled before applying it. Client account checks and headers
grant no authority and do not remove post-commit uncertainty.

Browser WebSocket authentication already uses `ticketId` plus the signed
`connect:<ticketId>` proof, verified against the ticket session key. Reconnect
must keep those identities and the existing sequence. No imaginary custom
WebSocket header is proposed. The audio element uses the existing same-origin
cookie-authenticated instrumental Range GET; it cannot attach a custom account
header. Strict account/take/revision-bound media access needs a reviewed grant
or compared query/ownership protocol. That capability remains denied here.

All backend services, packages, V1–V5 graders, private-publication policies,
budgets, sponsorship rules, manifests/locks, shell, other features and original
packets remain unchanged. Translation/configuration, reward/day/streak,
leaderboard and grant-source capabilities remain denied. Telegram fencing,
prospective activation and production remain held. The coordinator must run
the queued tests, typechecks, current mounted-page checks, rendered desktop/
mobile comparison, private-history and native microphone/provider qualification
before making any acceptance or release decision.
