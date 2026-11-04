# Creator wallet payments and wizard setup, version 1

Status: owner-selected design, 2026-11-04; billing and wizard integration are
not implemented by the wallet spike. This contract extends
[creator wallet version 3](creator-wallet.md). It owns the payer choice,
quotes, charging and readiness gates. That document continues to own passkey
custody, Ika verification and activation before upload. The current proof is
testnet-only; this document selects neither a production price nor a payment
asset, network or provider.

## Who operates and who pays

The registration operator sends the chain transactions and keeps SUI and IKA
available. The payer reimburses that operator through the selected billing
arrangement. These are separate choices. A creator paying the operator does
not remove the operator's need for native tokens.

Pirate's registration service is the recommended operator. A community using
it connects its service account and selects a payment policy; it does not run
a Sui treasury or supply Pirate's signing keys. Independent operation means
running a compatible registration service with a dedicated signer, SUI and
IKA inventory, finite spending limits and reconciliation. A funded address
alone is not a functioning registration service.

| Payment policy | Creator experience | Community setup |
| --- | --- | --- |
| `creator_upfront` | Pays one displayed activation quote through the operator's supported checkout; no SUI/IKA deposits. | Recommended, explicitly confirmed choice. Connect a working billing profile and review prices and refund terms. |
| `community_sponsored` | Sees “Wallet setup is covered by this community” and no activation charge. | Explicit opt-in. Connect a funded service allowance or a verified test grant and set finite limits. |

Direct native self-payment is deferred. Do not offer an enabled “fund your
Sui wallet” toggle in v1. It would require its own fee-coin, transaction-sender,
consent and recovery implementation. Do not assume a MOSS balance can pay Sui
or Ika fees, or silently bridge or swap it.

The default recommendation is not permission to charge. The community operator
confirms the policy during setup and the creator approves each priced action.
Community sponsorship must never be a silent fallback when checkout is absent.
The existing spike remains an explicitly funded test grant; it is not evidence
of an implemented paid service.

## Wizard contract

This is a required configuration step before enabling creator releases, not
before deploying a community website or enabling ordinary MOSS sign-in.
Use the label “Creator wallets and release fees”. Keep the everyday path
short; show treasury controls only for independent operators.

1. “Who handles wallet registration?” Select Pirate's service by default or
   an independent compatible service. Show its identity, supported testnets
   and capability status. An unavailable service cannot be selected as ready.
2. “Connect the registration service.” Complete authenticated community
   pairing. Verify the exact community return origin and the service manifest,
   including wallet HTTPS origin, RP ID, protocol/package versions, network
   and operator address. A pasted URL or syntactically valid credential does
   not establish a connection. Reuse the stable wallet site across communities.
3. “Who pays for creator wallets?” Explicitly confirm “Creators pay at setup”
   or “This community covers setup”. Explain that the registration service
   handles SUI and IKA in both cases. Show the approved price/refund policy,
   which actions it covers and whether later signing or registration costs
   extra. Do not display an invented zero price.
4. Connect a supported billing profile for creator payment, or a funded
   allowance/test grant for sponsorship. Configure finite per-action,
   community and daily limits. If the selected service has no implemented
   checkout/refund adapter, creator payment stays unavailable. If sponsorship
   has no verified allowance, it stays unavailable too.
5. Independent operators additionally connect their deployed service and
   dedicated signer references. Verify the expected Sui network, spendable
   SUI and IKA, fee budgets, refill alerts and transaction reconciliation.
   Aeneid registration also needs its own adapter, signer and gas readiness.
   A community using Pirate's service never supplies those treasury secrets.
6. Run a read-only preflight and display the operator, payer, supported
   settlement asset/network, price policy, limits, wallet origin and individual
   readiness results. “Enable creator releases” remains unavailable until the
   relevant checks pass. Reviewing a configuration does not itself transfer
   funds, provision credentials or deploy a service.

The owner-selected wizard requires Infisical for service/operator secrets.
Use references and runtime server bindings; never put a raw secret in a public
manifest, browser configuration or resumable wizard state. Creator passkey
private keys and plaintext Ika seeds never enter Infisical. Alchemy remains the
provisioning layer selected by the community wizard; this feature adds no
second deployment runner. Ordinary HTTPS setup comes first, optional HNS later;
Spaces remains deferred. None of those choices changes the wallet RP ID.

Suggested review copy for the default path is: “Pirate handles wallet setup.
Creators pay the displayed setup price. You do not need SUI or IKA.” For the
sponsored path use: “Pirate handles wallet setup. This community pays within
the allowance and limits shown here.” Independent mode names the actual
service instead of Pirate. Never present these statements as proof of readiness.

