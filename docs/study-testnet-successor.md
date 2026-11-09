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

Study has no learner time limit (workspace_owner ruling, 2026-11-08). A new
lesson stores no deadline and stays open while the consent it was bound to is
live. It closes privately at the earlier of that consent's last millisecond and
thirty days after it started, or at once when the operator reports the consent
revoked, replaced or ended. A lesson closed at consent end stays private; one
closed at thirty days while its consent is still live (possible only for a
consent longer than the thirty days the application requests) can publish as
abandoned. A draft never bound to consent closes thirty days
after it started. A lesson started before the ruling keeps its one-hour
deadline, and a delayed expiry sweep retains that deadline as its terminal
time. Three takes per graded
presentation bound known-failure retries; uncertainty still prevents redispatch.
Study again explicitly abandons the previous active lesson before opening one.
Leaving the browser without that action is recovered at the close bound above.
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
New lessons request V3 Study authority and renew a grant with less than an
hour and the publication grace left; a lesson started on such a grant can last
only as long as the grant. Loading an existing lesson keeps its frozen
grant. New Study work waits while renewal is pending, and reuse includes an
extra minute of request headroom beyond the contract's publication grace.
The binding checks a legacy lesson's saved deadline, and for a new lesson that
the grant is live at binding time. The client retains
its lesson URL, recovers a lost start response through
the saved latest lesson, and distinguishes private completion from pending or
confirmed public publication. Closing the screen preserves the active lesson
until it is resumed or reaches its close bound.

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

Private Study export and bounded deletion are implemented locally as described
below. Authenticated correction controls and the reviewed exact deployment
profile remain open. Versioned V3 disclosures are prepared as described below;
their independent qualification and exact deployed binding must pass before
accepting successor consent. The activity text in the enrollment dialog alone
does not complete that disclosure gate.

## Durable publication and recovery

