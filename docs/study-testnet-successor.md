# Study testnet successor

This lane follows the merged Karaoke implementation at
3a5d4d18917bb4c5ebf96843132c4f4c1517c7a9 and imports the private Study component
from PR 27 at 3feafd444d16d3c3eb5c92fc4c7662774c48cd43. The import is a source
baseline, not live Study acceptance. Its original provenance and component
limitations remain in [the handoff](study-slice-handoff.md).

## Fixed product behavior

The selected set contains four to ten distinct-text lyric lines from one
published revision. Selection uses the authenticated learner's practice history
and is frozen before the first recording. The order is the selection policy's
saved order, which need not be lyric order; source ordinals and lesson ordinals
must therefore remain distinct. A later attempt cannot select new lines or
change the denominator.

The queue prioritizes unseen lines, then unresolved lines by least recent
presentation and original selected order. A correct answer or the third graded
presentation resolves a line. The lesson ends at all resolved lines or
min(20, 3 \* selectedLineCount) graded presentations. A known provider failure
permits an ungraded retry; an unknown dispatch pauses without automatic
redispatch. Neither consumes a graded presentation or becomes an incorrect
first-pass answer. Every actual provider start remains recorded by the shared
usage counter, including failed and unknown starts.

Publish first-pass correctness for each selected exercise. A later correct
repeat never replaces a first-pass miss. The centralized policy at api-next
a5c63b8db01d4359344d33c31d294a00fbeadb20 requires all selected first passes and
at least ceil(7 \* selectedLineCount / 10) correct. Completion, later mastery and
first-pass qualification are separate facts. No streak or reward is awarded
by importing the component.

## Protocol work required before release

The local contract format is now frozen in
[LearningResultsV3](contracts/learning-results-v3.md), with a new contract,
typed Study codec, terminal-lesson adapter and independent source/result reader.
These components are not connected to the deployed application yet. The
local lesson service closes abandoned and expired lessons durably. Application
publication and scheduled recovery are implemented locally; deployed acceptance
remains open.

LearningResultsV2 accepts only Karaoke and complete ordered lyric coverage.
Study requires a new contract and typed outcome encoding. The implementation
must bind the complete frozen ordered exercise set, not interpret the four to
ten selected lines as the first four to ten lines of the whole song. Binary
Study outcomes must remain distinct from Karaoke lyric/timing scores.

The frozen successor defines its ABI, domain version, activity mask, exercise
encoding, source-manifest authentication and prospective qualification policy.
Its local checks include an independent literal byte/hash vector and actual
contract publication/readback. A new verifying contract requires
new learner publication authority; the existing V2 enrollment cannot silently
be transferred or reused. Preserve its historical grants and result reads.

The contract and independent reader must reject omitted, duplicated, reordered
or changed exercises and unsupported statuses. Corrections preserve the
original source, selected set, learner, enrollment generation, completion time
and qualification period. The newest invalid or invalidated revision cannot
fall back to an older favorable one. Recovery must preserve one ordinary
publication per lesson across lost responses and unknown transaction receipts.

Incomplete, abandoned and expired lessons need an explicit terminal path and
absence statuses before automatic publication is enabled. Provider failure is
not a wrong answer and an unattempted exercise is not a numeric zero. An active
or unresolved lesson cannot be turned into a completed qualifying lesson by
the adapter. Public data excludes transcripts, recordings, private attempt IDs
and retry history.

The local runtime fixes a one-hour deadline when a lesson starts. A delayed
expiry sweep retains that deadline as the terminal time. Three takes per graded
presentation bound known-failure retries; uncertainty still prevents redispatch.
Study again explicitly abandons the previous active lesson before opening one.
Leaving the browser without that action is recovered through the fixed expiry.
Only a saved grade advances the queue. Atomic closure retains first passes,
marks submitted but ungraded work unmeasured and unreached work unattempted,
and prevents late provider responses or new claims from changing the result.
The application routes and scheduled recovery now call these paths. They have
not been deployed.

