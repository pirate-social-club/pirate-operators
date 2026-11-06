# Assessment, qualification and reward boundaries

For the next implementation, the [compact public results amendment](../learning-results-v2.md)
owns publication granularity, service payment modes and the unresolved MOSS
consent route. [Private learner history](../learner-history.md) owns portable
tutor data. Existing grading, learning-clock and reward-authority distinctions
below remain unless that amendment explicitly supersedes them.

These are later implementation boundaries, not new reward contracts or an
activation decision. Public-post admission, an educational grade, a qualifying
entry and a payable reward are different records with different authorities.

## Assessments

Use one versioned assessment envelope with a typed objective and result body.
Bind community, subject/post and source revision, attempt, assessor identity,
assessor-policy version, result digest and completion/review time. Each adapter
retains its actual grading semantics. Do not reuse the karaoke scorer merely
because Study also includes audio input.

| Objective                 | Grader and result                                                                             | Constraints to preserve                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Study: say_it_back        | Reference/transcript comparison, including meaning-changing words and script-aware phonetics. | The centralized `study-v2-grading.ts` uses `script_aware_token_phonetic_v4`; its own acceptance policy and review schedule are needed in the port.         |
| Study: translation_choice | Exact selected-answer match.                                                                  | Already part of centralized Study, not a hypothetical later exercise. Bind exercise version and answer key without publishing private answers prematurely. |
| Karaoke                   | Timed per-line scoring and separate reward accounting.                                        | Below three lines/eight matched words, timing is uncalibrated but line scoring continues with neutral timing 0.85. This does not make it Study's grader.   |
| Dance                     | Human community-owner review, categorical pass/fail.                                          | V1 retains account-level self-review exclusion. No general moderator/transfer API or invented numeric grade follows from this ruling.                      |

