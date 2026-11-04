# Operator payments and per-line karaoke billing, version 1

This document specifies how a community pays operators for admission checks
and karaoke scoring, and what an operator's karaoke result contains. It is a
design contract for implementation in pirate-operators; section 11 lists what
exists so far.

Karaoke is billed per lyric line, and our contracts deploy to MegaETH. In
the original experiment draft this document replaces sections 9.1 to 9.6,
decision D3, the payment fields of the section 8.2 ticket, the consumption
fields and `ceiling_reached` status of the section 8.4 result, and the
`minScoreBps` and `minCoverageBps` thresholds of the section 10.1 reward
policy, for which section 6 substitutes a fixed-denominator score.

It keeps the section 9.7 sponsorship policy and the rest of section 10. The
reward pool's prize source is a separate open decision; nothing here depends
on it. Public per-line grade records are a later document that consumes the
result of section 5.6.

## 1. Model

- A payment contract on MegaETH, `OperatorPayments`, owns payment identity,
  duplicate prevention, the community's spending authority and the transfer
  to the operator. There is no off-chain payment ledger.
- A community deposits funds into the contract and names a signing key. For
  each unit of work it signs one purchase authorization. It sends no
  per-line transaction.
- The operator verifies an authorization, redeems it, and counts the unit as
  paid only once the redemption of that exact purchase is confirmed on chain.
  Anyone may redeem an authorization; the contract pays the signed recipient
  either way.
- Authorizations are revocable purchase orders, not funded vouchers. A
  community may withdraw or rotate its signer at any time, and outstanding
  authorizations may promise more than its deposit. An operator therefore
  relies on a confirmed redemption before incurring any cost it needs covered.
- Every unit has a fixed price that the operator quotes in advance. Nothing
  is metered.
- There are two kinds of unit: an admission job, which checks one song
  revision, and a karaoke segment take, which pays for scoring one billing
  segment once.

In this lane the contract and payments run on MegaETH testnet, chain 6343,
with the registry lane's test token PirateTestUSD (`ptUSD`, 6 decimals, no
value) at `0xC5321666F425812D1C12F44dA7BFe08CEB00044B`. Local tests use anvil.
The deployment profile pins the chain, token and contract addresses. The
production asset is not decided here.

Neither side needs a Durable Object for payments. The community's remaining
state is a few SQL rows; the operator's redemption queue is one table. A
Durable Object stays an optional way to hold the operator's live karaoke
connection.

## 2. Operator quote

An operator publishes signed quotes:

```text
OperatorQuote {
  operator          // signs quotes and results
  recipient         // receives payments
  chainId
  payments          // the OperatorPayments contract
  token
  admissionPrice    // per song revision, all four checks together
  segmentPrice      // per karaoke segment take
  scoringPolicy     // e.g. "karaoke-scoring/5"
  maxSegmentMs      // the longest segment the segment price covers
  maxUnpaidRun      // consecutive unpaid segments before the operator may end an attempt
  validFrom
  validUntil
}
```

Prices are integers in the token's smallest unit. `quoteId` is the hash of
the signed quote body, so an ID can never name different terms. A
community's trusted-operator policy lists the quote IDs it accepts. A ticket
or admission job names its quote and is billed under it until it ends.

## 3. Purchases

### 3.1 The contract

`OperatorPayments` holds each community's deposit per token and records,
for each unit, the digest of the purchase it paid:

- `setSigner(signer)`: the caller's address is the community; this names
  the key that signs its purchases. Rotating it revokes every outstanding
  authorization signed by the old key.
- `deposit(community, token, amount)`: anyone may fund a community.
- `withdraw(token, amount, to)`: immediate. It may leave outstanding
  authorizations unfunded, which section 1 accepts.
- `closeTicket(community, ticketId)`: the caller, as operator, closes a
  ticket. No later purchase for that ticket naming that operator is paid.
- `redeem(purchase, signature)` and `redeemBatch(purchases, signatures)`.
  The batch isolates failures, so one bad item never blocks the rest.
- `redemption(community, unit)` returns the digest of the purchase paid for
  the unit, or zero.

