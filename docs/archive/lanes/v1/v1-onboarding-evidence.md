# Lane 6 source evidence

Base: 67cbe118ade39790bc1539999ca75d0d7ff10b6d. Evidence is local and
fixture-backed. No deployment, provider mutation, managed credential change,
public-chain transaction or production activation was performed.

The final focused regression batch passed 31 tests across sign-in,
live authorization, community setup, sponsorship and actual SQLite journal
persistence. After adding fresh-community bindings, its setup suite passed six
tests. The existing six local-chain authorization tests passed, including a new
unallowlisted ERC-8010 account; an additional local-chain probe verified V4
community/origin/controller and both grader permissions. Three selected
Study/Karaoke revocation tests passed, covering new-work refusal, speech refusal
before the provider call and prevention of unpublished work becoming public.
Foundry passed all 219 tests. Standalone acceptance passed on retry at the
named `local-skeleton/1` subset. The first acceptance run failed on a localhost
RPC request; no provider acceptance is inferred from either run.

Root typecheck and wizard typecheck/build passed. The built wizard was inspected
with the existing local browser, fixture secret storage and held provisioning.
Typing retained values; the credential field cleared after save; saved status
was masked; the review package remained held. Changing an unsaved scope disabled
credential/plan actions. The 375px layout had no horizontal overflow and the
final browser run reported no page errors. A transient snapshot timeout and the
initial reactive-input bug were observed and corrected; these are not phone or
real Infisical evidence. The preview and browser were stopped afterward.

`npm run check` was attempted under a bounded invocation. It did not complete
successfully: the process ended with exit 143 before the Node suite summary.
Observed failing tests involved deployment recovery and Karaoke provider
failure/reconnect fixtures. Their root causes were not established by this lane.
The broad check is not green. The wizard `npm run check` ran 30 tests: 25 passed
and five failed in subprocess/runner environment tests. Restricted filesystem
and temporary-path assumptions prevented those checks; a prior invocation also
hit the UNIX-socket path length in tsx. Final wizard typecheck/build and the
focused setup/server tests were run separately and passed. The coordinator must
resolve or reproduce the broad checks on the exact integrated source before
publication. Separate Study/Karaoke browser release workflows were not run here.

The versioned proposal and runbook describe the remaining integration and live
acceptance. Actual community ownership, managed key readback, Alchemy resources,
per-channel speech binding enforcement, real unallowlisted MOSS first use,
second-community real songs, browser playback and linked Telegram devices remain
release work. The fresh V4 runtime-profile patch is proposal-only, checked
locally without applying it to shared source. No migration ordinal is required.

All code is independently owned decentralized implementation based on the stated
source. No centralized runtime or UI source was copied. Existing class parameter
properties in the wizard error classes were rewritten as explicit properties so
new focused server tests also run with the root Node TypeScript strip runner;
their behavior is unchanged. Dependencies were reused or installed exactly from
the existing lockfiles; no package manifest or lockfile was changed.
