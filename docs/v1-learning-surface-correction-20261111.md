# Learning surface correction, version 1

Base: `af714492e1065970652d24f0644b32829d38b8ea`. Reference: independently
owned source copied from pirate-web-solid
`c7cb87835a1858a1955c820b03d566365e6d42db`. The immutable reference export was
compared with that exact Git object before copying. The older reference working
HEAD is not the selected source. See the source hashes in
`.local/owner-learning-surface-correction-20261111/reference-source.json`.

This change implements the learning frontend. The coordinator owns mounting,
dependencies, rendered comparison, all execution gates and release. It does not
establish visual parity or acceptance. No tests, typecheck, build, Storybook,
browser, Worker, chain or provider commands were run for this correction.

## Page and controller inventory

| Reachable state                                           | Composition and selected source                                                                                                  | Owned adapter                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Study authentication, loading, retry and unavailable      | `studying-route-states.tsx`; `StudyingRouteView`                                                                                 | `StudyPage`, account-scoped community song/lesson requests                                                  |
| Spoken card, acquiring microphone, listening and checking | `studying-surface.tsx`; `studying-route-view.tsx`; `studying-browser-recorder.ts`                                                | `StudyScreen` delegates to the copied route; `createOperatorStudyingClient` maps authoritative lesson facts |
| Spoken miss and Continue                                  | Source token diff, heard transcript and spent-card choreography                                                                  | Server next card and presentation count; a miss never advances a local queue                                |
| Re-record, refusal and provider uncertainty               | Source recording policy and blocked-card presentation                                                                            | A declined recording remains ungraded; uncertain dispatch reads the same attempt and blocks new recording   |
| Expired/abandoned lesson                                  | Source expired-session frame and explicit new-lesson action                                                                      | Existing lesson close semantics; no invented deadline for current lessons                                   |
| Study results and optional streak step                    | Source `StudyCompletionFlow` results-first choreography, `ActivityResults`, `StudyingSurface`                                    | Real first-pass count and total; exact-lesson completion capability is unavailable by default               |
| Karaoke authentication, loading, empty and failure        | Source `karaoke-route-states.tsx`; loaded route composition                                                                      | `KaraokePage`; `createOperatorKaraokePort`                                                                  |
| Karaoke primed, connecting, singing and reconnecting      | `KaraokePracticeSurface`, `KaraokeLyricStage`, shared `ActivityProgressHeader`; c7 scoring-hook construction and recovery guards | Existing protected capture controller, microphone/worklet, operator audio client and playback graph         |
| Karaoke playback refusal and interruption                 | Source backing-track retry, gesture recovery and playback notifications                                                          | Actual audio element/context; resume remains bound to the unchanged ticket and controller                   |
| Karaoke finish, lost acknowledgement and recovered result | Source result surface, `ActivityResults`, actual summary and combo                                                               | Same-ticket readback; no new take is issued by finish/reconciliation                                        |
| Private history                                           | Existing settings callback                                                                                                       | Account/lifetime-bound download from owned Study or Karaoke history API                                     |

The selected Study and Karaoke source uses controller/model choreography rather
than an XState machine. No replacement reducer or invented XState machine was
introduced. The existing protected Karaoke controller is the independently owned
decentralized protocol adaptation of the source orchestrator. Its state, capture
epochs, serialization and transport remain in use, rather than installing the
centralized session bridge alongside it. The new frontend construction seam
follows the selected c7 hook. XState 5.33.2 remains coordinator-owned where other
source features require it; this learning graph does not import it.

The shared pure Study/Karaoke surfaces, model, result components, route states,
lyric rendering and tokens already present at the base remain intact. Their
source composition now receives the copied Study route controller and real
operator adapters. `screen.tsx` is a small compatibility entry, so the existing
Study mount reaches the source controller immediately. `KaraokePage` and the
full `StudyPage` mount are proposed to the shell; protected live entries were
not edited. The existing acceptance-only standalone Karaoke entry is unchanged.

## Necessary service departures

The decentralized service uses MOSS account sign-in, frozen lesson IDs,
operator tickets/proofs, finite admission and publication receipts. It has no
central session/persona API. The new request adapter uses only same-origin
community APIs, CSRF and the existing MOSS session. A fresh account read before
and after a request prevents a stale response from entering another account's
presentation. This client fence is not claimed as server authorization. Study
also retains its server-enforced `x-study-account` fence. A matching server
account fence for Karaoke is a precise protected-source proposal, not an edit.

