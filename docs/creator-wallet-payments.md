# Creator wallet funding and wizard setup, version 2

Status: owner-confirmed first-song test scope, 2026-11-04. The operator covers
creator-wallet test fees from a finite budget. Creators see no payment screen.
Creator payments are deferred; no permanent commercial pricing model is selected.
This supersedes version 1's recommendation of creator upfront payment.

This contract extends [creator wallet version 4](creator-wallet.md), which owns
passkey custody, Ika verification and activation before upload. It defines the
service connection, sponsored test allowance and readiness. The wallet spike
has not implemented that complete service or the first-song flow.

## Who operates and who pays

The registration operator supplies native SUI and IKA, submits the creation
transactions and pays Aeneid registration gas. For this milestone those costs
come from an explicitly configured, capped operator test budget. Creators need
no native tokens, faucet, deposit, checkout or refund flow. Sui gas sponsorship
alone does not supply IKA; the service must hold both fee inventories.

Pirate's registration service is the default operator. A community pairs with
that service and uses a verified test allowance; it does not hold Pirate's
provider or treasury keys. An independent operator runs a compatible service
with its own dedicated signer, native inventory, finite limits and reconciliation.
A funded address alone is not a functioning registration service.

| Policy | First-song status | Creator experience |
| --- | --- | --- |
| `community_sponsored` | Required test policy, backed by the operator's capped allowance. The name scopes the grant to a community; it does not require community reimbursement to Pirate. | Wallet setup is covered; no payment screen. |
| `creator_upfront` | Deferred and unavailable in this milestone. | No checkout option is shown. |

The funding decision authorizes the test model, not an unlimited spend or an
invented balance. Missing or depleted allowance disables new creator setup.
It must never switch to charging a creator. Direct native creator self-payment
is also deferred. Do not assume a MOSS balance pays Sui/Ika fees or add a swap
or bridge. The first-song test does not depend on HNS delegation or app.tld.

## Wizard contract

This is a readiness check before creator releases, not before website
provisioning or ordinary sign-in. Use a short “Creator setup is covered” summary,
with no payment-policy questionnaire. Show treasury controls only for independent
operators.

1. Select Pirate's registration service by default, or an independent service.
   Show identity, supported testnets and capabilities. An unavailable service
   remains pending; selecting it does not make it ready.
2. Complete authenticated community pairing. Verify the exact return origin and
   pinned service manifest: wallet HTTPS origin/RP ID, protocol/package versions,
   network and operator address. Reuse the stable wallet site. A pasted URL or
   syntactically valid credential is not a verified service connection.
3. Bind `community_sponsored` to a verified operator test allowance and its
   covered actions. Configure finite per-action, account, community and global
   daily limits. Record native units and budget windows. Do not ask creators
   to connect a billing profile or require a checkout/refund adapter.
4. Independent operators additionally bind their service and dedicated signer
   references, spendable SUI/IKA, refill alerts and reconciliation. Verify the
   Aeneid registration adapter, signer and gas separately. Communities using
   Pirate's service never supply those treasury secrets.
5. Run a read-only preflight and show service identity, wallet origin, covered
   actions, limits and individual readiness. Release remains unavailable until
   the relevant checks pass. Reviewing settings does not transfer funds, create
   credentials or deploy a service.

Infisical remains the required service/operator-secret source. Use references
and runtime server bindings, never raw secrets in public manifests, browser
configuration or resumable wizard state. Creator passkey private keys and
plaintext Ika seeds never enter Infisical. Alchemy owns wizard provisioning;
cf remains diagnostic tooling. Ordinary HTTPS comes first, HNS is separate,
and Spaces is deferred. None of these choices changes the wallet RP ID.

Suggested copy is: “Pirate handles wallet setup. Test fees are covered within
the operator allowance shown here. You do not need SUI or IKA.” Independent
mode names its actual service. Do not present this copy as proof of readiness.

## Configuration and readiness

These are semantic requirements, not claims of implemented API fields.

| Configuration | Required meaning |
| --- | --- |
| Version and operator | Service mode/ID, endpoint and pinned manifest digest. |
| Origins and networks | Exact community return origin, wallet origin/RP ID, test networks and package identities. |
| Sponsorship | Fixed `community_sponsored` policy, version, covered actions and authenticated test allowance/grant ID. |
| Limits | Finite action, account, community and global native exposure with units and time windows. |
| Private bindings | Infisical references for backend authentication and independent signer configuration; never secret values. |

Record checked configuration digest, observation time, expiry and failure
reasons. Distinguish configured, connected, allowance ready, native funding
ready, activation ready and song-registration ready. The service verifies its
allowance and native inventory; a browser flag is not evidence. Recheck and
reserve exposure at execution because balances can change after preflight.