A redemption succeeds only when the current time lies in the purchase's
signed interval, from `validAfter` until before `expiresAt`, the interval is
at most `MAX_AUTHORIZATION_LIFETIME` (1 hour) long, the ticket is not closed
for that operator, the unit has not been redeemed, the signature recovers to
the community's current signer, and the deposit covers the amount. It then
stores the purchase's digest for the unit, debits the deposit, transfers the
amount to the signed recipient and emits
`Purchased(community, unit, operator, digest, ticketId, quoteId, recipient, token, amount)`.
A failed transfer reverts everything, so the unit stays unredeemed. The
interval bounds when a purchase can be redeemed; it cannot prove when the
signature was made.

### 3.2 Authorization

The community signs EIP-712 typed data in the domain
`Pirate Operator Payments`, version `1`, with the chain ID and the contract
address:

```text
Purchase {
  address community   // the community's address in the contract
  bytes32 unit        // keccak256 of the unit key
  bytes32 ticketId    // zero for admission jobs
  bytes32 quoteId
  address operator
  address recipient
  address token
  uint256 amount
  uint64  validAfter
  uint64  expiresAt
}
```

The unit key is `segment:<ticketId>:<segmentId>:<take>` or
`admission:<jobId>`. Because the unit names the ticket, one learner can never
spend a purchase made for another learner's line; the contract pays it once,
to the signed recipient, for that unit only. The community signs at most one
purchase per unit. An authorization's `validAfter` is no later than its
signing time; the community may set it a few minutes earlier to absorb clock
skew with the chain. Its `expiresAt` is no later than its ticket's
`expiresAt`, and the interval stays within the contract's one-hour bound.

Signing is deterministic, and the community keeps one row per unit holding
the signed authorization. A repeated request for the same unit returns the
same authorization, so a crash never strands one.

### 3.3 Operator verification and redemption

Before redeeming, the operator checks off chain that:

1. the quote is one of its own, and the authorization's `quoteId`,
   `operator`, `recipient`, `token` and `amount` equal it, with `amount`
   exactly the quoted price for the unit's kind;
2. the authorization's chain and contract are the quote's;
3. for a segment, the ticket named by the unit is one it holds, with the
   same community, quote and operator, and, on a socket, that socket's ticket;
4. the signature recovers to the community's signer as the contract reports
   it, and the authorization has not expired;
5. the contract reports the unit unredeemed and the deposit sufficient.

A failure answers with a code from section 5.7. The operator then submits
`redeem`, or adds the purchase to a `redeemBatch`. The unit counts as paid
only when the contract's `redemption(community, unit)` equals the digest of
the very purchase the operator holds, confirmed by a receipt or, after an
uncertain submission, by reading contract state. A redeemed unit with a
different digest is a different purchase, perhaps to another recipient or
for another amount; the operator treats its own as `already_paid` and does
not count the line as paid to it. The contract refuses a second redemption,
so retrying an uncertain submission can never pay twice, though a duplicate
submission still costs gas.

### 3.4 Acceptance policy

For this experiment the operator accepts a successful mini-block receipt.
That is an acceptance policy, not finality. MegaETH documents that
mini-blocks and EVM blocks carry the same sequencer preconfirmation
guarantee, while settlement on Ethereum comes later. A reversal could undo
many redemptions together. MegaETH also documents possible testnet state
rollback, and testnet evidence records any that occurs.

## 4. Admission jobs

An admission job checks one song revision. Its `jobId` is the digest of the
song's inputs, so a retry for the same revision has the same key.

1. The community signs a purchase for `admission:<jobId>` at the quote's
   `admissionPrice`.
2. It sends the song and the authorization to the operator.
3. The operator verifies and redeems it (section 3.3), runs the four checks
   and returns the signed evidence.
4. A repeated request with the same `jobId` returns the stored evidence and
   needs no new purchase.

The price buys the assessment, so a rejection is delivered work. If the
operator cannot produce evidence after redeeming, it returns a signed
`AdmissionFailure { jobId, unit, reason, issuedAt }`; a refund is an ordinary
transfer by hand. This version has no automatic refund.

## 5. Karaoke

### 5.1 Billing segments and scored lines

Billing and scoring use different units. A billing segment is an entry in
the section 8.3 segment manifest. A scored line is one timed lyric line as it
occurs in the song, identified by a stable occurrence ID and version in the
manifest; a chorus line sung three times is three scored lines. A line is
paid when the segment containing it is paid.

