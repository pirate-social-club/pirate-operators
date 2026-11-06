# Compact public learning results, version 2 direction

Specification amendment prepared on 2026-11-06. This records the requested
direction after the mainnet cost review; it is not a deployed contract or a
frozen ABI. Public per-line grades remain the target. The publication unit
changes to one terminal result for a whole learning session. MOSS consent,
exact encoding and independent-provider settlement remain release gates.

The workspace_owner subsequently authorized the reviewed testnet-first plan.
The [testnet implementation](learning-results-testnet.md) selects standing
Karaoke enrollment, revocation blocking pending initial publication, immutable
community binding and the explicit contract/indexer manifest-verification
split. Those choices supersede the per-session consent wording below for this
testnet implementation. Mainnet work follows deployed testnet acceptance.

This amendment takes precedence over draft 3's per-line transaction/storage
shape and version 1's mandatory per-line payment mechanism for the next
implementation. It retains draft 3's public terminal coverage, corrections,
prospective policies, fixed learning clock and independent reconstruction.
The frozen [draft 3](contracts/learning-records.md), its source digest and
[payment specification](operator-payments.md) remain historical references.
[Encoding version 1](learning-records-contract.md) still describes existing
code. Neither old readers nor old contracts implement this amendment.

## Publication unit and public evidence

For Karaoke, one result covers a whole run against one pinned manifest. For
Study, one result covers a completed lesson/session with its pinned ordered
exercise set, rather than each line attempt. The public session ID is distinct
from its private line-attempt IDs. Retries, provisional feedback and detailed
progress remain in [learner-held history](learner-history.md).

Before implementation, the Study scoring policy must fix lesson completion,
retry limits and which attempt determines each published outcome. Record that
policy version in the consent and result. A client cannot pick favorable lines,
drop failures or redefine the denominator after seeing scores. Non-line
exercises need a typed outcome adapter; do not encode every exercise as a
Karaoke pronunciation score. Dance's separate review-time rules are unchanged.

One ordinary terminal publication carries learner consent, the authorized
grader's result commitment, session/source metadata and all ordered final line
statuses and grades in a compact event. Store only what identified enforcement
or contract readers require. Full public grades must be recoverable from chain
events and public manifests, without a private community API. Packing scores
into an event does not make them private.

The semantic envelope binds chain and verifying contract, bytes32 community
identity, learner, session ID, stable songKey, content revision, ordered line
commitment and count, activity, grader, scoring policy, qualification policy,
completion time, terminal status, result revision and superseded commitment.
The payment-account address is distinct from community identity. The exact
byte encoding, signature domain and ABI require a new version and independent
test vectors. Do not silently reuse version 1 consent bytes for changed rules.

The contract must reject duplicate sessions, unauthorized graders, invalid
consent, invalid ranges, incomplete/reordered coverage and invalid revisions.
Freeze how the ordered manifest commitment is enforced. The cost probe's
synthetic root does not establish this production property. Keep every status
from draft 3: assessed, silent, unpaid, unmeasured and unattempted. Only assessed
has a numeric score. Recompute qualification from the underlying outcomes;
never trust a grader-supplied aggregate merely because its range is valid.

An abandoned, expired or payment-missing run still has one terminal bundle
when publication consent permits it. Preserve its assessed outcomes and use
unattempted for unreached items, without fabricated numeric zeros. One ordinary
publication per session does not abolish these terminal records or require a
public transaction for each interim line. Do not create an on-chain opening
transaction merely to meter a private retry.

Corrections are additional authenticated publications, explicitly superseding
an earlier commitment. They retain the original completion time, learning
period and qualification policy. They cannot earn another day or settle the
same reward again. The exact full-bundle or delta encoding is not frozen; it
must support deterministic reconstruction and independent cost measurement.
Payment failure, crash recovery, unknown receipts, retries and reorgs must not
produce a duplicate ordinary result or let a stale publisher erase a correction.

## Consent is an unresolved release gate

The target remains learner-controlled consent enforced on chain. A code-less
MOSS address must not be treated as an ordinary ECDSA signer when it returns a
wrapped passkey signature. Native P-256 arithmetic verification alone does not
prove MOSS envelope parsing, address/key binding, WebAuthn challenge/context,
account authorization or replay protection. A nonzero account code also does
not by itself establish a compatible ERC-1271 implementation.

The MOSS work must qualify the complete actual consent path, for a new account
and an already activated account. If activation is selected, measure its
one-time mainnet cost and the recurring verification cost separately, and name
the payer, budget, delegation scope and recovery behavior. The testnet activation
branch and a reported native P-256 probe are evidence inputs, not completed
mainnet acceptance. This amendment authorizes no account activation.

A deliberately designed direct wrapped-signature verifier is another possible
route, but is unqualified until its full security and cost requirements pass.
Do not select it just because an arithmetic precompile exists.

Off-chain consent verification followed by publication of the consent evidence
is a different trust model. It remains a separately decidable alternative,
not an automatic fallback after a failed or unknown on-chain verification.
Putting consent bytes in an event lets readers audit them; it does not stop an
authorized publisher emitting a record without valid consent if the contract
does not check. Such a route needs explicit amendment of the enforcement
requirement, deterministic independent verification and invalid-record exclusion.