## Integration and budget boundary

Application migration 0009 now registers lessons, attempts and their frozen
publication bindings. It has been exercised with the preceding migrations in
local D1, but has not been applied to a deployment. The community routes use
the existing session, Origin and CSRF checks, return private no-store responses
and resolve songs through the authenticated public post/lyric reader.

Each lesson binds the full source hash, selected source ordinals and its
learner's exact V3 enrollment before recording. The grant must cover the lesson
and one minute of publication margin. Later attempts use the frozen source.
The managed operator verifies signed requests from the existing community ticket
issuer before reading audio. The signature binds chain, community, operator,
contract, path, short expiry, parameters and exact body bytes. A service binding
alone does not authorize its public HTTP endpoint.

The operator alone holds the provider credential. Speech uses the same
observation object as Karaoke and alignment. Before dispatch it saves a durable
attempt and a unique presentation/take slot. Replays return the saved outcome,
including after a lost response. The community can recover a matching saved
receipt without sending audio again; a changed digest or context cannot grade.
Unknown outcomes remain ungraded. Recovery must finish before the lesson
deadline and cannot reopen an abandoned or expired lesson. If recovery misses
that deadline, the submitted line remains unmeasured. Raw audio is not persisted;
the private operator receipt expires after thirty days.

The November 6 owner direction recorded in the stabilization task at
control-plane b45a696 supersedes the earlier shared-speech-quota gate in the
component handoff. The owner will monitor the provider bill and chose no
application speech quota for this MVP. The stabilization successor, merged
at a46bde8, is now adopted in this branch. Zero in the existing speech-limit
setting means observation without a quota. Retain current-day usage and
session/retry bounds, and make no provider-account billing changes.
The imported Study-only 100-attempt daily admission quota has been removed to
match that direction. This does not reset existing usage observations.

Study must use that same observation object, name and binding namespace as
Karaoke and alignment. Do not create an independent quota, reset counters or
add a budget-revision subsystem. Prepare a finite real-provider acceptance
journey and measure its actual cost. The separately approved native sponsorship
increase is manual and retains spent/reserved amounts and the gas-price ceiling.
This source checkpoint changes no deployed budget and spends nothing.

Keep Study's existing feedback and progression behavior. Compose the live
route with the shared sign-in and publication disclosure, and include its
private lessons in authenticated history/export and retention. Do not require
membership, a creator wallet or Palm for learning. The current imported
component still reports qualification as not_evaluated until the new policy
and authenticated publication/readback path are wired and tested.

## Contract binding and runtime successor

Each new enrollment and Karaoke session retains its exact chain, contract,
domain version and enrollment generation. Absent target fields in old journal
rows mean V2, even after V3 becomes the default. Frozen publication jobs,
corrections, queued enrollment and revocation keep their original destination.
Changed configured targets or queued calldata fail before another charge or
transaction. The V2 environment setting must remain available for recovery;
changing it is not a migration mechanism.

New V3 requests use a fresh signature and disclose the selected activity mask.
The live account menu reads both configured generations and revokes each active
grant with its own MOSS signature. It preserves partial progress after a
cancelled signature, skips revocations already confirming, and rereads both
contracts before reporting that publication enrollment has stopped. An RPC
failure or unresolved enrollment cannot be reported as successful revocation.

The prepared pirate-learning-testnet-v3 runtime profile requires both distinct
contract addresses and testnet chain 6343. The V2 profile refuses a silently
added V3 default. Both use the same existing operator object name, durable
journal, alarms, real clock, shared speech object and spending reservations.
Local tests also restart the SQLite runtime with an actual pre-broadcast local
V2 journal and verify unchanged signed bytes, charges and usage observations.
No infrastructure profile or deployed resource has been upgraded by this work.