For per-line billing the manifest has one segment per scored line. Every
segment covers one or more complete scored lines, so no line is split across
segments. No segment may be longer than `maxSegmentMs`; the community refuses
to issue a ticket under a quote if any segment is longer. Grouping lines into
longer segments changes what each purchase covers, not the scored lines,
their weights or the reward denominator.

### 5.2 Ticket

The section 8.2 ticket loses `chainId`, `asset`, `channelId` and `maxCost`.
It gains:

```text
  manifestSha256    // the pinned manifest
  quoteId           // the operator quote this attempt is billed under
  community         // the community's address in OperatorPayments
  mode              // "performance" or "practice"
  maxPaidSegments   // performance: the manifest's segment count
                    // practice: the most takes the community will pay for
  maxDurationMs
```

Everything else stays, including the per-attempt browser key in `sessionKey`.

The community never authorizes more than `maxPaidSegments` purchases per
ticket. At issuance it adds the ticket's maximum,
`maxPaidSegments × segmentPrice`, to the wallet's sponsorship usage for the
period (section 9.7), once. Once the ticket's purchases can no longer be
redeemed, it replaces that maximum with the amount the contract actually paid
for those exact purchases. A wallet may hold one open performance ticket at a
time. The deposit in the contract caps the funds available at any moment, not
spending per period: replenishing it permits further spending, and admission
purchases do not draw on the wallet allowance. Configurable per-period
sponsorship limits for the community remain deployment work.

### 5.3 Attempt timing

The operator's first `ready` for an attempt carries a signed
`AttemptStart { ticketId, attemptId, startedAt }`. A resumed connection
carries the original. In performance mode playback has no pause or seek:
the song position is the time since `startedAt`.

The attempt records `lastAudioAt`, when the operator last received audio,
and `endedAt`, when the operator decides the attempt is over, at the first of
these terminal events:

- the browser's `{ "type": "finish" }` message, giving `completed`;
- the end of the last segment, giving `completed` if the socket is connected
  and `abandoned` if it is not;
- the ticket's `expiresAt`, or `startedAt + maxDurationMs`, giving `expired`;
- a `payment_missing` stop;
- the end of the reconnect window after a disconnect, giving `abandoned`.

A socket that closes without `finish` is a disconnect, not a terminal event.
The attempt waits `reconnectWindowMs` (default 30 seconds) for the same ticket
and key to reconnect, unless another terminal event comes first.

Two clocks follow. `endedAt` is the operator's decision time and governs the
reconnect window, payment grace and finalization. `performanceEndedAt` is
when singing stopped and governs reachability: it equals `endedAt`, except that
an attempt ending while disconnected stops at the disconnect time. A learner
who disconnects at second 6 and never returns has reached only the lines that
began before second 6, although the attempt is decided later. For public
learning records, a karaoke attempt's completion time is its
`performanceEndedAt`.

Capture and finish never wait on the payment chain. A `words` or `finish`
frame is applied on arrival, after only the attempt's synchronous timers, so
the finish keeps its arrival time. Refreshing purchases from the contract runs
afterwards and on each tick; if the RPC fails or is slow, purchases stay
pending for the next attempt, and scores stay withheld until payment is
confirmed. Only the
newest connection is live: each accepted connection increments the attempt's
generation, older sockets for the ticket are closed, and a superseded socket's
messages and close are ignored, so it can never disconnect its replacement.

`paymentDeadline` is `endedAt + paymentGraceMs` (default 10 seconds). The
operator accepts authorizations for the attempt until then. Acceptance and
finalization are serialized on the attempt's row, so an authorization still
being verified when the deadline passes is refused with `attempt_closed`.

Stopping the operator's own submissions is not enough, because anyone may
redeem an unexpired authorization. So at the deadline the operator calls
`closeTicket(community, ticketId)` and waits for it to confirm. From then on
the contract refuses every purchase for that ticket naming that operator,
whoever submits it. The operator then reconciles each segment from contract
state, read at the closure's block: a segment counts as paid when the
contract's `redemption(community, unit)` at that block equals the digest in
its `Purchased` event, and the event names this operator and the quoted
recipient, token, amount and quote, whoever redeemed it. That includes a
redemption confirmed after the deadline but before the closure. Only then
does it sign the result, which is immutable. A crash after closure repeats
the reconciliation at the recorded closure block and produces the same
result. Both defaults are provisional.