Changes to service, origins, network, policy or limits invalidate stale
readiness and unstarted authorizations. An already submitted attempt remains
bound to its original service and ledger until reconciled. A depleted or
unreachable service blocks new releases with a reason. Public reading and
ordinary participation remain available. An Active wallet alone does not prove
the registration adapter or first-song flow works.

## Sponsored execution and native funding

Verify and reuse an existing Active wallet before creating another. Confirm
ownership and community-link consent; knowing a public address is insufficient.
For a new wallet, save the PRF-wrapped seed durably before native-fee operations.
Missing PRF or failed persistence stops setup. Preserve the wallet contract's
DKG checks, atomic cap transfer, verified acceptance and confirmed-Active order.

Bind an authenticated spending authorization to the setup intent, community,
account, creator address, operator, network/package manifest, allowance,
covered action, native ceiling and expiry. This is an internal bounded grant,
not a creator checkout quote. Reserve it atomically before submitting an action.
Enforce the wallet contract's account limits and failed-attempt limits, plus
community and global budgets. No numeric budget has been chosen by this document;
finite configured limits and verified test inventory are required before spending.

Keep a durable attempt ledger with unique action/idempotency keys. Persist
transaction identity before broadcast, reconcile uncertain submissions before
retrying, and never pay for a second DKG because a callback or poll was lost.
Serialize or allocate fee coins so concurrent transactions cannot spend the
same object version. Record actual IKA, SUI and Aeneid costs separately, release
unused allowance and stop new work before depletion. A timeout stays pending
until reconciled. Failed setup creates no creator debt or payment request.

Activation, later signing and Aeneid registration have separate native costs.
The test grant must explicitly cover each needed action within its ceiling;
otherwise that action stays unavailable. A normal recipient mint may not need
an Ika signature; check the adapter instead of adding an unnecessary signing
step. Funding never grants custody of the creator cap or arbitrary signing
permission. Refills require an operator action; no automatic swap is promised.

## First-song acceptance

| ID | Required evidence |
| --- | --- |
| S1 | The default flow has no creator payment screen or provider/treasury-key intake; it verifies the service and test allowance. |
| S2 | Missing, depleted or expired allowance, missing limits or insufficient native inventory blocks new work without charging the creator. |
| S3 | PRF/persistence failure stops before spend; a verified existing wallet skips creation. |
| S4 | Wrong community, account, origin, action, manifest or allowance authorization is refused. Replays and concurrent requests cannot spend twice. |
| S5 | Unknown submissions remain pending and reconcile before retries; cancellations release only unspent exposure, with actual native costs recorded. |
| S6 | Service/configuration changes invalidate stale readiness without reassigning existing attempts. Ordinary participation remains available. |
| S7 | Setup, any required signing and registration each have bounded coverage; creator cap ownership and confirmed Active before upload remain required. |
| S8 | Real testnet service pairing, inventory and allowance evidence supports the first-song run on ordinary HTTPS without HNS. Fixtures cannot enable live readiness. |

S1–S8 are pending integration acceptance. The browser pilot demonstrated
activation, reopening and a same-address signature, not the complete service,
allowance enforcement or first-song registration. The remaining C1–C13 wallet
requirements still apply. The wizard, wallet and service lanes must hand back
actual evidence; a documentation merge cannot mark them passed.

## Deferred creator checkout

The following requirements apply only if creator-paid operation is selected in
a later product decision. They are not first-song gates and do not authorize
charging. No settlement asset, network, price or commercial default is selected.

### Creator flow and quote

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

### Retries, refunds and native funding

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

### Deferred billing acceptance

The real browser pilot activated a testnet wallet, reopened it and verified a
signature from the same creator address. It did not implement checkout,
refunds, commercial service pairing or song registration. Browser/provider
coverage and the remaining wallet acceptance cases still need evidence.
A settlement profile and real prices would be later implementation inputs,
not missing values that the first-song wizard must collect or invent.

| ID | Required evidence before enabling the affected capability |
| --- | --- |
| P1 | A future paid-service setup verifies the selected commercial policy and never asks communities for Pirate's SUI/IKA keys. Independent mode rejects missing signer, inventory or budgets. |
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

All P1–P12 are deferred and pending implementation acceptance. They do not block
the sponsored first-song test. S1–S8 above govern that milestone. A future payment
lane would own settlement adapters; the wallet lane owns Ika operations and
encrypted records. No runtime, funding or mainnet change is implied by merging
these documents.

Ika's [integration guide](https://docs.ika.xyz/docs/move-integration/getting-started)
describes native fee inputs. Sui's
[sponsorship documentation](https://docs.sui.io/develop/transaction-payment/sponsor-txn)
explains gas payment and sender/sponsor authorization. Gas sponsorship alone
does not supply IKA. The payment policy and wizard rules above are product
decisions layered on those mechanisms.
