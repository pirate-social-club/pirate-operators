# Wallet and rewards interface v1

Lane 2, source base 67cbe118ade39790bc1539999ca75d0d7ff10b6d.
Source/local testing only; no runtime activation is authorized here.
Revision 2 adds the implemented transport, quoted native gas cap and guarded cancellation.

`LiveRewardWallet` in `apps/web/src/live/rewards.tsx` remains mountable with
`csrf`, `onExit`, optional `data`, and optional legacy `send(view)` props.
The shell owns routing and mounts it at `/wallet` and `/verify/very` with the
same authenticated session and CSRF token. Claim return URLs stay same-origin
and retain the exact credit ID. No global CSS or shell entry is owned here.

The wallet distinguishes spendable on-chain balance from recorded winnings.
Recorded winnings include paid credits; pending rewards are only their unpaid
amounts. They are never added to the balance. Unsettled drawings have no
promised amount. Unclaimed credits need a palm scan, subject conflicts need
support, accepted credits await payment, and confirmed payments are complete.
Amounts use integer atomic units throughout, including sub-cent rewards.

Receive exposes only the authenticated wallet address, MegaETH testnet 6343,
the exact USDm contract and a plain-address QR code. It grants no permission
and creates no deposit, bridge, conversion or funding transaction.

## Send and lane 7

The existing default remains explicit MOSS approval on testnet, now opening
its token-specific Send screen. The hosted screen owns its Max calculation.
`mega.send` has no fee quote or programmable Max parameter in pinned SDK
1.0.8. The app must never present a guessed balance-minus-fee as exact Max.
The hosted Send control is an explicit navigation handoff, not an app-prepared
transfer: it supplies a token, but no recipient, amount or guard. In-flight
openings are coordinated, and no wallet operation is retried automatically.
After a visit ends, another deliberate visit remains available. An SDK response
does not confirm a payment. Unknown results direct the learner to MOSS history;
they do not permanently disable the navigation control. Actual guarded
payments retain their durable intents, immutable retries, nonce cancellation
and canonical reconciliation.

Receive binds its address, copy action and QR to one immutable wallet identity.
Changing account, network or token remounts the Receive view and discards late
QR work. A changed wallet identity closes wallet sheets and clears pending claim
context before reloading the account session and its CSRF-bound data.

`apps/web/src/wallet/contracts.ts` defines `WalletSendAdapterV1` for lane 7:
an immutable quote binds chain, sender, recipient, token, decimals, amount,
fee token/reserve, quoted balance, expiry and a durable intent ID. Its
`prepare`, `begin`, `outcome`, `cancel` and `reconcile` operations are idempotent
for that intent. `begin` durably records either `pay` or `cancel` before an
explicit wallet call. `quote` supports either an exact atomic amount or `max`; the returned
amount is what the recipient receives, separately from the reserved fee.
Lane 2 owns review/Max/retry UI; lane 7 supplies chain/provider facts and
exactly-once execution/reconciliation. Production chain IDs are refused by
this version. Unknown/submitted intents cannot be replaced by a new intent.
`maxGasAllowanceWei` is mandatory on a quote, must be positive uint256 and is
forwarded unchanged to MOSS. It is distinct from the quoted token fee reserve.
The provider must bind the conversion and reserve to this native gas cap.
Only never-dispatched intents can cancel without a wallet call. After dispatch,
cancellation signs only the same frozen nonce; canonical proof determines
whether the original payment or cancellation won the race.

`walletSendData(csrf)` in `rewards-data.ts` implements the HTTP port. The shell
may pass it as `sendAdapter` only after the coordinator/lane 7 mounts its
authenticated guarded learner Send capability. Propose capability
`guardedLearnerSend: "pirate.wallet-send-adapter/1" | null`, default null;
this lane does not edit the shared capabilities type or mount.

The version 1 routes are GET `/api/rewards/sends/current`, POST
`/api/rewards/send-quotes` with `{recipient, amountAtomic}` (including `max`),
POST `/api/rewards/sends` with `{quoteId}`, and POST
`/api/rewards/sends/:id/{dispatch,outcome,reconcile,cancel}`. Prepare uses
the quote ID as idempotency key; dispatch/outcome retain the attempt ID.
The server derives sender, chain and currency from the host-only account
session and community configuration, enforces Origin/CSRF, authenticates every
read/retry, expires quotes at prepare, refuses overlapping intents, and never
accepts a client balance as reserve evidence. These learner routes cannot
reuse operator-only payout authorization. No new HTTP route is mounted here.

Until that backend is integrated, hosted Send remains usable, its conservative
Max behavior remains a provider limit, and unresolved hosted sends remain held
in this browser with MOSS history access. There is deliberately no timeout or
user checkbox that clears an uncertain transfer. Cross-device recovery and a
canonical hosted-receipt recovery path remain lane 7 integration acceptance.

## Close entries and coordinator integration