### 5.4 Performance payments

The browser drives payment, because it is where the song plays.

1. The browser sends the operator's `AttemptStart` with its first purchase
   request. The community verifies the operator's signature and records
   `startedAt` for the ticket; the first valid one wins.
2. For each upcoming segment, the browser asks the community, with its
   session cookie: `POST /api/karaoke/purchases { ticketId, segmentId, take: 0 }`.
3. The community authenticates the request: the session's wallet is the
   ticket's participant and the segment is in the ticket's manifest.
4. It returns an existing authorization for the unit before applying any
   limit, even after the ticket has ended or the window has closed.
5. Otherwise it applies the limits in the same atomic write that records the
   new authorization: the ticket is open, `take` is 0, fewer than
   `maxPaidSegments` purchases are authorized, and the request time lies
   between `startedAt + segment.startMs − paceAheadMs` and
   `startedAt + segment.endMs`, with `paceAheadMs` defaulting to 15 seconds. A
   request that is too early is refused without a row, so it can be retried.
6. It signs and returns the authorization.
7. The browser delivers it to the operator (section 5.7).

The window stops a client from buying lines early, and from buying lines
that have already passed. Total spending is bounded by the ticket's maximum,
one open performance ticket per wallet, the wallet's sponsorship allowance
and, finally, the deposit in the contract.

### 5.5 Practice mode, an optional proposal

Practice mode is a proposal from an earlier draft, not an agreed requirement.
Per-line performance billing and grading do not depend on it, and it is not
built. If adopted, it works as follows. The learner chooses a line and may
repeat it. Each take of a segment is its
own unit, and `take` counts from 0 for each segment. Practice has no
`startedAt` window. The community authorizes one take at a time. It
authorizes the next take only after one of these:

- an operator-signed `TakeResult { ticketId, segmentId, take, status, scoreBps, issuedAt }`
  for the previous take, verified by the community;
- the previous take's authorization has expired.

`maxPaidSegments` bounds the total. An unsigned message relayed by the
browser never unlocks a purchase. Single-line takes cannot use the session
timing calibration, which needs at least three lines and eight matched
words, so practice needs its own named scoring policy.

### 5.6 Scoring and the result

The audio connection stays continuous. A billing boundary is not a provider
request boundary, so the operator may send audio that spans lines to its
transcription provider. It may process audio before the purchase is
redeemed, at its own risk, but it delivers no numeric score for a line,
provisional or final, on the socket or in any record, until that line is
paid. If `maxUnpaidRun` consecutive segments end with no purchase received,
it may stop the attempt with `payment_missing`. A purchase received and still
being redeemed counts as received, so a slow redemption never stops an
attempt. Before the rule reads purchase state, each tick and each recovery
refreshes unresolved purchases from contract state, so a redemption that
failed counts as missing without waiting for a client retry.

At finalization each scored line takes one status:

| Status | Meaning | Educational score | Reward treatment |
|---|---|---|---|
| `assessed` | paid, measured, with recognized singing | the score | the score |
| `silent` | paid and measured, nothing recognized | none | zero |
| `unpaid` | its segment had no confirmed redemption | none | zero |
| `unmeasured` | paid, but the measurement failed | none | excluded, within the policy's limit |
| `unattempted` | the line began at or after the performance cutoff, paid or not | none | zero |

A line is reached when it begins before `performanceEndedAt`, measured as time
since `startedAt`. Only reached lines are scored or enter the timing compensation.
An unattempted line stays distinct from silence during a reached line, a
missing payment and a measurement failure. Any purchase made for it remains
visible in `OperatorPayments`.

The educational score is nullable. An absent assessment is never published
as a numeric zero, so no other application can read it as demonstrated
inability. The reward score derives zero or exclusion from the status:

```text
denominator    = linesTotal − unmeasuredCount
rewardScoreBps = floor(sum of scoreBps over "assessed" lines / denominator)
```

Every `scoreBps` is an integer from 0 to 10,000. `linesTotal` is the number
of scored lines in the pinned manifest. If the denominator is zero, the
attempt has no reward score and cannot qualify. The session timing
compensation runs over paid lines only, and the scorer's own summary stays as
the learner-facing assessment. Withholding a purchase for a weak line lowers
the reward score exactly as much as missing that line.

