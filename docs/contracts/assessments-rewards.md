# Assessment, qualification and reward boundaries

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

Karaoke has four statuses: `assessed`, `silent`, `unpaid`, `unmeasured`.
Only assessed has a numeric score; do not publish a paid-looking score for an
unpaid line or turn unavailable measurement into a genuine zero. Existing
payment source counts silent/unpaid as zero in reward accounting and removes
unmeasured from the denominator, with a separate maximum-unmeasured threshold.
The payment implementation owns exact billing, line completeness and hash rules.

The newer [LearningRecords draft 2](learning-records.md) settles wallet-linked
public learning history, completion and policy-activation events, derived
qualification and reproducible streak boards. It adds `unattempted` for unreached
lines in the public record, without silently changing the payment result's four
statuses. Unattempted has no score and is not a measurement-failure exclusion
from the reward denominator. The payment-to-public-record adapter must prove
this mapping and reconcile complete manifest coverage before implementation.

Public learning records and public posts intentionally use different identities:
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

The copied draft and its [source digest](learning-records-source.json) preserve
the owner-approved clarifications without claiming an implemented contract.
Its generic `community` field must bind the directory's bytes32 communityId;
the payment account address is a separate field, not an interchangeable ID.
Stable songId must be namespaced by registration protocol/network, separate
from postId and content revision. Before a LearningRecords ABI is frozen,
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
self-review exclusion if Dance becomes eligible, including accounts linked to
the reviewing owner under the accepted account model.

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