The community validates the complete private terminal queue and freezes the
first-pass facts permitted by the public-result format before operator I/O.
The signed request
contains those facts and the original public source, without private retry,
mastery, attempt or recognized-text history. A browser cannot supply the result,
source or outcomes through the private lesson routes. The operator trusts the
existing authenticated community issuer's queue attestation and independently
validates terminal time/status, completed coverage, source, ordered selection and
the original enrollment binding. It freezes the completion-period policy and
persists only the compact public bundle and calldata before sending.
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
closes abandoned-browser lessons at their close bound (a legacy deadline, or a
new lesson's consent end or thirty-day limit) and resumes the outbox. A new
lesson closed at its consent end is published only if that consent is still
live, which in practice means it stays private. Unbound drafts close privately
without obtaining a grant. One binding
or RPC failure does not suppress other due work. Private publication status is
available only through the owning account's no-store route.

The contract and independent reader already cover authenticated corrections and
invalidation. The managed Study correction control path remains a release gate;
this ordinary publication path accepts one immutable terminal snapshot per lesson.

## Deployment order and acceptance

The no-deadline Study change requires the 992158-byte operator to be live
before, or together with, the application; the older operator refuses every
no-deadline lesson binding. See docs/study-operator-release.md.

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

## Private Study export

The authenticated history action downloads the most recently opened Study
lesson from the account menu. The endpoint requires the account cookie, Origin
and CSRF, filters all rows by account and community, and reads lesson, attempts
and the stored publication receipt in one D1 transaction. It calls no speech
provider or operator and remains usable when new practice is disabled.

The export contains the full private attempt set, including recognized text,
without the recent-list limit of fifty. A lesson's presentation and take bounds
permit at most sixty attempts; an oversized history is rejected without silently
truncating it. The export window ends thirty days after the saved completion, the legacy
lesson deadline, or an open new lesson's close bound once that has passed. With the
thirty-day consent the application requests, an open new lesson can therefore be
retained for up to sixty days after its consent was signed, against about thirty days and an hour under the former limit; the
V3 disclosure promises no shorter period. Raw audio, managed keys and cookies are not included. This is
an operator-held JSON copy, not an encrypted learner vault or an official grade
import. The account menu retains one opened lesson; a full history index is not
claimed by this slice.

An expired export is refused immediately. Migration 0010 adds a private-history
deletion marker and compact terminal outbox. Scheduled bounded deletion erases
the expired attempt rows and replaces the private queue with an empty object,
even when new practice is disabled. It first consumes grades durably saved
before a lesson's close bound and closes unattended lessons there without
another speech request. Unknown dispatch remains unmeasured rather than becoming wrong.
One failed row is reported after other selected rows can progress. Due rows
with the fewest previous cleanup attempts go first, so even a full batch of bad
rows cannot repeatedly hide later due work. Retry bookkeeping changes neither
the queue revision nor the deletion marker. Retention, posting wakeups and public
Study recovery each run independently; their original errors are reported
together after all stages. A posting outage cannot suppress retention, and a
retention error cannot suppress public recovery. Deletion
runs at the next successful scheduled sweep; a failed validation remains visible
and requires repair rather than silently discarding public recovery evidence.

Minimal account/community, lesson/request and public song tombstones prevent an
old request from creating a fresh lesson or grant. The menu no longer resumes an
erased lesson. Subsequent private practice selection uses retained attempts.
Recovery retains the original source, ordered first-pass facts, grant, receipts,
unknown transaction intents, raw signed bytes and conservative sponsorship
accounting for pending, unknown or published work. The operator's
separate speech receipts already expire thirty days after dispatch, retaining
spent-slot and binding evidence to prevent new dispatch. Public on-chain
results remain public. No Study deployment is qualified by local retention work;
independent review and final factual privacy disclosure remain release gates.

Unpublished first-pass grades and selections remain private. After their window
expires, the operator can erase terminal content only with a pinned canonical
zero commitment and no queued intent, transaction row or charged reservation
for any revision. A private or failed label alone is insufficient. It first
establishes a permanent minimal closed-lesson marker, then removes grades,
calldata, grade-derived request hashes, source selection and speech receipts.
The marker refuses subsequent binding or dispatch, and unused reservations are
released without altering spending or unknown-operation evidence.

The publisher explicitly attests never-submitted terminal privacy before the
community can erase its expired copy. D1 then removes the terminal facts,
binding, source, private song link and start time while retaining account,
community, lesson and request tombstones. Operator alarms and scheduled D1
cleanup work without a browser. Unavailable chain proof keeps recovery content
intact for retry. A provider completion after receipt expiry cannot recreate
private evidence or a deleted attempt. Source qualification, final disclosures,
real MOSS/provider acceptance and deployment remain separate gates.

An expired draft with no local outbox also loses its local song and start-time
association in the atomic purge. A late binding response cannot insert an
outbox after that privacy tombstone, and a replay cannot repeat the binding.
This does not prove a remote binding is absent. Uncertain remote authority and
financial evidence remain untouched for reconciliation.

## Versioned successor disclosure

The immutable V3 candidate is services/learning-policy-v3.ts. Its terms and
privacy pages are served at /learning/v3/terms and /learning/v3/privacy. The
publicity commitment is keccak256 of the exact UTF-8 terms, two newline bytes,
and exact privacy text, without normalization or a trailing newline:
0x2ca79bc25c9e5527ca456535c46af0b9c10a9cf31d4c504013a9ce0a3a606b96.
The original V2 /terms and /privacy response bytes and their deployed commitment
0xed087bbce3b42c61236f9c26795f3b1b43e626ded9ac4a75bb97f43138791143
remain unchanged. A future document revision needs a new versioned publication;
do not edit an accepted document in place.

The text discloses both activities, permanent wallet-linked terminal records,
Study selection and immutable first-pass outcomes, corrections and invalidation,
and rewards only under explicit, separately disclosed offers. Both speech adapters enable provider
logging; no fixed provider retention period or zero-retention promise is made.
The thirty-day export and scheduled cleanup bounds are distinct from permanent
public results, replay tombstones and uncertain native or remote recovery data.
Never-submitted private-content erasure still requires the recorded proof.

Fresh V3 enrollment requests and acceptance require the known document hash on
the destination contract before account activation, native intent or allocation.
New practice checks before the active-grant shortcut, and operator binding and
new Study speech enforce the same boundary. Replayed saved speech receipts,
historical result recovery and revocation remain separate. Both activity dialogs
link the versioned disclosure matching their signed policy; inconsistent metadata
fails before a wallet prompt. V2 uses its original links and authority.

This source does not deploy a contract, activate configuration or request live
consent. Exact profile binding, independent review and a real testnet journey
remain required. Existing native and provider recovery evidence is preserved.

## Canonical correction projection

The local operator now reads later canonical Study revisions separately from
the immutable first-publication job. The original commitment, calldata, intent,
nonce, signed bytes, transaction hash and conservative spending remain unchanged.
The receipt exposes the original commitment and transaction plus separate latest
revision/status/commitment/transaction metadata at a pinned canonical head.
This projection does not sign or submit a correction, acquire new enrollment,
reopen a private queue or call speech. Manual authenticated correction controls
and their exact future execution profile remain open.

The first publication is anchored by its actual successful canonical receipt.
Later indexed-session events must preserve its context, selected set and ordered
revision ancestry. An invalidation preserves prior outcomes and a later controller
restoration is a distinct revision. Canonical block and successful receipt checks
precede acceptance. A missing, malformed or unavailable changed result cannot
fall back to the older favorable result. Unverified history stays pending or
requires operator review; it never becomes qualification evidence.

Each invocation searches at most eight indexed windows of ten thousand blocks.
The durable reverse cursor retains its exact target, canonical head, unsearched
range and collected public evidence for the next invocation. Eighty thousand
blocks is a per-invocation budget, not a total history limit. At most 128 public
events are retained in a pending search; excess history is refused explicitly,
never silently truncated or treated as a favorable result. Successful proof and
search progress are saved in the same receipt compare-and-swap transaction.
An atomic observation generation changes on every successful save, including
identical pending receipts in the same whole-second clock tick. A delayed earlier
observation cannot overwrite newer proof, cursor or receipt state. Older rows
start at generation zero without changing their native evidence.

An orphaned anchor is reset only after canonical evidence changes. A verified
reorg can legitimately lower the latest revision; a merely behind RPC head is
not proof for a favorable downgrade. Loss of the original publication retains
its existing raw transaction and charge for idempotent recovery. No new nonce
or replacement publication is created by this projection.

The account-owned publication POST requires the existing Origin and CSRF checks
and forces a fresh audit. GET reads remain private and cached public receipts
older than one hour are marked pending until audited. Scheduled audits of
published results remain hourly; incomplete or unverified revision recovery is
retried independently. Display metadata does not authorize financial eligibility.
The live Study view distinguishes corrections, confirming invalidations and
confirmed invalidations from its saved private practice feedback. Official
qualification must use independent canonical public readback.

Local contract/D1 tests cover correction after revocation, invalidation,
controller restoration, verified reorg downgrade, stale reads and two separate
held-response races at operator and D1 boundaries. They retain the original
transaction, native intent, spending ledger and provider counts. Separate
bounded-reader cases cover durable continuation beyond one work budget, missing
links, changed context, wrong ancestry and noncanonical evidence. Browser tests
use explicit HTTP/wallet simulations; none is deployed or acoustic acceptance.

## Manual controller correction command

The source-only `harness/megaeth/study-correction.ts` command takes `--profile`
and defaults to a read-only plan. It does not read a signing key, construct a
mutable journal, allocate a nonce, sign, send, fund or call speech. An explicit
finite inventory and custody record are required even for planning. A missing,
changed, unreadable, unsupported or unresolved journal refuses the plan. This is
not global signer discovery. Known inventory cannot prove other disks, processes
or services are quiescent.

A `pirate.study-correction/1` profile pins MegaETH testnet 6343, directory and
contract runtime hashes, registry/community/configuration revision, current
controller, V3 disclosure hash, the exact canonical previous event, operation,
nonce, gas, gas-price ceiling, data-fee reserve and aggregate maximum. Its window
is at most fifteen minutes and admits one operation. Correction preserves the
full selected set and immutable context; invalidation needs a nonzero reason.
The command verifies the successful previous receipt and event, canonical block,
registered target and current commitment. It refuses stale previous metadata.

The inventory lists exact absolute file paths, SHA-256 digests and one of three
explicit formats: deployment-journal-v1, deploy-results-v2-custom or
activation-journal. Each signed transaction must recover this controller on
6343, have its declared nonce/hash and a sufficiently confirmed canonical
receipt. A reverted receipt consumes a nonce too. A private settled/mined label
is insufficient, and the custom deployment file needs no invented receipt field.
Queued unsigned work, reserved sponsorship and unreviewed SQLite sidecars refuse
execution. Only public nonce/hash summaries are returned; keys and raw journal
bytes are never printed or exported.

The private `pirate.controller-custody/1` record is bound by its SHA-256 digest.
Its scopeHash is `custodyScope(profile)`, excluding the record path/digest to
avoid a circular hash. It names workspace_coordinator, the quiescent writers,
explicit exclusions and inventoryCompleteForWindow. That declaration must come
from actual coordination and a fresh bounded inventory. It cannot be inferred
from equal latest/pending nonces. Old controller operation windows and budgets
stay closed. The existing Karaoke runtime resource hold remains in effect.

Future execution additionally requires `--execute --expect-profile <hash>` and
`--key-file <existing-private-key-file>`. This source work supplies no live
profile or custody transfer. The command holds a fixed signer-wide OS lease
under private local state, then a separate per-profile crash-durable journal.
Older runners do not participate in that lease; they must remain stopped under
the reviewed custody record. Existing key files require regular owner-only files
without symlink traversal, the correct chain and controller, and no public
fixture key. All public, inventory, window, nonce, balance and gas checks run
before key access, with another audit immediately before broadcast.

The journal retains the fixed nonce, conservative charge and exact signed bytes.
Unknown/reverted work is not refunded. A lost response cannot allocate a new
nonce, bump fees or sign replacement bytes. An already pending known transaction
is observed without rebroadcast; unlanded recovery can reuse only the original
bytes within the same window. `--status` remains read-only after the deadline
and can report canonical confirmation without opening a key. No administrator
HTTP route or contract method is added. Default CI uses explicit fake RPC peers
and private temporary journals; this command has not run against a public chain.

The fixed lease database also records this command's participating profiles before
journal creation. A durable prepared marker commits after the fixed unsigned
intent/charge and strictly before any key read or signing. Another profile
refuses any missing, empty, unsigned or unconfirmed prior journal. Same-profile
recovery may create a missing journal only at the registered stage, when this
source guarantees no key could have been opened. A prepared-stage missing or
empty journal is refused even for the same profile. Existing prepared state
recovers its original fixed intent and signed bytes. There is no force flag or
automatic deletion of unknown evidence. The registry has a finite explicit
128-profile limit and cannot retroactively fence legacy tools. Planning audits
this registry through read-only SQLite without creating it.

Activation-journal inventory also recognizes this command's own correction row.
Every allocated legacy intent must have a matching signed transaction row;
canonical settled rows cannot hide another unresolved allocation. Status receipts
and pending transaction responses must identify the exact stored transaction
hash, with pending nonce, destination, calldata, gas, fee and value preserved.
The initial ten-test candidate was not accepted: separate adversarial review
found four missing refusals. Its frozen source, passing full gate and red cases
are preserved separately from the repaired successor.

Planning and execution also cross-check the command's fixed private namespace
against its participating registry. An unindexed profile journal, surviving lock,
missing catalog row, lost catalog or unreviewed SQLite sidecar refuses execution;
a new empty registry cannot silently discard prior allocations. This bounded
namespace integrity check does not turn legacy-file discovery into authority.
The first eleven-path registry candidate passed its original tests but was not
accepted after the reviewer demonstrated three catalog-loss failures. Its source
and red evidence are retained separately from the namespace-integrity repair.