The section 8.4 result loses `consumedMs`, `charged` and `ceiling_reached`.
Its statuses are `completed`, `abandoned`, `expired` and `payment_missing`.
It carries `finality` and `revision`, so a later published correction can
supersede it explicitly, and it gains:

```text
  manifestSha256, quoteId, community, mode
  startedAt, lastAudioAt, performanceEndedAt, endedAt
  paidCount, paidAmount
  linesTotal, unmeasuredCount, rewardScoreBps
  linesHash         // JCS hash of pirate.karaoke.lines/1
  billingHash       // JCS hash of pirate.karaoke.billing/1
```

```text
pirate.karaoke.lines/1 [
  { lineId, lineVersion,
    status: "assessed" | "silent" | "unpaid" | "unmeasured" | "unattempted",
    scoreBps: integer | null } ]

pirate.karaoke.billing/1 [
  { segmentId, take, lineIds,
    redemption: { chainId, payments, unit, digest, txHash } | null } ]
```

### 5.7 Messages, routes and errors

An authorization reaches the operator on the attempt's socket or by
`POST https://<operator>/attempt/purchases` with the signed authorization as
the body. The browser uses the HTTP route while reconnecting and during
grace; the community may post authorizations itself. Both routes apply
section 3.3 and return the same codes.

| Direction | Message |
|---|---|
| operator to browser | `ready` gains `"attemptStart": <signed AttemptStart>` |
| browser to operator | `{ "type": "purchase", "purchase", "signature" }` |
| operator to browser | `{ "type": "paid", "segmentId", "take" }`, once the redemption is confirmed |
| browser to operator | `{ "type": "finish" }`, which ends the performance deliberately |
| operator to browser | `{ "type": "take_result", "result": <signed TakeResult> }`, in practice mode only |

Errors arrive as `{ "type": "error", "code" }` on the socket, or as the JSON
body of a 4xx response on the HTTP route. On the socket they leave the
connection open, except `payment_missing`, which ends the attempt with close
code 4402:

| Error code | Cause |
|---|---|
| `invalid_purchase` | bad signature, or fields that disagree with the quote or ticket |
| `purchase_expired` | the authorization has expired |
| `already_paid` | the contract reports the unit redeemed by an earlier purchase |
| `insufficient_deposit` | the community's deposit does not cover the amount |
| `redemption_failed` | the redemption reverted |
| `attempt_closed` | the attempt is finalized, or the deadline passed before acceptance |
| `payment_missing` | `maxUnpaidRun` consecutive segments went unpaid |

## 6. Qualification

Section 10 stands, with these changes:

1. A reward policy names the quote IDs it accepts.
2. `minScoreBps` and `minCoverageBps` give way to `minRewardScoreBps` and
   `maxUnmeasuredBps`. An attempt qualifies only if its denominator is
   positive, `rewardScoreBps` is at least `minRewardScoreBps`, and
   `unmeasuredCount × 10000 ≤ maxUnmeasuredBps × linesTotal`.
3. Only `performance` results can become entries.
4. The verifier loads the pinned manifest and checks both lists against it:
   exactly one line entry for every scored line, with no omissions,
   duplicates or IDs the manifest lacks, every `scoreBps` an integer from 0 to
   10,000 or null as its status requires, and exactly one billing entry per
   segment with that segment's `lineIds`. It checks the timing bounds,
   `startedAt ≤ performanceEndedAt ≤ endedAt` with the performance no longer
   than the song, and that exactly the lines beginning at or after
   `performanceEndedAt` are `unattempted`, using the same reachability rule
   as the operator.
5. It recomputes `linesHash`, `billingHash`, `linesTotal`, `unmeasuredCount`
   and `rewardScoreBps`. It checks that no line of a paid segment is
   `unpaid` and that every line of an unpaid segment is `unpaid` or
   `unattempted`,
   that `paidCount` counts the paid segments and that `paidAmount` equals
   `paidCount × segmentPrice`. It may confirm each paid segment against the
   contract: `redemption(community, unit)` equals the listed digest, and the
   `Purchased` event names the quoted operator, recipient, token, amount and
   quote. A shared redeemed flag is not enough.

## 7. The community