The [payment specification](../operator-payments.md), copied exactly from
`412c098` with [provenance](../payment-specification-source.json), defines five
Karaoke statuses: `assessed`, `silent`, `unpaid`, `unmeasured`, `unattempted`.
Only assessed has a numeric score. An unreached line is unattempted whether paid
ahead or not. Silent, unpaid and unattempted count zero in reward accounting;
unmeasured is removed from the denominator with its own maximum threshold.
The payment lane owns billing, complete-line coverage, timing validation and
hashes. The copy publishes its field definitions; the runtime is published
separately in [PR 14](https://github.com/pirate-social-club/pirate-operators/pull/14)
at the same commit and is not included in this specification branch.

Karaoke learning credit uses signed performanceEndedAt, when singing stopped,
not lastAudioAt or endedAt. The latter remains the operator decision/payment
clock. A performance ending at 16:59:58 keeps the earlier learning day if payment
finalization occurs after 17:00. This does not alter the existing reward entry
window's separate endedAt and acceptance-time checks. The UI must display
learning credit separately from pending/accepted/missed drawing entry. A learner
can keep that day's credit and miss that drawing when finalization or verifier
acceptance crosses the cutoff. Use the explicit copy in LearningRecords; do not
promise an entry from a streak or assume automatic entry in a later drawing.

The [LearningRecords draft 3](learning-records.md) preserves the actual earlier
approval: the shared learning clock, prospective policy activation and terminal
records for abandoned attempts. That approval did not separately settle the
learner's public identity. In response to the owner's request for the simplest
approach, this revision recommends wallet-linked records with per-attempt
consent. It labels that as a proposed default, not an earlier owner ruling or
permission to emit public grades. The public field/status model and real consent
verification still need implementation acceptance.

Under that proposal, public learning records and posts use different identities:
learner wallet and community-scoped authorId respectively. Raw recordings and
provider evidence remain private. Per-attempt learner consent must bind chain,
contract, learner, community, source, grader and scoring policy; actual MOSS
verification remains an integration check. A community attestation is not an
automatic substitute. Public learning history and reward entries are linkable
by wallet; scoped post IDs do not remove that exposure.

LearningRecords also requires one protocol clock, epoch `1793552400`, period
86400 seconds and a shared 17:00 UTC boundary. PolicyActivated is prospective;
delayed completions and corrections retain their original completion period
and policy. Two independent reducers must agree at a pinned chain head and
evaluation time. That clock does not replace the reward drawing cutoff.

For Dance streaks, the recommended rule is the period of the first final
owner decision recorded on chain. The contract sets reviewedAt/completedAt to
that block time, a pass earns credit then, and a failure earns none. Submission
time cannot backdate ordinary review credit. An explicit correction retains
the first review period and its policy; it cannot create another day. This
chooses deterministic review-day accounting over submission-day attribution and
makes both review and publication latency visible to learners. An off-chain
approval at 16:59 published at 17:01 earns the next day; publishing backlog,
wallet/gas failure or chain outage can break a streak. The UI distinguishes
pending review from approved but awaiting publication and discloses this rule.
There is no implicit outage grace or backdating. It is separate from the prize cutoff.

The Dance contract checks owner authority and reviewer-address inequality with
the learner wallet. The community service enforces account-level self-review
exclusion with private account-to-wallet associations, rejecting every linked
owner wallet before accepting/publishing a decision. Unlinked alternate wallets
and direct owner calls bypassing that service remain a trust limitation; on-chain
address inequality does not prove distinct people. Keep the private mapping out
of public posts and grades. A Pirate-funded policy would need separately accepted
review/account assurance and enforcement; owner authorization alone is insufficient.

The copied draft and its [source digest](learning-records-source.json) preserve
the three approved clarifications and label the new recommendations separately.
LearningRecords v1 is implemented; the compact successor is not.
Its generic `community` field must bind the directory's bytes32 communityId;
the payment account address is a separate field, not an interchangeable ID.
Local song streaks use songKey=(chainId, postsContract, communityId, postId),
so an external registration migration cannot split them. Registration references
are optional protocol/network-qualified grouping keys for cross-community
boards, under an explicit alias policy. Content revisions do not change songKey.
Before a LearningRecords ABI is frozen,
resolve manifest membership/coverage proofs, stored fields and readers, the
payment mapping, categorical Dance and non-line Study result adapters, and
on-chain learner consent. A generic line-score shape alone cannot express
every objective's semantics. Community qualification policy activation belongs
to LearningRecords as specified; directory config references its address and
must not introduce a competing activation history.

## Daily qualification

The [existing policy](../operator-protocol.md) already has drawingId,
entryOpensAt/cutoff, score and measurement thresholds, one entry per pool/drawing/
wallet, and repeated qualifying attempts collapsing into that entry. Extend it
with explicit task IDs/objectives, source revisions, accepted assessor policies
and an acceptance rule such as all required tasks. Do not create an independent
second daily limit that disagrees with the committed policy.

Freeze and disclose the task policy before its entry window. Community config
may select educational assessors, but it cannot authorize its own assessor to
draw Pirate funds. A Pirate-funded policy independently approves the verifier,
assessors and allowed objectives. Dance eligibility for those drawings is
unresolved even though human owner review is confirmed. Preserve owner/account
self-review exclusion if Dance becomes eligible, including wallets linked to
the reviewing owner under the accepted account model. Specify the service/trusted
verifier enforcement and assurance limits; the contract's address check alone
cannot establish account-level exclusion.

Separate the entry cutoff, chosen MegaETH confirmation requirement and Base
ticket-purchase deadline. Measured testnet safe lag of 111–171 seconds and
finalized lag of 1,817–1,885 seconds are one observation, not a mainnet timing
guarantee. The purchase process must allow measured confirmation, Base inclusion
and recovery margin. A Dance approved after the committed cutoff cannot join
that drawing. Proposed extension: assign it to the next eligible open drawing
under a disclosed policy, without backfilling or giving a second entry. Confirm
this policy before enabling it; the centralized approval-day rule alone does
not resolve a cross-chain cutoff.

## What RewardPool actually implements

The current [RewardPool](../../contracts/RewardPool.sol) has one immutable
drawing and the deploying sponsor for its lifetime. It commits entries before
ticket purchase, calls Megapot's buyTickets/claimWinnings directly on the same
chain, settles winnings, registers qualifying claimants with Very, and divides
the winnings equally among those who registered. The root does not commit fixed
recipient amounts. Unspent purchase funds and sponsor remainder return to the
single sponsor. Finalized claimant allocations do not expire.

The contract trusts the verifier for grading/entry eligibility; it does enforce
entry proofs, claimant authorization, duplicates and the credential boundary.
Very is checked at registration after funding/outcome, not replaced by an earlier
community membership check. Very unavailability fails registration closed.

The centralized October 17 shared-song-pot/open-funding direction needs an
explicit decentralized adoption decision. Its lifecycle draft was not ratified
as contract implementation. Reusing this RewardPool would not provide a pot
spanning daily drawings, contribution attribution or refunds to each contributor.
A future treasury/contribution ledger and per-drawing accounting must define
those obligations, who owns unspent funds and dust, cancellation and recovery
before an ABI fixes them. No additional pot contract is declared built here.

## Base funding and bridge

The owner said the bridge “should/could probably be pirate managed.” Treat this
as a tentative operating preference, not approval for Pirate to custody funds
on Base. No Pirate contract is to be deployed there. With that constraint, an
approved Pirate-run Base purchase/claim path would use an EOA and explicit
operational custody; a Safe or helper deployment is not an unnoticed workaround.

The complete proposed state sequence is:

```text
policy published -> entries committed and confirmed on MegaETH
-> Base ticket funding and purchase -> drawing outcome and Base winnings claim
-> bridge submission -> authenticated MegaETH funding credit
-> claim-time Very registration -> equal split -> claimant withdrawals
```

Commitment and Base purchase must name the same drawing and intended ticket
allocation. Source ticket ownership, balance reconciliation and deadlines need
receipts. Without a cross-chain proof/contract, receipts audit the Pirate EOA's
behavior but do not enforce that linkage on chain. Document that custody trust.

A destination funding adapter must reconcile actual token balance received,
asset/decimals, source chain/transaction, destination address and a unique credit
identifier. It must reject replay, forged callbacks and double-crediting. It
credits drawing balances; it must not bypass Very or fix recipient amounts before
registration. Batching means one transfer can fund multiple drawings with an
explicit allocation ledger; it is not necessarily one bridge per drawing.

Select the supported Base-to-MegaETH route, output asset, fees, slippage,
minimum economical batch, finality/reorg rules and stuck-transfer recovery by
actual quotes and tests. The [MegaETH bridge page](https://docs.megaeth.com/user-guide/bridge)
lists Stargate USDT0/USDm and a USDC-to-USDm conversion route; that alone does not
establish the desired Base source route, execution cost or availability.
Neither this slice nor the prior audit obtained a bridge quote.

The old pool's emergency recovery and sponsor refunds have no automatic
cross-chain equivalent. Define recovery for missed purchases, cancelled drawings,
failed claims/bridges, zero registrants, contributor refunds and excess/dust
before implementing funding. Reward eligibility, open funding, custody, asset
selection and recovery remain outside the first-song milestone.