## Configuration and readiness

The deployment handoff needs the following fields or equivalent typed data.
This is a semantic contract, not a claim that these API fields already exist.

| Configuration | Required meaning |
| --- | --- |
| Version and operator | Configuration version, service mode/ID, endpoint and pinned manifest digest. |
| Origins and networks | Exact community return origin, wallet origin/RP ID, test networks and package identities. |
| Payer policy | Explicit `creator_upfront` or `community_sponsored`; policy version and covered actions. |
| Billing reference | Supported settlement profile or sponsorship allowance/grant ID; public terms version. |
| Limits | Finite action, account, community and global exposure limits with units and time windows. |
| Private bindings | Infisical references for backend authentication and independent signer configuration; never secret values. |

Readiness observations are separate from saved settings. Record the checked
configuration digest, observation time, expiry and reasons for failure.
Distinguish configured, connected, billing ready, native funding ready,
activation ready and song-registration ready. Only the authenticated service
can attest to its allowance and native inventory; a client-side flag is not
evidence. Recheck and reserve at execution because balances can change after
preflight. A global low balance must block new quotes before taking payment.

Changing operator, origins, network, payer or limits invalidates stale
preflight results and unpaid quotes. Already funded attempts remain bound to
their original service and terms until reconciled or refunded; changing a
setting never reassigns a receipt. A depleted or unreachable service disables
new releases with an actionable reason. Public reading, ordinary posts and
MOSS login remain available. Wallet activation alone does not make the
registration adapter or first-song publication ready.

## Creator flow and quote

On “Release a song”, first verify and reuse an existing Active wallet. Do not
sell a second activation for another song, a lost return callback or an
explicitly linked existing wallet from another community. Verify ownership
and linking consent; public knowledge of an address is not sufficient.

For a new wallet, create the passkey and durably save its PRF-wrapped seed
before asking for payment. Missing PRF or failed persistence stops before
charging. Then obtain an authenticated operator quote for the named action.
The checkout presents one total in one supported settlement asset, its network,
expiry, coverage and refund terms. The browser need not manage native fee coins.

The immutable quote binds its ID/version, action, attempt, authenticated
community/account, creator Sui address, operator, network/package manifest,
payer policy, billing profile and configuration digest. It includes the exact
recipient, asset/network, integer amount and decimals, total, cost breakdown,
maximum native exposure, expiry and refund-policy version. The operator
authenticates these terms; the browser cannot select an arbitrary recipient
or change the price. No conversion from a testnet faucet balance establishes
a production price. Disclose any separate checkout-network fee before consent.
If native cost is refundable in the settlement asset, bind the conversion rule
and rate to the quote rather than repricing after failure.

Reserve finite operator exposure and verify the service can fulfill the action
before presenting a payable quote. In creator-paid mode, verify a confirmed
payment using the approved settlement adapter. In sponsored mode, reserve the
community's verified allowance instead. Bind the quote and payment/allowance
authorization to the existing setup intent and creator consent before any
paid Ika stage. Preserve the saved-record, DKG, atomic cap transfer, verification
and confirmed-Active ordering in the wallet contract.
Unpaid reservations have bounded expiry and issuance limits; they cannot lock
the treasury indefinitely. Resolve a payment race before releasing or reusing
the reservation.

Payment verification happens on the backend against the quoted recipient,
amount, asset, network, finality and unique receipt. A screenshot, browser
“paid” flag, callback alone or unrelated transaction is insufficient. The
existing per-line OperatorPayments service is not automatically a creator
activation checkout. Reusing it requires an explicitly reviewed service/action
mapping and settlement/refund adapter in its owning lane. This specification
does not add or authorize a new payment contract.

An unpaid expired quote requires a new quote and fresh approval. Once payment
is accepted, the operator honors the authorized ceiling for that attempt or
reconciles and refunds it; it cannot change the price or charge again because
the quote expired during execution. A valid payment confirmed within the quoted
deadline remains valid when its callback arrives later. Payments confirmed
after that deadline or with incorrect terms are quarantined
for reconciliation/refund and never silently consumed by a replacement quote.

## Retries, refunds and native funding

Link the financial ledger to the durable setup attempt. Track quote, payment
confirmation or allowance reservation, submitted operations, actual costs,
settlement and any refund separately from the wallet's chain state. Enforce
unique receipt consumption and action/attempt idempotency atomically. Repeat
requests return the original attempt. Persist transaction identity before
broadcast; reconcile unknown submissions before spending again or refunding.