The application migration, authenticated routes, managed speech bridge, terminal
publication queue and expiry schedule are implemented locally. The live feed now
offers Study only when the V3 service matches the directory configuration. A
Study link resumes after MOSS sign-in without creator-wallet or membership gates.
New lessons request V3 Study authority and renew a grant that cannot cover a
full lesson and publication grace. Loading an existing lesson keeps its frozen
grant. New Study work waits while renewal is pending, and reuse includes an
extra minute of request headroom beyond the contract's publication grace.
The binding still checks the actual saved lesson deadline. The client retains
its lesson URL, recovers a lost start response through
the saved latest lesson, and distinguishes private completion from pending or
confirmed public publication. Closing the screen preserves the active lesson
until it is resumed or reaches its saved deadline.

Leaving Study stops new enrollment, lesson and recording dispatch after pending
requests or wallet signing return. It cannot undo a request already sent. A
submitted enrollment or terminal publication keeps its original recovery path;
closing the screen is not revocation. The browser regression reproduces the
earlier late-signature dispatch and checks both sides of that boundary.

The built live app's browser tests use an explicitly simulated HTTP peer and
wallet signing transport. They cover disclosure cancellation before lesson
creation, ordinary sign-in, no duplicate enrollment/start on reload or a lost
response, and completion/publication status. Actual Study D1, operator,
cryptographic and contract behavior remains qualified by the separate service
tests. Neither set establishes real MOSS/provider acceptance or deployed UI.

Study still needs complete private retention/export, authenticated correction
controls and the reviewed exact deployment profile. The final V3 publicity policy
and disclosure pages must be prepared and
bound to the deployed contract before accepting successor consent. The activity
text in the enrollment dialog alone does not complete that disclosure gate.

## Durable publication and recovery

The community sends a signed terminal snapshot from its owned D1 lesson and
original source/grant binding. A browser cannot supply the result, source or
outcomes through the private lesson routes. The operator validates terminal
semantics and exact source/selection, freezes the applicable completion-period
policy and persists only the compact public bundle and calldata before sending.
Transcripts, recordings and private attempt identifiers never enter calldata.

The D1 publication row is an outbox. Lost responses leave it retryable; retries
use the same operator intent, contract, nonce, signed bytes and conservative
sponsorship charge. An unsent result whose enrollment expired or was revoked
stays private and releases unused reservations. An allocated unknown transaction
retains its original authority and bytes; a new enrollment cannot replace it.

The publisher reads commitments at a pinned canonical head and reports twelve
confirmations only after checking the transaction's canonical receipt. A lost
canonical result reuses its original signed transaction. Unresolved publications
are reconciled by operator alarms; confirmed ones are audited hourly. Wall-clock
completion ahead of chain time waits without allocating or charging a new
transaction. The general transaction recovery path honors that wait too.

Scheduled community recovery scans at most twenty due lessons per invocation,
closes abandoned-browser lessons at their original deadline and resumes the
outbox. Unbound drafts expire privately without obtaining a grant. One binding
or RPC failure does not suppress other due work. Private publication status is
available only through the owning account's no-store route.

The contract and independent reader already cover authenticated corrections and
invalidation. The managed Study correction control path remains a release gate;
this ordinary publication path accepts one immutable terminal snapshot per lesson.

## Deployment order and acceptance

First deploy and verify the application and readers capable of the current
and successor configuration histories. Confirm existing songs and V2 Karaoke
results remain readable. Only then activate the new directory revision and
verify both activities again. Preserve exact source, asset, profile and
configuration evidence, including a tested recovery path.

Qualify deterministic failure, retry, exhaustion, correction and recovery with
simulated providers and real local storage, cryptography and handlers. Then
run a bounded real-provider testnet lesson on a published song with an ordinary
MOSS learner, including first-pass misses and retries, reload, one terminal
publication and independent policy-aware readback. Measure the complete cost,
including consent and recovery. Local fixtures are not deployed acceptance.

Dance and fresh-operator wizard installation remain follow-ups. Funded rewards
and mainnet account/USDm qualification remain separate tasks. Nothing in this
source adoption enables them.