The operator provides spoken Study cards. The reference's translation-choice
surface, stories and transitions are preserved, but the real adapter refuses
translation submissions. Language/level selection, centralized profile setup,
age-verification APIs, cross-tab localStorage start coordination, central private
completion/progress and leaderboards are not silently simulated. They require
reviewed decentralized service ports before becoming reachable. No central API,
auth, persona or localStorage runtime dependency is introduced.

Study start retries keep the same request ID after unknown delivery; a late
response cannot call the closed mount's lesson callback. Submission opens the
server's exact lesson/presentation/take and sends its attempt ID. Lost upload
acknowledgements read that lesson and attempt. A failed read holds recording;
there is no automatic audio replay or new admission. Explicit fresh lesson
actions retain the owned abandon/start protocol. Only a definite refusal or a
confirmed response permits a new start identity.

Karaoke reconciles a current ticket before issuance. A lost ticket response
reuses an observed open ticket. An early empty read after unknown creation does
not permit a second create. Explicit refusal retains its status/code, while
unknown delivery stays held. Reconnects retain the operator ticket, sequence,
capture clock and existing server dispatch/admission identity. The frontend
does not mint provider tokens, release reservations or change charges. Finish
polling and Check status refuse a different ticket returned by another tab.
The original server-clock resume and bounded sign-in wait remain in place.

Internal sponsored practice bypasses per-line purchases exactly as before.
Externally paid practice retains the original signed purchase window and stops
repeating refused purchases. No new budget, reward or qualification is inferred.
V1–V5 grading, historical results, receipt transactions, private publication
authority and all provider/backend code are protected and unchanged.

The source completion slot is retained. Study publication is checked through
the existing bounded same-lesson readback. Karaoke displays the actual record's
publication state; that display does not claim chain confirmation. A missing
Karaoke presentation summary produces the source no-score result. Study's
optional earned-day flow requires exact account/community/post/lesson evidence,
matching pinned timezone/progress and a second account read. Its default
capability denial leaves the real result and direct Continue intact. The
coordinator must not map `qualification: not_evaluated`, a publication receipt,
or a reward offer into earned-day success.

## Stories, transition cases and comparison evidence

Original c7 `studying-surface.stories.tsx`, `studying-route-view.stories.tsx`,
their story clients/recorders and `karaoke-practice-surface.stories.tsx` are
copied with local imports. The exact lyric stage and artwork fixture are also
copied without central API fixtures. Added decentralized route doubles exercise
desktop/mobile ready, sign-in hold, loading, empty, error, unknown creation and
recovered open-take states. These doubles are explicit story seams and never
form the default runtime path. Story-only playback supplies no real media URL.

The source recording recovery suite retains acquisition, permission denial,
minimum duration, refusal, unknown outcome, reload, explicit restart and late
capture-disposal cases. The source playback cases retain readiness, waiting,
stalled download, gesture recovery, refused playback and disposal behavior.
Additional pure adapter cases cover lost start/finish acknowledgement, unknown
hold, account switch, same-attempt result recovery and refused budgets. The
completion tests cover unavailable capability, exact qualified evidence,
account change and target mismatch. All are **unrun**, prepared for the
coordinator's serial gates.

The provided c7 Storybook receipt establishes a successful reference build,
not a candidate render. Supplied reference captures concern shell, feed,
wallet/profile, post, private Dance and Send; they do not establish learner
page parity. Source story definitions and original transitions were inspected
here. No candidate desktop/mobile screenshots or rendered comparison are
claimed. Coordinator comparison must include actual Study/Karaoke pages at
1440×1000 and 390×844, every listed recovery state, tokens, spacing, controls,
copy, and data-bound results. Copied counts/hashes are custody evidence only.

## Integration and remaining gates

Use `component-interface.json`, `mount-proposal.patch`,
`protected-integration-proposal.json` and `queued-checks.json` in the new local
packet. Shell owns `study`, `lesson`, `sing`, popstate, sign-in and URL updates.
Pages key private lifetimes by account and post and never mutate history.
Clear retained download callbacks when the route or account changes. Pass
the shell-owned lesson query to `lessonId` and handle `onLessonOpened` in the
router. Keep `/operator` unchanged. Do not replace the shell or shared entries.

Storybook/Vitest dependencies and test discovery belong to the coordinator.
The packet names exact source versions and a single-worker rendered-test config;
none were installed here. Run typecheck, the queued focused pure/rendered
tests, original story transitions and matching rendered comparisons under
coordinator custody. Existing broader release checks and real-device/provider
acceptance remain necessary. Production, prospective policy activation,
Telegram persisted-publication-fence integration and deployment remain held.