If cancelled before any chain operation incurs cost, refund the full payment
or release the allowance. After an irreversible operation, retain only actual
cost explicitly allowed by the accepted quote, within its disclosed ceiling;
refund the remainder. Charge a service success fee only on successful delivery
of the quoted action. State the maximum potentially nonrefundable network cost
before checkout. Refund processing must be supported and verified before paid
mode can be enabled; do not invent a later manual-refund promise. Refund gas
cannot become an additional unquoted creator charge. Return refunds in the
quoted settlement asset to the authenticated original payer under the adapter's
rules; never accept an arbitrary replacement refund address from a callback.

A timeout means pending reconciliation, not failed or refunded. Show refund
pending until its actual receipt is confirmed. A fresh paid attempt requires
new consent after resolving the earlier one. Reopening, polling, a repeated
callback and retrying the same valid acceptance never produce a second charge.
Activated wallets remain recorded even when returning to the community fails.
An activation quote pays for the wallet, not a guarantee that a song will pass
admission or be registered; say so before checkout.

Both modes still require the registration operator's SUI and IKA inventory.
Budget IKA protocol fees, SUI protocol charges and Sui gas separately. Reserve
per-attempt exposure and enforce the wallet contract's account limits plus
community and global budgets. Serialize or allocate gas/fee coins so concurrent
transactions cannot spend the same object version. Reconcile actual costs,
monitor remaining funds and stop accepting new work before depletion. Treasury
refills are an operator action; v1 does not promise automatic swaps or bridges.

Activation is a one-time action for a reused wallet. Later owner-authorized
signatures require a separate bounded quote or explicit sponsorship entitlement
covering presign, signing and Sui gas as applicable. Registration has its own
declared price or allowance. A normal operator mint to a creator recipient may
need no Ika signature; verify the adapter instead of adding a signing charge
to every song. Paying or sponsoring never grants the operator custody of the
creator's cap or permission to sign arbitrary messages.

## Acceptance and implementation boundary

The real browser pilot activated a testnet wallet, reopened it and verified a
signature from the same creator address. It did not implement checkout,
refunds, commercial service pairing or song registration. Browser/provider
coverage and the remaining wallet acceptance cases still need evidence.
The selected settlement profile and real prices remain implementation inputs,
not missing values that the wizard may replace with a mock success.

| ID | Required evidence before enabling the affected capability |
| --- | --- |
| P1 | Default-service setup asks for a service connection and payer policy, never the service's SUI/IKA keys. Independent mode rejects missing signer, inventory or budgets. |
| P2 | Missing checkout/refund support disables creator-paid mode; missing allowance disables sponsorship. Neither silently becomes a free service. |
| P3 | PRF or encrypted-record persistence failure occurs before charging. A verified existing wallet skips activation payment. |
| P4 | Changed recipient, amount, asset, network, account or quote is rejected. Replayed receipts and concurrent requests cannot create two charges or DKG attempts. |
| P5 | Unpaid expiry requires fresh approval; accepted payment preserves its ceiling through execution. Late receipts reconcile without attaching to another quote. |
| P6 | Cancellation before spend refunds fully. Partial failure accounts for only disclosed actual cost and confirms the remaining refund. |
| P7 | Unknown chain/payment/refund status remains pending until reconciled; no duplicate charge, creation, registration or false refund success. |
| P8 | Lost return callbacks, wallet reopening and subsequent releases reuse the verified wallet without another activation charge. |
| P9 | Config changes invalidate stale readiness and unpaid quotes while preserving funded attempts. Native balance and allowance depletion reject new payment intake. |
| P10 | Public reading and ordinary MOSS activity work while creator releases are unavailable; an Active wallet alone does not mark registration ready. |
| P11 | Later signing/registration shows its own cost or entitlement. Payment cannot authorize arbitrary signing, custody transfer or mainnet execution. |
| P12 | Readiness is demonstrated against the configured service and adapter, with bounded test receipts and refunds; fixtures are visibly separate and cannot enable a live capability. |

All P1–P12 are pending implementation acceptance. The wizard lane consumes this
contract; the payment lane owns settlement adapters; the wallet lane owns Ika
operations and encrypted records. No runtime or mainnet change is implied by
merging these documents.

Ika's [integration guide](https://docs.ika.xyz/docs/move-integration/getting-started)
describes native fee inputs. Sui's
[sponsorship documentation](https://docs.sui.io/develop/transaction-payment/sponsor-txn)
explains gas payment and sender/sponsor authorization. Gas sponsorship alone
does not supply IKA. The payment policy and wizard rules above are product
decisions layered on those mechanisms.
