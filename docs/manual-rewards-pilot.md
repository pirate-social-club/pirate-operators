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
The page records dispatch intent before requesting the signature, then attaches
the returned transaction hash. Receipt reconciliation validates the canonical
transaction, sender, token Transfer event, recipient, amount and unique log.
One exact transfer may pay several credits; the per-credit amounts remain
visible. No hash or event may pay a second payment. Unknown broadcasts remain
held. A prepared payment can be cancelled before dispatch. After dispatch this
implementation deliberately offers no unlock based on a timeout or absent RPC
result. MOSS relays use wallet intents; an EOA nonce check alone cannot prove
an intent cannot later execute. Qualifying cancellation or expiry of those
intents, including a declined wallet approval, remains a live recovery gate.
A recovered hash is verified before attachment. Awaiting payment precedes dispatch; Sending follows
dispatch; paid follows confirmed transfer evidence.

The payout account has at most one unresolved payment. A bounded canonical
outgoing-event audit stops new preparation if any transfer lacks a confirmed
payment or explicit operator cost record. Cost classification rechecks the
exact event, cannot consume an active payment, and debits available inventory
once. Recorded inventory, reserved money, paid money, costs and observed wallet
balance are separate values. Keep only the small daily payout float in this
dedicated account. Cron reconciles known hashes and audits outgoing events;
it never submits transfers, buys tickets, collects prizes or converts funds.

Learner Send opens the standard hosted MOSS wallet, explicitly configured for
testnet and the same authenticated address. Neither learner nor operator
wallet is asked for standing USDm spending permissions. Test real small USDm
balances with no ETH, maximum fee allowances, a full-balance attempt and onward
receipt. The external account website is not assumed to select testnet. A
separate capped gas sponsor remains a fallback, not current authority.

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
ceremony and duplicate-subject tests; resolve MOSS post-dispatch cancellation;
and record one exact dedicated-account payout plus a small-balance onward
Send/full-balance attempt. Where Sepolia drawing liveness or conversion is
unavailable, explicitly simulated wins and a prefunded testnet reserve remain
the rehearsal mode. They cannot close real-provider acceptance.