Until a route is selected and proven, publication fails closed or stays pending.
Define consent expiry for delayed terminal publication, abandonment and
corrections; version 1's opening deadline is not automatically the right rule
when there is no opening transaction. Do not discard a consent or timing check
to make the prototype price hold.

## Payments and small community budgets

Where Pirate is both community operator and service provider, use internal
usage accounting instead of on-chain transfers to itself. Keep authorization,
idempotent usage receipts, provider invoices and community caps. This is an
explicit same-owner service mode; unrelated communities paying Pirate are
independent customers, even when they use the same software or hosting.

Independent providers need a bounded prepaid session or funded escrow that
supports cumulative settlement. Exact pricing, refund and settlement rules
remain a separate contract design. The reservation must survive community
withdrawal or signer rotation for work already accepted. Define expiry,
cancellation, unspent-fund release, duplicate prevention, provider failure and
disputes. Version 1 purchases are revocable orders, so merely redeeming them
daily or weekly provides no payment guarantee. Batching current redemptions
alone does not fix that or remove per-line storage.

Replace the assumption that every assessed line needs its own redemption with
proof that its work is covered by the selected service mode. Do not fabricate
a purchase receipt for internal usage. The versioned result/verifier rules must
map session coverage to individual outcomes and distinguish lack of payment
coverage from silence or a measurement failure. Payment proves coverage, not
learning, and an internal usage receipt cannot authorize someone else's funds.

Community limits cover aggregate spending as well as individual eligibility.
Reserve worst-case allowed work before a paid provider call or transaction;
retries and uncertain outcomes continue to consume the reservation until
reconciled. Refuse new sponsored work when the budget or gas-price ceiling is
exhausted. No implicit treasury refill, member charge or reset through a new
wallet is permitted. Show sponsored-work availability separately from public
publication status. Do not promise free speech processing when its budget ends.

For funds held by a contract, enforce recipient/asset allowlists, per-session
ceilings and aggregate period limits independently of the service's spending
key. That key cannot raise its own limits. With a hosted sponsor, qualify the
provider-enforced limits and residual exposure. KMS custody alone does not stop
an authorized compromised service from spending its allowance. This document
adds requirements, not a claim that OperatorPayments currently enforces them.

ElevenLabs remains the launch transcription and forced-alignment provider.
Keep the shared daily speech-call bound and separate it from publication and
gas budgets. Lower-cost provider adapters are later work. Pricing must show
speech, chain fees, settlement and hosting separately rather than describing
the recording-only benchmark as the whole cost of a learning session.

## Leaderboards, trust and data availability

Boards remain rebuildable indexes over public result events, manifests,
prospective policy activations and eligibility changes. Preserve the common
17:00 UTC day, signed completion-time attribution, correction rules, reorg
handling and the separate reward-entry deadline. Two independently implemented
reducers must agree at the same chain head and evaluation time. Same-owner
accounting cannot make a private payment database a prerequisite for rebuilding
a public learning board.

Signed or on-chain grades identify who asserted an outcome; they do not prove
an honest live performance or unique personhood. Accept recognized words only
from the operator's authenticated provider path, not browser-supplied scoring
frames. Verify the deployed socket uses that path. Replay and synthetic audio,
colluding graders and multiple accounts remain explicit threats. Reward-funded
policies independently select graders and assurance requirements, deduplicate
entries and cap payouts; community approval alone grants no access to Pirate
funds. A private history import never qualifies a reward by itself.

Public manifest and policy availability remains required. No daily community
root is mandatory in addition to the compact results. Add a root only for an
identified verifier/settlement consumer; a hash does not establish truth,
completeness or availability. Rich private tutor history is not part of the
public leaderboard's reconstruction dependency.

## Cost baseline and acceptance

The audit is pirate-workspace commit
684d6ab088d9d1ba937b7a5c7de4bf062fc51a7b, package
tasks/evidence/pirate-mainnet-contract-costs-20261106/. It prices source
462c4257880ea580e0c0311191541a8a03109c1d through pinned MegaETH mainnet
RPC simulations. At 0.001 gwei and ETH/USD 2,230.56, including estimated L1
data fees, the current 40-line recording/payment shape costs about $0.044146;
batching both in groups of 40 costs $0.028249. The consent-inclusive compact
40-line recording probe costs $0.000624, about $5.62 for 9,000 publications.

The compact figure excludes operator payments, STT/alignment, hosting, rewards,
activation and relay fees. It uses EOA consent and omits production manifest,
correction and policy machinery. Payment measurements use a fixture ERC-20.
The price is neither an all-in quote nor a permanent promise. Gas/state and
exchange-rate changes, failed transactions and retries need fresh estimates
and bounded execution. One session per learner per day is a modeling assumption,
not a newly imposed participation rule.

Implementation acceptance must freeze and independently test the new encoding,
manifest binding, Study retry selection, consent/expiry route, terminal and
correction semantics, two-indexer agreement and payment modes. Re-measure the
complete implementation with actual MOSS verification and the selected asset,
including activation, worst-case corrections and failure/recovery charges.
Prove concurrent reservations cannot exceed community caps. The historical
benchmark remains evidence; none of these future checks is claimed as passed.
