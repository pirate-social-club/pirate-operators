# Creator sponsorship and publishing eligibility

Owner direction, 2026-11-05. This document clarifies the production direction
and later multi-creator policy. It does not implement a sponsor, select a vendor,
deploy a budget contract or widen the current owner-only publishing allowance.
The [owner-curated first song](owner-curated-first-song.md) and the existing
[funding contract](creator-wallet-payments.md) retain their bounded test scope.

## Funding and service operation

Pirate operates the default creator setup and registration service. A community
may fund eligible creators through that service without operating a Sui gas
station, deploying its own contract or supplying a treasury private key.
Selecting another compatible provider or self-hosting is an advanced option.
The community funding experience and settlement rail are not implemented or
selected here. The MVP uses the existing capped Pirate test allowance, with the
workspace_owner as the sole song publisher across the initial communities.

The later setup interface should select the service, record the community's
eligibility policy and finite budget, and show the funding action, balance,
usage and depletion state. If activity is selected, it records the qualifying
activity types and thresholds explicitly. Do not display these settings as
available until the service actually enforces them. No community treasury key
is collected by this interface.

Keep four responsibilities separate: the creator controls the wallet, the
community determines eligibility, the funder authorizes a bounded expense, and
the service executes it. One entity can perform several roles without merging
their authority. Paying for a wallet never grants control of its cap or user
share. Verify and reuse an existing Active wallet across linked communities;
joining another community or publishing another song does not require a new one.

## Production signing and gas sponsorship

Use native Sui sponsored transactions through a replaceable managed gas service
or a dedicated gas service with a protected signing system. Do not export raw
production treasury private keys into application Workers, Infisical or wizard
state. Infisical remains the source for scoped API credentials, service
authentication and signer references. This does not forbid its existing
non-treasury service secrets or require changing the disposable testnet spike.

The spike already uses native sponsorship; its Worker-loaded test key is one
signer implementation, not the required production custody model. A managed
provider signs using its own infrastructure. A protected signer can provide
signatures without exposing its private key to the application. Online signing
authority still exists in both cases. Neither an API key nor a KMS permission
is harmless merely because it is not an exportable wallet key.

Enforce permitted operations, destinations, fee ceilings, aggregate spending
limits and revocation outside the requesting community Worker. Verify which
restrictions the caller can change. A per-request allowlist or a counter on the
same compromised server is not an independently enforced treasury boundary.
A compromised authorized caller can consume the permitted allowance. Key
isolation reduces extraction risk; it does not prove transaction intent is safe.

Enoki's [sponsorship interface](https://docs.enoki.mystenlabs.com/ts-sdk/examples)
and Mysten's [gas-pool signer options](https://github.com/MystenLabs/sui-gas-pool)
are integration candidates, not selected providers. Qualify the actual native
passkey/Ika transactions, restrictions, prices, terms, failure handling and
provider replacement before selecting one. Do not assume caller-supplied
allowlists are immutable provider policy. Self-hosting with a protected signer
is optional; communities using the default service do not each run that stack.

## Separate fee sources and custody

| Expense | Required funding source |
| --- | --- |
| Sui execution and storage gas | The selected gas sponsor. |
| Ika protocol inputs in IKA and SUI | A separately authorized fee source available to the Ika call. |
| DATA/Story registration and other destination-chain gas | The selected chain adapter's separately funded payer. |

Ordinary Sui gas sponsorship does not automatically supply Ika's payment inputs
or destination-chain gas. Do not assume a provider permits spending its gas
coin inside the transaction. Such permission would widen its spending exposure
and must be explicitly supported and bounded.

A small prepaid service balance is an optional funding model, not the selected
commercial default. Its custody belongs to the service; many small community
balances can add up to a large service treasury. An offline reserve and a small
working float limit online funds but require authorized replenishment. The
spike's single funded test account does not implement community deposits or a
commercial ledger.

