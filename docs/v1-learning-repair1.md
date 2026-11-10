# Learning exact-source repair 1

This successor repairs the four findings against preserved source
`44a3a00181ec11188a079e8c9ae1b6887f39461a` and the V4-only alarm admission
finding. Lane 5 retains its confined scope. The original handback, interface
proposals, routing patch and evidence remain sealed.

V5 now refuses phonetic acceptance if alignment leaves any meaningful missing
token. Article filtering and genuine span alignment still apply. Equivalent
`wanna`/`want to`, dropped-g spellings and existing accepted pronunciation
variants remain available. V1 through V4 branches and stored historical grades
remain unchanged. This is a correction to unreleased V5 source, not a live
policy change or a historical regrade.

The operator's Karaoke relay uses `admittedKaraokeAdapter`. Each actual provider
start allocates a monotonic ordinal in `karaokeSpeechSequence:<ticketId>` inside
the existing store transaction before admission I/O. The reservation identity
is `karaoke:<ticketId>:stream:<ordinal>`. Learner socket generation is only
correlation metadata. Provider reconnects and a restored relay allocate distinct
identities without resetting the counter or replaying an old dispatch. Every
replacement still passes the same finite community/key/channel budget.

An explicit token-mint refusal has structured evidence schema
`pirate.karaoke-token-refusal/1`, phase `token-mint`, an HTTP status and
`providerStreamOpened: false`. Only confirmed rejection statuses create that
typed refusal before upgrade. A provider response body, token and key never
enter its evidence. The operator retains the structured dispatch outcome under
`karaokeSpeechDispatch:<reservationId>` before resolving the admission charge.
Confirmed refusal releases capacity. Ambiguous token failures, lost upgrade
responses and paid streams that later drop keep their conservative charge.
Lost resolution acknowledgements can be reconciled from retained evidence;
timeout alone never establishes a refund.

Study dispatch and read-only provider recovery share `completeStudySpeech`.
It compares the current request and receipt and writes inside one transaction.
The first assessed or unavailable receipt remains terminal. A late timeout,
error, conflicting success or provider refusal returns that terminal winner and
resolves speech admission from the same receipt. Recovery never dispatches
speech, changes a lesson's grader or restores withdrawn publication authority.
The extracted dispatch module runs after the existing authenticated binding,
authorization, immutable audio and speech-slot checks.

`karaoke.ts` admits Study alarm recovery when either V3 or V4 is configured.
A fresh V4-only profile therefore scans and retries retained Study work. V2-only
and unconfigured historical profiles still omit that scan; V3 keeps its scan.
The operator transaction data-fee change remains coordinator-owned.

Focused regressions use one test worker, the production relay, streaming
adapter, admission SQL, signed Study status handler, dispatch/completion path
and alarm tick. Provider transport and RPC failures are explicit simulations;
SQLite transactions and cryptography run locally. The receipt race test holds
the original dispatch, commits status recovery, then releases four late outcomes
against each of two terminal receipts. The alarm test maps the runtime's pure
service-call reexports to their original module so Node can test the actual tick
without loading Cloudflare-only platform classes. No Worker build, browser,
local chain, Forge run or live provider is needed for these regressions.

The shell continues to own `?study`, `?lesson`, `?sing` and popstate according to
`apps/web/src/shell/interfaces.ts` and `docs/v1-shell-interface-v1.md` in its
worktree. This repair adds no routing mount or UI change. Source-only proposal
updates are in `.local/interface-proposal-learning-repair1.json`.

Activation remains held for an exact independently reviewed release. At fresh
release preflight, the coordinator chooses an unstarted V4 period and its UTC
boundary from epoch `1793552400` and day length `86400`. Current or historical
periods are excluded. Shared mounts, migration numbering, policy-aware readers,
onboarding authorization and the original real-provider/device acceptance gates
remain coordinator/integration work. The repair packet does not turn the
original incomplete broad checks into green evidence.