`RewardOperatorView` gains optional `closeReadiness`, schema
`pirate.reward-close-readiness/1`, keyed by offer ID. Each row contains
`cutoffAt`, `state` (`before_cutoff`, `awaiting_confirmation`, `ready`,
`unavailable`), and optional confirmed-head timestamp. The coordinator adds
this to `/api/operator/rewards` using the same safe block rule as
`services/reward-sources.ts:rewardCutoffBlock`: wall time reaches cutoff AND
the safe head timestamp in milliseconds is >= cutoff. No client clock can
unlock closing. Missing/failed status disables Close entries, with a reason
and Refresh action. Existing server close checks remain authoritative.
The feature refreshes status while an offer is waiting; no close is automatic.

The coordinator applies `.local/integration.patch`; it changes only the shared
operator API read. No contract, schema migration, dependency or release pin
change is proposed. All source result pins must remain intact.

## Max investigation and evidence limits

The parent task's retained 2026-11-10 receipt reports 0.03 test USDm before
Send, 0.0056748 to the recipient, 0.0243252 held as a fee reserve, 0.0011206
fee and 0.0232046 refunded. The release client only called `mega.open()`;
it contained no amount/Max calculation. Thus that observation attributes
the conservative reserve to the hosted MOSS path, not app arithmetic. It
does not prove a different fee allowance will succeed on another send.

A fresh keyless RPC read at 19:00–19:02 UTC on November 10 independently
observed that retained successful transaction on chain 6343, checked its block
hash against the canonical block and safe-head bound, confirmed 18 token
decimals and zero learner ETH at the receipt block. Exact Transfer amounts:
reserve `24325200000000016`, recipient `5674799999999984`, fee
`1120649801400000`, refund `23204550198600016`. Reserve plus recipient is
`30000000000000000`; fee plus refund is exactly the reserve. The private
`.local/evidence/retained-send-*.json` files retain those single-RPC observations.
This is a read of the accepted transfer, not a new Send or a new wallet approval.
Follow-up reads also found zero learner ETH in the preceding block, a USDm
balance of `30000000000000000` before, and `23204550198600016` afterward.

Official sources checked 2026-11-10:
[MOSS gas](https://moss.megaeth.com/developers/concepts/gas) describes automatic
USDm gas selection and a maximum allowance.
[SDK API](https://moss.megaeth.com/developers/packages/wallet-sdk) documents
token-specific hosted Send and transfer calls without a quote API.
[Contract calls](https://moss.megaeth.com/developers/methods/calling-contracts/call-contract)
documents `maxGasAllowance` in wei; its approximately $0.03 default is a cap,
not an exact cost. Lowering that cap without a provider quote is not an app fix.

Actual zero-ETH small/Max Send, readable actual approvals, plain-transfer
capture, and real device/palm evidence remain coordinator acceptance. Capture
the next genuine plain Send; do not initiate a redundant transfer for evidence.

## Local checks and integration

Run from the task root: `node --test apps/web/test/reward-wallet*.test.ts
test/v1-wallet*.test.ts`. From `apps/web`, build the explicit simulated fixture
with `./node_modules/.bin/vite build --config test/reward-wallet.vite.config.ts`,
then run `./node_modules/.bin/playwright test --config
test/reward-wallet.playwright.config.ts`. Fixture HTML, fake wallet peer and
fake API/adapter source are all preserved under `apps/web/test/*wallet*`;
outputs and browsers stay under `.local`. Nothing imports these fixtures into
the live app build. Fixtures cannot establish provider or financial acceptance.

The coordinator first preserves the exact changed paths and applies the shared
operator API patch after the pure close-readiness helper is available. Re-run
API tests, root and web checks on the integrated source, plus the separate Study
and Karaoke workflows. Keep the runtime release hold, independent exact-diff
review and fresh release preflight. No migration or contract change is needed.

The lane's final local gates passed: 21 focused wallet/cutoff tests, 69 web
unit tests, seven explicit browser fixtures, 17 existing reward API/recovery
safety tests, 219 offline Solidity tests, root/web typechecks, and acceptance
at `local-skeleton/1`. The existing four reward browser cases passed across
two runs: three on the first run and the learner claim case on a 60-second
retry after a page-load/teardown timeout.

The full `npm run check` results are not green. The root suite was interrupted
with exit 143 after multiple deployment/learning failures and a prolonged
stall under host load; these are recorded observations in unchanged source,
not a proven baseline diagnosis. The web check passed typecheck, unit tests,
both builds, 22 static browser cases and 35/38 live cases. Two live cases tried
writing screenshots to read-only `/tmp`; the Study download case returned
`download.path: canceled`, including a focused retry with local downloads.
The coordinator/lane owners must resolve or reproduce these against the
integrated source. Separate Study/Karaoke workflow gates and exact-source
independent review remain required before publication. Private logs preserve
initial browser setup failures and every unsuccessful check.
