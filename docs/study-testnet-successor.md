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
first-pass answer. Every actual provider start still consumes the global
speech allowance, including failed and unknown starts.

Publish first-pass correctness for each selected exercise. A later correct
repeat never replaces a first-pass miss. The centralized policy at api-next
a5c63b8db01d4359344d33c31d294a00fbeadb20 requires all selected first passes and
at least ceil(7 \* selectedLineCount / 10) correct. Completion, later mastery and
first-pass qualification are separate facts. No streak or reward is awarded
by importing the component.

## Protocol work required before release

LearningResultsV2 accepts only Karaoke and complete ordered lyric coverage.
Study requires a new contract and typed outcome encoding. The implementation
must bind the complete frozen ordered exercise set, not interpret the four to
ten selected lines as the first four to ten lines of the whole song. Binary
Study outcomes must remain distinct from Karaoke lyric/timing scores.

Freeze the successor ABI, domain version, activity mask, exercise encoding,
source-manifest authentication, prospective qualification policy and independent
test vectors before connecting publication. A new verifying contract requires
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

## Integration and budget boundary

The imported SQL is component schema, not an already applied application
migration. Register the next actual migration, compose private no-store routes
using the existing account/Origin/CSRF checks, and derive references from the
verified published lyric manifest. Do not mount the acceptance fixture as the
live authentication or speech handler. Keep provider secrets within Pirate's
managed service and its established secret/runtime workflow.

Use the existing shared SpeechBudget object, including the same object name
and binding namespace used by Karaoke and alignment. A second Worker or Study
counter would multiply the allowance. The current configured ten starts per
UTC day cannot cover one maximum Study lesson. Select and record the live
count and bounded provider acceptance profile before real calls. The counter
pins a day's cap; do not reset usage or silently raise the same day's cap.
This source baseline changes no live count and spends nothing.

Keep Study's existing feedback and progression behavior. Compose the live
route with the shared sign-in and publication disclosure, and include its
private lessons in authenticated history/export and retention. Do not require
membership, a creator wallet or Palm for learning. The current imported
component still reports qualification as not_evaluated until the new policy
and authenticated publication/readback path are wired and tested.

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