The community holds a signing key and a deposit, and sends a transaction
only to set its signer, deposit or withdraw. Its per-line work is to check
limits and sign. It keeps:

- one purchase row per unit, keyed under its ticket;
- per wallet, one record holding its sponsorship usage and its open ticket's
  reservation, including `startedAt`.

Each state change that must happen together lives in one record. Issuing a
ticket is one compare-and-set on the wallet record, and the signed ticket is
rebuilt from that reservation, so an interrupted issuance retries into the
same ticket. A new purchase is one conditional insert that also enforces the
ticket's purchase count, so an interrupted insert consumes no slot and the
community never signs two purchases for one unit. Settlement is one
compare-and-set that releases the unused reservation and closes the ticket,
so it simply runs again if interrupted. A compromised signing key
can spend up to the deposit, so the community keeps the deposit small and
rotates the signer if the key is exposed. Funding the
deposit and the signer's custody are the community's operating concerns;
neither needs Pirate.

## 8. The operator

The operator keeps its quotes; tickets and manifests; attempt state with
`startedAt`, `lastAudioAt`, `endedAt` and finality; the words it received;
and a redemption row per unit:

```text
accepted -> submitted -> confirmed
                      -> failed
```

Purchase status and transaction status are tracked separately. The
redemption row holds the authorization and its digest; its status comes from
contract state. `redemption(community, unit)` equal to the row's digest means
confirmed, whoever redeemed it; another digest means `already_paid`; zero
with an expired authorization means failed.

Accepted work is persisted as a transaction intent, keyed by kind and
reference, in the same synchronous step that records the redemption, before
any RPC call. Ticket closures are intents too. Dispatching an intent
allocates its nonce exactly once and stores the signed transaction before any
broadcast. An RPC failure before allocation leaves the intent in place, and a
retry of the same purchase or recovery dispatches it. The sender keeps one
row per nonce. A transaction row stays
tracked until its nonce is consumed on chain, even after its purchase has
become confirmed or failed, because a later closure cannot execute while an
earlier nonce is unresolved. Recovery rebroadcasts the stored transaction for
every unresolved nonce. A redemption that has become moot then reverts
harmlessly and consumes its nonce. Recovery never signs a new transaction for
an allocated nonce, because a duplicate costs gas and a stuck nonce blocks
every later submission from the operator's key. This is an ordinary durable
queue and transaction sender; it needs no Durable Object.
The operator pays redemption gas and prices it into its quote; batching
redemptions is an optimization, not a requirement.

## 9. Failure policy

| Case | Outcome |
|---|---|
| The learner sends `finish` | `completed`. Lines not yet reached are `unattempted`, including any bought ahead; nothing is refunded. |
| The socket drops and the learner returns in time | The same attempt resumes; bought lines stay paid. |
| The socket drops and the learner does not return | `abandoned` when the reconnect window ends. |
| A redemption confirms after the deadline but before the closure | It counts; reconciliation reads it from the contract. |
| Someone redeems an authorization after the closure | The contract refuses it with `ticket_closed`. |
| An authorization arrives after the deadline | Refused with `attempt_closed`; after the closure it can never be redeemed. |
| The operator's submission times out or it crashes | Recovery reads the stored digest; no second payment is possible. |
| A different purchase was redeemed for the unit | `already_paid`; the line is not paid to this operator. |
| The same authorization arrives twice | The existing row is returned. |
| A second authorization for a paid unit | Refused with `already_paid`. |
| The deposit runs out | `insufficient_deposit`; the line is `unpaid`. |
| The operator cannot measure a paid line | The line is `unmeasured`. |
| An admission job is not delivered after redemption | Signed `AdmissionFailure`, refunded by hand. |
| A community withdraws or rotates its signer | Outstanding authorizations may become unredeemable; operators only count confirmed redemptions. |

Refunds for segments are a proposed testnet policy, not a settled rule.

## 10. Testnet acceptance

The MegaETH testnet run records the round trip from the browser's request to
the operator's `paid`, at p50 and p95, against the gaps between lines; gas per
redemption and per batch; and the cost of a song.

It also passes these cases:

1. An authorization for a different token, chain, contract, recipient or
   amount from the quote's is refused before redemption.
