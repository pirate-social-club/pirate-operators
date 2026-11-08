# Daily manual reward pilot

The workspace_owner directed implementation on November7 after reviewing the
learner claim, treasury and MOSS wallet flow. This specification supersedes the
earlier weekly payment schedule and the RewardPool-address/drawing scope for
this separate ledger. It does not activate funded rewards or mainnet.

The application and API belong to pirate-operators. Private account IDs and the
authenticated MOSS credential identify a learner. A real on-chain USDm balance
appears at the top of the wallet; unsettled drawings, unclaimed credits and
accepted but unpaid credits are separate. Creator royalty accounts, other
chains and Privy are outside this pilot. The presentation reference is
pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db, especially
src/features/rewards/winnings-model.ts and wallet-winnings.tsx. Adopted state
semantics are independently owned; no central runtime or session is imported.

The shared types live in packages/rewards/contracts.ts. All monetary amounts
are exact unsigned atomic-unit decimal strings. Program configuration freezes
the payout token, precision, operator, dedicated payout wallet and ticket wallet.
Only MegaETH testnet6343 is a destination. Base Sepolia84532 is an external
provider source. Configurations and receipt evidence have immutable hashes.

An offer binds a drawing, stable song identity, actual purchase and unique
ticket IDs before its cutoff. The trusted public-results adapter selects the
approved accounts that qualified under frozen activity policies before that
cutoff. Closing the offer freezes those entries. Provider settlement and actual
USDC collection are required before crediting wins; a zero prize is explicit.
Repeated activities collapse into one entry per account/offer. Exact split
arithmetic preserves the remainder in the ticket wallet. No-qualifier winnings
stay there. Unclaimed and subject-conflict credits remain owed without expiry.
Eligibility scans only publication blocks within that offer's advertised time
window, anchored to a confirmed cutoff block. Its bounded scan does not grow
with the age of the program. The trusted starting block must precede the offer.

Claim uses the existing status model: unclaimed -> verification_missing ->
Very -> accepted, or subject_conflict with the amount held. A verification
intent belongs to the authenticated account and captured wallet, has a fresh
128-bit challenge and finite expiry, and is consumed atomically. The program
scope is keccak256(abi.encode("pirate-manual-rewards-scope/2", programId, 6343)).
The numeric external nullifier is the low160 bits of
keccak256(abi.encode("pirate-very-external-nullifier/2", scope)), encoded as
canonical decimal text. It contains no pool, drawing, account or challenge.
The persisted subject hash uses domain pirate-manual-rewards-subject/2, scope
and the cryptographically verified provider subject. One subject binds one
account, and one account binds one subject. The provider's real enrollment
deduplication and new scope acceptance still require live human qualification.

Treasury records distinguish Base winnings, conversion input/fees, confirmed
USDm inventory and learner liabilities. Pending conversion is not spendable
inventory. Testnet prefunding and simulated wins have explicit evidence modes;
neither proves a Base-to-MegaETH conversion route. No automatic bridge, swap,
reserve refill, signing key or spending permission is introduced.

The November7 fee answer selects the simple pilot policy: preserve the nominal
settled dollar winnings and have the operator cover conversion costs. Input
USDC, fees and the Base source hash are operator declarations. The destination
USDm event is independently checked; the source declaration does not establish
a working bridge. Conversion fees never reduce an existing learner credit.
Operator amount fields accept ordinary decimal dollars and reject rounding.

Daily payment preparation combines ready credits for one learner and freezes
the sender, recipient, token, chain and total. Each included credit is locked
atomically. The operator reviews the actual MOSS approval and signs manually.
Each logical payment freezes a separate namespaced account nonce. Its strict
ERC-7821 self-call batch invalidates that nonce and then performs the exact
transfer. The low64 sequence begins at zero. Repeating the batch reverts before
paying; a reverted token transfer also rolls back the invalidation. This is
independent of the outer MOSS wallet intent's nonce and expiry. No new payment
contract holds the float.

The page records a unique attempt and action before each wallet call. It keeps
approved, cancelled, error and unknown responses distinct. A wallet response
never releases a reservation or establishes financial finality. An operator
may explicitly retry the same guarded payment after any uncertain response.
To cancel after dispatch, the operator signs a batch containing only the same
nonce invalidation. Payment and cancellation compete for this one guard; only
one succeeds. A losing submission can still incur gas; every retry remains
explicit. A decline, timeout, absent transfer or elapsed audit window is
never sufficient to unlock a payment. Before its first dispatch, an ordinary
prepared payment can still be cancelled without a wallet call.

Read-only reconciliation checks the actual account delegation, proxy runtime
and per-account implementation against qualified testnet pins. It reads the
payment's nonce at a safe block. If consumed, bounded historical nonce reads
locate the exact invalidation block, and a unique canonical NonceInvalidated
log identifies the transaction even when every wallet callback was lost. The
same successful receipt must contain the exact token Transfer to the learner
before any credit is marked paid. An invalidated guard with no transfer to that
learner closes the payment and releases its unpaid credit locks. Ambiguous,
wrong-amount, changed-account, unavailable-history and reorg evidence stays
held. Every outgoing transfer still goes through the separate treasury audit.
One exact transfer may pay several credits; no event may pay a second payment.

The pinned proxy and implementation runtime captured on November8 execute in
an offline Anvil test, including duplicate payment, both cancellation race
orders, token failure rollback and unauthorized invalidation. The encoder is
checked independently against the ABI. See test/fixtures/moss-6343-guard for
provenance. This establishes the account execution mechanism, not a completed
MOSS iframe/relay ceremony. The dedicated account must already be activated
on this qualified implementation. A proxy or implementation upgrade fails
closed and requires a new reviewed qualification. Actual wallet approval of
the nested account call and the real token's transfer behavior remain live
acceptance gates. Neither support assurances nor an audit-only unlock are
required for the guard's at-most-once property.