A community-controlled Sui budget contract is a later option for Ika fee inputs.
Ika documents [contract balance payment](https://docs.ika.xyz/docs/move-integration/core-concepts/payment-handling).
Our authorization, limits, withdrawals and accounting would be new work. Use
restricted operation calls with unused funds returned; unrestricted withdrawal
of fee coins would defeat the restriction. A gas service still pays the enclosing
transaction's gas. Contracts do not remove that signer.

Do not claim a compromised caller can lose only the gas float: it can also
consume any permitted fee budget. A fixed service charge or reimbursement is
another withdrawal path and needs its own bound and authorization. Successful
execution on Sui alone does not prove a registration succeeded on another chain.
Cross-chain settlement, automatic SUI-to-IKA swaps and a single deposit covering
all chains are unimplemented proposals, not properties of the current design.

## Community eligibility

The MVP admits only the workspace_owner's authorized publishing account/wallet.
Later communities choose their song-posting and sponsorship rules. Supported
policy directions are community creator only, a configured threshold of verified
Study/Karaoke/dance activity, or optional Very personhood evidence. Rules may
grant eligibility automatically; manual approval is not inherently required.
No threshold, universal Palm requirement or implementation is selected here.

This later clarification supersedes earlier blanket Palm-before-song-posting
guidance for future multi-creator eligibility. It does not change independent
community-membership, reward accrual or cash-out verification rules. Existing
first-song and controlled second-community grants are not widened by this text.

Evaluate rules on trusted evidence, not browser counters or an asserted creator
role. Bind activity records to the authenticated account and define qualifying
completion, duplicate handling and policy version before enabling a threshold.
Activity establishes that policy's eligibility, not unique personhood. A wallet
or passkey also proves control, not that someone is a unique human. Where Very
is chosen, verify the configured evidence and its scope rather than accepting
a frontend success flag. Configured limits still apply to every eligible user.

Keep permission to post, eligibility for paid setup and release/content checks
distinct. An eligible poster is not entitled to unlimited signatures or funds,
and a funded wallet does not establish authorship or bypass the release policy.
The current owner-curated scope defers automated content moderation; this
document does not restore it as a launch dependency.

Before spending, bind the service's authenticated authorization to the community,
policy revision, eligible account and evidence, creator Sui address, selected
payer/service, action, network/package manifest, allowance, nonce, expiry and
native fee ceilings. The creator independently proves control of the recipient.
The service must trust the issuing community/key for that allowance; an arbitrary
community cannot authorize spending Pirate's funds. Atomically reserve budgets,
reject replays and reconcile uncertain attempts before retrying. Recheck
eligibility/revocation before new spend. None of these checks implies they are
already enforced by a Move contract.

## Costs and acceptance

The discussed approximately USD 0.07 per new wallet and USD 0.13 per signature
were dated estimates extrapolated from testnet operations and token prices.
They are not measured mainnet prices, a current quote or a per-song charge.
Do not present them as the real fixed cost of admitting a poster. Query current
native fees, estimate the actual transaction, include provider charges where
applicable and reserve explicit ceilings. Record protocol fees, execution gas,
storage charges and actual rebates separately; do not assume a future refund.

Wallet setup is paid once for a reused wallet. A recipient mint does not
inherently need a creator Ika signature; verify the selected registration
adapter. Later signatures have separate fees. Funding a creator does not mean
their songs or later actions are free, and signing costs must not be attached
to every song without an actual signing operation.

Before enabling broader creator funding, demonstrate rejection of ineligible
and forged requests, replayed evidence, wrong recipients, untrusted communities,
revoked grants and exhausted budgets. Demonstrate wallet reuse, correct ownership,
cost reconciliation and provider replacement for unstarted work. Qualify custody
and limits against the actual signer/provider, including a compromised caller
attempting to widen them. These are future acceptance requirements, not new
gates for the existing owner-only MVP or claims of passed implementation tests.