2. An authorization for one ticket is refused on another ticket's socket.
3. A redemption whose submission times out, or whose operator crashes after
   submitting, resolves from the stored digest without a second payment, and
   a rival purchase redeemed for the same unit is not counted as this one.
4. A repeated purchase request returns the same authorization, including
   after its window has closed.
5. Requests for passed lines, and for a line too early, are refused, and so
   is a second open performance ticket for the same wallet.
6. A disconnect without `finish` and a deliberate `finish` produce different
   statuses. A reconnect 20 seconds after a disconnect resumes, and no result
   is signed before the reconnect window closes.
7. An authorization whose verification is still running at the deadline is
   refused. A redemption confirmed after the deadline but before the closure
   is counted, and one attempted after the closure is refused by the contract.
8. Withholding a purchase for a weak line lowers `rewardScoreBps` as much as
   missing it, and grouping lines into segments leaves it unchanged.
9. A result whose line list omits, duplicates or invents a line is refused,
   and so is one with a zero denominator.
10. Admission is paid by one redemption, and a repeated request pays nothing
    more.
11. No numeric score for an unpaid line appears on the socket or in the result.
12. The operator crashes after allocating a nonce and before broadcasting,
    and the authorization then expires. Recovery rebroadcasts that
    transaction, it reverts and consumes the nonce, and the closure behind it
    executes.
13. The same, except someone else redeems the purchase first. The purchase is
    confirmed from the digest, and the operator's stale redemption still
    resolves its nonce.
14. Someone else redeems a purchase immediately before the closure, and the
    operator crashes before signing the result. The restarted operator
    reconciles at the closure block and counts that line.

## 11. Implementation state

What exists, all local and loopback only:

- `contracts/OperatorPayments.sol`, with nine Foundry tests in
  `test/solidity/OperatorPayments.t.sol`: single and batch redemption, the
  stored digest distinguishing a rival purchase for the same unit, refused
  signers and changed terms, the signed validity interval and its bound,
  ticket closure, revocation by withdrawal and signer rotation, a reverted
  transfer and non-canonical signatures.
- The community runs in its Worker on D1, with no Durable Object
  (`services/storage.ts`, `services/community.ts`,
  `services/community-purchases.ts`). It signs admission and segment purchases
  deterministically and keeps each atomic step to one record or one
  conditional statement, as section 7 describes.
- The operator verifies and redeems purchases (`services/purchases.ts`)
  through a durable sender that persists intents before any RPC call and
  tracks nonces separately from purchase status (`services/operator-tx.ts`).
  It closes each ticket at the deadline, reconciles at the closure block and
  signs the result (`services/karaoke.ts`, `services/karaoke-result.ts`). Its
  live karaoke session runs on a Durable Object, which section 1 allows.
- `harness/acceptance.ts` runs the full local flow on anvil: admission and
  every line paid through the contract, three performances, qualification and
  the reward pool. `test/operator-payments.test.ts` has twenty integration
  tests on anvil, covering the section 10 cases and regressions for an
  interrupted ticket write, purchase insert and settlement, an RPC failure
  before nonce allocation, a superseded socket closing, the reachability
  cutoff on disconnect, recovery reconciling reverted redemptions, and words
  and finish surviving an RPC outage.
  `test/payments-protocol.test.ts` covers the chain allowlist, the reward
  score, manifest rules and the verifier's list checks.

Two test gaps remain. Case 1 varies recipient, amount and token but not chain
or contract, which change the signing domain and so surface as a bad
signature. Case 8's grouping half is checked at the reward-score level, not
with a grouped manifest end to end.

Not yet built:

- the public grade-record contract that consumes the result;
- the community and operator services against MegaETH testnet. The contract
  itself is deployed there and passed a smoke purchase, redemption and closure
  ([MegaETH testnet deployment](megaeth-testnet.md)); `realtime_sendRawTransaction`
  is still unexercised;
- configurable sponsorship limits: the per-credential buckets of section 9.7
  and a community-wide per-period limit. Only the per-wallet allowance and the
  funds currently deposited bound spending;
- a plain SQLite store for self-hosting beside D1;
- the web client's P-256 socket handshake; the socket still uses the
  skeleton's session-key proof, as `docs/community-web-client.md` records.

Practice mode (section 5.5) is an optional proposal and is not built.
Transcription is simulated: the local operator receives recognized words in
`words` frames and scores them with the real scorer.