Awaiting payment precedes dispatch; Sending follows an approved wallet result;
an uncertain response returns to Awaiting payment until reconciliation proves
payment or cancellation. Paid follows confirmed transfer evidence.

The payout account has at most one unresolved payment. A bounded canonical
outgoing-event audit stops new preparation if any transfer lacks a confirmed
payment or explicit operator cost record. Cost classification rechecks the
exact event, cannot consume an active payment, and debits available inventory
once. Recorded inventory, reserved money, paid money, costs and observed wallet
balance are separate values. Keep only the small daily payout float in this
dedicated account. Cron reconciles account guards, including lost hashes, and audits outgoing events;
it never submits transfers, buys tickets, collects prizes or converts funds.

Learner Send opens the standard hosted MOSS wallet, explicitly configured for
testnet and the same authenticated address. Neither learner nor operator
wallet is asked for standing USDm spending permissions. Test real small USDm
balances with no ETH, maximum fee allowances, a full-balance attempt and onward
receipt. The external account website is not assumed to select testnet. A
separate capped gas sponsor remains a fallback, not current authority. The
payout account also needs a qualified fee choice: holding ETH does not force
MOSS to select it. Until an actual receipt establishes fee behavior, an extra
USDm outflow remains unmatched and stops the next payment. The operator may
record a verified fee as a cost only against spare inventory; no fee is silently
deducted from a learner credit or automatically classified by amount.

The local release must cover actual D1 transactions and handlers, account/CSRF
boundaries, receipt replay, precision, racing preparation, verification replay,
subject conflicts, unknown dispatch and aggregate-payment conservation. Real
Very, Megapot drawing liveness, dedicated-account payment and onward spending
remain separate live acceptance gates. Nothing here claims they have passed.

The release runner accepts an explicit public rewards selection through
`--rewards-profile`, alongside `--study-profile`. The selection contains schema
`pirate.rewards-release-selection/1`, `profile` matching RewardsProfile and
`source` matching RewardResultSource. Its immutable result-source hash, current
Study contract/code hash, dedicated operator/payout account and testnet-only
mode are checked. The rewards successor gate preserves the Study configuration
and appends only migration11. A Study-only package excludes migration11 and
does not enable rewards. Existing release profile review, predecessor binding,
resource custody and execution gates still apply. No plan was applied here.

The actual public payout and Base ticket addresses, USDm token/precision, Very
app identity and current reviewed predecessor are required to produce the live
selection. No placeholder selection is eligible for execution. The operator
must first approve known learner accounts, buy tickets manually, attach each
ticket to its song before the advertised window opens, and publish the rules.
After cutoff, close freezes independently validated public results. Once the
drawing ends, record its actual prize-collection receipt or confirmed zero
prize. Then record confirmed reserve funding, process ready claims and approve
each exact payout in the wallet. Approvals, closing and settlement are manual
operator actions in this MVP, not a fully automated daily lottery service.

Before funded acceptance, independently review the ledger and release change;
complete the separately owned Study lesson/retry/recovery acceptance; qualify
the real Megapot drawing and collection adapters; complete the real Very
ceremony and duplicate-subject tests; execute the qualified guarded payment,
retry and on-chain cancellation through the actual MOSS wallet;
and record one exact dedicated-account payout plus a small-balance onward
Send/full-balance attempt. Where Sepolia drawing liveness or conversion is
unavailable, explicitly simulated wins and a prefunded testnet reserve remain
the rehearsal mode. They cannot close real-provider acceptance.


An optional immutable profile.rehearsal selection declares one offerId and an
exact prizeUsdcAtomic for a hosted testnet rehearsal. The program remains in
live-testnet mode. That one offer derives visibly synthetic purchase/ticket
references; every other offer still uses the actual Megapot purchase and
settlement adapters. Evidence mode is stored with the offer's purchase and must
match settlement. Synthetic ticket IDs have their own namespace. The configured
prize and refs cannot be edited through the operator form or collection endpoint.
This avoids a program-wide simulation mode that could never be changed under
the existing immutable profile rules.

The operator attaches that rehearsal before its window opens, allowing enough
time for a real qualifying public Study or Karaoke result. Approval, account
mapping, public result validation and the real Very claim remain unchanged.
Only the external ticket purchase and drawing prize are simulated. The offer
is one-shot: its first attachment freezes its song and window; closing with no
qualifiers or missing that window cannot be reset to manufacture a result.
The planned first rehearsal declares 30000 USDC atomic units, or three cents
total before any split. This bounds credits only. Actual prefunding must also
cover fees, and nominal credits are never reduced for gas. Fractional shares
remain exact. Real and rehearsal credits retain their per-offer provenance if
one payment covers both. A rehearsal transfer proves a testnet payment, not
real Megapot prize collection or a working conversion route.

Owner ruling, November 8: a dedicated small-float payout account may approve
raw-calldata guarded self-calls on testnet 6343. Before the first testnet payout,
capture the real MOSS approval once for a few-cent guarded payment and once for
a plain USDm transfer, recording what each shows. Raw calldata is acceptable
for that testnet exception. Mainnet remains held; before any mainnet payout,
approval must show token, recipient and amount and exclude key/permission
changes. A flat capped pay-once contract is a possible future design, not a
selected or deployed contract. The later owner instruction allows convenient
existing testnet identities and keys; it changes neither mainnet scope nor the
need to observe actual Palm, microphone and MOSS behavior.
