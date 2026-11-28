# Withdrawn-account login repair 2

This delta starts at preserved `9773f67448f98cb0662cf1c05adadeda4ed99e7e`.
The successor review found that login awaited the shared `endForWithdrawal`
callback before local cleanup. That callback can recover an assessing speech
attempt through `/study/speech/status`. An unresolved recovery prevented both
login and canonical local closure, including subsequent login retries.

`services/learning-public-results.ts` now performs canonical local lesson and
attempt closure and freezes terminal publication facts directly. The local
service has no source resolver or speech recovery transport. Login with a
durable withdrawal completes with ordinary SIWE and stores no publication
authorization. The newly observed chain-withdrawal, settings-off and chain
refusal paths use the same local cleanup. Explicit turn-on still finishes
interrupted cleanup before clearing the withdrawal flag; nonce acknowledgments
and newer-choice fences are retained.

The old callback positions remain accepted temporarily for existing callers,
but are intentionally never invoked or awaited. The sixth login argument is
still the bounded chain-observation wait. This compatibility choice fixes the
current shared login route without writing coordinator-owned source. It also
means that a caller must not depend on these callbacks for remote side effects.
There is no floating promise, request-lifetime timer or new background task.

Existing D1 `study_publications` rows provide the durable reconciliation
journal. Local cleanup freezes validated `terminal_json` and preserves the
`bound` or `pending` state, original source and authorization binding, receipt
and transaction/provider evidence. An assessing attempt becomes `uncertain`,
retaining its audio digest and duration; a late assessment cannot reopen or
grade the closed lesson. No uncertain, allocated, signed or broadcast charge
is released by this repair. Drafts without a binding have no operator work to
reconcile. Existing scheduled `recoverStudyLessons` selects terminal
bound/pending rows and owns later operator reconciliation; this repair does
not claim that its Worker execution has been verified.

Cleanup retries now include closed bound/pending lessons whose terminal facts
were not frozen. Previously, an interruption after the lesson/attempt batch
could leave a closed row outside the next active-only scan. Retries preserve
already-frozen terminal facts. Account/community ownership and private-history
tombstones remain enforced by the canonical stores.

## Focused evidence and limits

`test/learning-public-results-memory.test.ts` uses actual community login,
verification, Study lesson/attempt, managed status client, terminal freeze,
settings and authorization functions over real in-memory SQLite migrations.
Provider transport and signature verification are explicit local mocks. No
Worker, port, chain, provider, key creation or funded operation runs.

The controlled regression starts the actual shared Study withdrawal callback
on a bound assessing attempt and leaves its speech-status response unresolved.
Two actual login challenges and their session verification complete while it
is unresolved. Both bound and pending publication rows retain uncertain
evidence. Releasing a valid assessment afterwards cannot reopen or grade the
closed lesson. Tests also cover every completed cleanup SQL response
interruption, the terminal-freeze retry before turn-on, all three withdrawal
entry paths without invoking a never-resolving legacy callback, newer turn-on
winning a stale chain observation, and old V4 challenge verification after
withdrawal with and without a later explicit turn-on.

The same unresolved-provider tests loaded against the exact preserved service
fail at their local-completion deadline. The local module loader substitutes
only that service in memory; it never rewrites preserved source. The failed
control and initial fixture-development failures are retained separately and
are not acceptance passes. Exact commands, results and hashes are in the
repair2 handback and manifest.

This adapter models atomic SQL batches and lost responses after SQL completion.
It does not prove workerd/D1 transport behavior, process restart, scheduled
alarm recovery, private provider erasure or real-wallet acceptance. Existing
activation retirement and sponsor-budget memory tests remain required focused
regressions. No guard is weakened. A scoped runner's inability to write `/tmp`,
or an activation guard refusing an inside-repository temporary location, is
an environment/guard observation rather than evidence of a product regression.

## Shared integration and interface reconciliation

The new unapplied
`.local/onboarding-repair2/coordinator-callback-defer.patch` removes obsolete
remote callbacks from the coordinator's login and settings-off routes. It also
updates the older unowned login test's callback-count expectation to deferred
reconciliation while retaining withdrawal and nonce/race checks. Those shared
files are unchanged here. The learning owner can remove obsolete callback
arguments from its own callers during final typed integration.

The retained `.local/integration.patch` still requires coordinator/source5
mounts: data-fee enforcement when V4 is configured without V2, and actual
operator Study alarm recovery when V4 alone is configured. Their sender/tick
regressions and integrated scheduled recovery remain held. The new integration
proposal references those exact retained bytes without changing them.

`.local/onboarding-repair2/interface-proposal-v2.json` replaces the earlier
external-pin interpretation. The old sealed consumer proposal recorded shared
packet hash `b3e7a8be…`; the successor review and this turn observe
`b807039a…`, whose Dance qualification reference is
`dance-admission-contract-v5.json`. The observed packet bytes are copied beside
the new proposal with their full hash. This is a timestamped snapshot
observation, **not immutable admission authority**. The earlier sealed artifact
remains unchanged. The coordinator must choose and review the exact final
typed source, ABI, reader and qualification/config interfaces before admission;
the mutable packet hash alone cannot authorize a mount or runtime activation.

Lane5 still owns speech admission and grader revisions; lane6 owns capped
activation/authorization and linked-account setup interfaces. Native Telegram
bot plus optional widget, website MOSS Claim/Send, trusted link authority and
no retroactive trial attribution remain the boundary. Community bot tokens
stay in community Infisical; platform login credentials are distinct. Alchemy
owns provisioning. Shared mounts and actual fresh-account/second-community
acceptance remain unproven and held.

No UI changes occur in repair2. The earlier centralized pure Solid/Storybook
comparison and copied-source provenance remain at
`.local/onboarding-repair1/centralized-source-comparison.json`; source revision
`c7cb8783` and its necessary decentralized-backend departures are historical
evidence, not a new browser comparison. Decentralized backend/MOSS, managed
credential entry and the owner-controlled public-video policy remain intact.
No centralized authentication, API or persona runtime is introduced.

Media holds the heavy slot. Workerd, fixed-port Anvil, browser, build, Forge,
full checks, live providers and actual new-community acceptance are pending
coordinator scheduling. Earlier interrupted broad checks remain interrupted,
not failures or passes. After sealing the exact successor manifest and handback,
this writer returns to quiescence for coordinator preservation and review.
