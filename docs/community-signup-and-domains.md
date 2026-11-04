# Sponsored usernames and optional community domains

Owner decision, 2026-11-04. A new eligible participant can claim one sponsored
8+ character username as an ERC-721 on MegaETH. A community chooses Web2 only,
HNS only, or both for browser access. Web2 is optional, including for operators
who do not want an ICANN-facing site. This specification amends the earlier
single authenticated origin rule; it does not deploy or implement these flows.

## 1. Username ownership and eligibility

The username is an SLDRegistry ERC-721, minted directly to the participant's
chosen wallet. Its identity is chain ID, registry, token ID and generation;
the community ID remains `keccak256(abi.encode(chainId, registry))`, scoped by the
selected directory deployment. Web2 hostnames are access aliases, not another
NFT namespace. Both initially selected origins share one account and community;
they do not require a second mint. Later domain changes are custom migrations
outside wizard v1, as specified in section 4.

Eligible labels are available, valid registry labels of 8 through 63 ASCII
characters. This deliberately extends the centralized free offering's 8–32
band. Count the registry label only, excluding the dot and TLD. Use the
registry's lower-case letter, digit and hyphen validation without silently
normalizing input. Reserved, unavailable, closed or explicitly premium labels
are excluded from signup sponsorship unless the reviewed community policy
explicitly includes that exact label and its bounded price. Short names are
outside this offer. Operator setup names such as app are a separate allowance.

The default offer covers one successful initial registration for one year,
including its registration charge and the gas necessary to complete it. The
user need not deposit tokens, acquire ETH or bridge funds first. An eligible
community may choose a zero-priced tier, but zero onchain price is not required
for a free-to-user signup. Renewals, transfers, later names and unrelated
transactions are not included in the initial signup allowance. Public reading
does not require a name, wallet or membership.

Eligibility uses the community's existing admission/membership rules. It does
not create a global Pirate account or infer one human from one wallet. Enforce
one consumed signup allowance per admitted participant in this community, with
wallet and retry limits as additional controls. Where an existing scoped Very
nullifier supplies that participant key, keep it in the community's private
eligibility ledger; never publish it or add it to NFT metadata or mint calldata.
The exact policy and its durable participant key must be selected and tested
before sponsorship is enabled. A wallet-only pilot must disclose its weaker
anti-abuse boundary and retain a small finite budget.

The sponsor obtains no custody, transfer approval or record-manager authority
through payment. Transfer moves the name under the registry's existing rules;
it does not transfer community history, private records or the prior user's
session. Recheck active ownership before an operation that requires the name.
Transferring or losing a name, changing wallets, switching domains or restoring
the service must not reset a consumed signup allowance.

## 2. Pricing and sponsored execution

At registry source 296c97d, register accepts a recipient separate from its
payer, skips the token transfer at zero cost, and safely mints to that recipient.
Length prices, per-label prices and reservations still apply. No registry ABI
change, signed voucher or administrator mint is required for this offer. A
bounded sponsor can call register on the user's behalf; alternatively the
qualified MOSS account path may use a paymaster and funded registration call.
Select and prove the actual execution path instead of assuming gas sponsorship
also supplies the registration payment token.

A nonzero registration fee remains onchain even when the sponsor pays it.
Setting a tier to zero instead opens zero-price registration to anyone willing
to pay gas, including bulk claimers outside the sponsor. Sponsor eligibility
does not restrict that permissionless contract path. The wizard must explain
this distinction when the operator selects pricing and sponsorship.

The registry locks the annual price for the registration generation, including
transfers and grace. A zero-price registration therefore has zero-price renewals
for that generation; gas and timely renewal are still necessary. Sponsoring a
nonzero first year does not waive future annual charges. Display the selected
term, expiry, locked annual renewal price and who pays renewal gas before the
claim. Do not describe the name as perpetual or promise automatic renewal.

An enabled sponsor policy binds the MegaETH network, approved registry/code
profile, eligible labels, term, payment asset and maximum registration cost.
It sets per-claim gas and total-cost limits, per-participant limits, community
daily and total budgets, a concurrency limit and an emergency disable control.
The operator reviews the funding source and these finite limits. Exhaustion
leaves the claim pending or unavailable with clear copy; it must not silently
charge the user or substitute a paid transaction. Self-funded purchase requires
a separate explicit user choice. Ordinary NFT ownership and transfers remain
usable if the sponsor goes away.

The participant authenticates and approves the exact label, recipient,
community, chain, registry, term and quote. Bind a single-use nonce, deadline,
policy/configuration revision and idempotency key. Verify the selected wallet's
actual signature/account format, including supported smart accounts; an ECDSA
fixture is not MOSS acceptance. A fresh undeployed account needs a qualified
initialization/signature path with its setup cost included in the reviewed
claim budget; an unsupported account cannot silently become a custodial wallet.

The registry uses `_safeMint`. A recipient with onchain code, including an account
with active EIP-7702 delegation, must successfully handle `onERC721Received` and
return the required ERC-721 receiver value. Signature validation and undeployed
account tests do not prove this. Before enabling sponsorship, use an actual
initialized MOSS account with the selected implementation, delegation and module
profile: record its code/profile, successful registration receipt and active
NFT ownership readback. Exercise receiver rejection as well. A definite revert
must not appear as success or consume the successful-claim allowance; retain its
actual gas cost and reconcile uncertain outcomes. Never bypass safe minting,
mint to the sponsor or substitute custody to work around an incompatible wallet.

No browser-controlled sponsor flag authorizes spending. Allow only the reviewed
registration call and necessary payment/account steps, never arbitrary targets,
calldata, approvals or recipient substitution.

Persist the approved intent and reserve the allowance and maximum spend before
broadcast. Recheck availability and quote with maxCost and deadline enforced
by the registry. Record the transaction or user-operation identifier before
retry. An unknown outcome remains reconciling and keeps its reservation; never
issue another registration merely because a browser, relayer or RPC timed out.
Only a confirmed receipt plus active owner/generation readback completes the
claim. A definite failed transaction may release the name allowance, but its
actual gas spend remains charged to the sponsor budget. Reorgs and replacements
follow the pinned chain finality and sender-reconciliation policy.

The same private allowance and cost ledger serves every enabled community
origin. Adding an alias, switching between HNS and Web2, concurrent tabs or
restarting/restoring the service cannot obtain a second sponsored mint. Store
only the public registration onchain, not a cross-community user identifier.

## 3. Optional access modes

| Mode | Public application origins | Required acceptance |
| --- | --- | --- |
| Web2 only | An operator-selected ICANN HTTPS hostname | Domain control, routing, TLS and complete app/API behavior on that origin. |
| HNS only | An authenticated HTTPS app.tld origin in a qualified HNS client | Actual registry referral resolution, transport, wallet/login and app/API behavior without a required public Web2 origin. |
| Both | The independently verified Web2 and HNS origins | Both access paths operate on the same community and records with independent origin-bound sessions. |

The choice concerns browser access. It does not change HNS namespace authority
for the current SLDRegistry or waive HNS verification for Pirate discovery.
Unverified genuine test registries remain usable for isolated first-song tests
under the directory contract; a Web2 certificate does not verify an HNS claim.
Spaces remains deferred.

No Web2 hostname, ICANN zone, registrar transfer or public workers.dev endpoint
is a prerequisite when Web2 is disabled. Hide/skip its wizard inputs, credentials,
DNS/TLS resources and readiness gates; do not deploy it implicitly. An HNS-only
community must not force login, signup, posts or application navigation onto
the community's own Web2 alias. A selected HNS transport may use a protected
backend origin internally; this is distinct from requiring a public Web2 app.

This restriction does not remove external wallet dependencies. The selected
MOSS login uses https://account.megaeth.com, including its embedded wallet frame.
The creator-wallet flow uses a separate Pirate-run HTTPS site with its own
stable passkey/RP origin; record the exact selected origin in deployment evidence
rather than inventing a production hostname from the test pilot. Qualify MOSS
frame permissions, passkey creation/use, login signatures and callbacks in the
actual HNS browser. Separately qualify the creator-wallet popup/redirect and
passkey encryption flow while preserving its specified RP boundary. Both are
untested for HNS access. Visiting either wallet service is permitted; forcing the
community app onto its own Web2 alias is not. Provider downtime or lack of browser
support remains a real dependency failure, not a reason to silently change mode.

HNS-only access is a target with explicit unresolved integration, not a claim
of censorship immunity. Current Cloudflare hosting, wallet providers, RPC,
media transport and any TLS gateway can still be blocked or unavailable.
Record and qualify these dependencies against the intended client/network.
When a required capability is absent, show HNS setup as incomplete rather than
enabling a Web2 fallback against the operator's selection. A different wallet
or non-HTTPS content-addressed authenticated client needs separate qualification;
generic IPFS mirrors stay read-only under the browser contract.

## 4. Wizard and Alchemy domain management

The wizard presents the three modes before collecting domain settings. It may
recommend ordinary HTTPS for broad browser compatibility, but the operator
must be able to select HNS only without acquiring an ICANN domain. HTTPS-first
engineering delivery does not make Web2 mandatory product policy. The current
wizard's workers.dev setup-page slice is not implementation of these modes.

For v1, choose the registry TLD, access mode, domain names and deployment account
upfront. After the first deployment attempt, setup choices remain fixed. The
wizard does not provide later HNS/domain addition, replacement, removal or mode
switching. Operators may adapt the OSS with their own agent, but this is a custom
migration without a standard continuity or recovery guarantee. Keep the original
deployment state; a new state directory is not a migration mechanism. Credential
rotation, recovery and reviewed redeployment of the same setup remain supported.

A registry TLD is required even for Web2-only or isolated first-song testing. The
registry fixes its TLD; the directory fixes chain/registry identity. Use c22 for
staging when later delegation of that owned TLD is intended, rather than a blank
or unrelated namespace. HNS delegation and browser acceptance can remain pending
for the original selection; song tests may use an unverified genuine registry.
Completing that verification is not adding another TLD. A replacement registry
or migration from testnet to mainnet creates a different community ID; testnet
identity/history does not automatically carry over.

When Web2 is selected, the trusted runner uses the pinned Alchemy Cloudflare
provider to reconcile the chosen hostname, Worker attachment and required
DNS/TLS resources. The first supported path uses an operator-controlled active
Cloudflare zone. Check account/zone permissions and existing DNS/Worker ownership
before preparing a concrete review; do not overwrite or adopt an unrelated
record or hostname. Domain registration and registrar nameserver changes remain
separate, explicit steps where needed, not automatic domain purchase or transfer.

Cloudflare Worker Custom Domains manage their corresponding DNS and certificate
issuance. Alchemy owns the resource lifecycle; cf is diagnostic tooling, not a
second reconciler. Verify the pinned provider API rather than mixing v1 and v2
examples. External-DNS/SaaS custom-hostname support is not implied by the native
zone path and requires its own configuration and acceptance if added.

Persist nonsecret account/zone/resource IDs and the reviewed configuration
revision. Model domain control, DNS, TLS and application probes separately.
Resume pending verification without duplicate provisioning. Mark an origin
active only after control, valid transport and a same-origin app/API probe pass.
Security revocation remains required when control of an origin is lost. It
first disables that origin's host/session access, outstanding login challenges
and sockets. Any authorized cleanup reconciles only owned resources. A custom
migration must preserve the independently verified remaining origin and revoke
the removed origin; it must not accidentally remove the final working route.
These are service and custom-maintenance safety requirements, not a promise of
v1 domain removal or migration controls.

No Cloudflare zone/custom-domain operation is performed for the HNS TLD merely
because app.tld is configured. Follow the separate HNS ingress contract for
resolution and transport. New testing uses isolated ingress, never the existing
production gateway or its names.

The public configuration uses pirate.community-config/2 for this amended
origin contract. Retain the existing identity, feed, policy and contract fields;
replace the single session-origin/alias meaning with accessMode, preferredOrigin,
and an explicit applicationOrigins array of {origin, kind}, where kind is web2
or hns. Origins are unique exact HTTPS origins without paths, queries, fragments,
userinfo or wildcard hosts. Only verified enabled origins belong in this list.
preferredOrigin must be a member and is a sharing/discovery preference, never a
mandatory redirect for another enabled origin. API base is /api on every origin.

Both hosts serve the same revision and signed configuration bytes at
/.well-known/pirate-community.json, bound by the directory's existing content
hash/revision mechanism. A draft with no qualified origin cannot be advertised
as ready. Local pending checks and secret state are not public configuration.
Clients that understand only configuration v1 cannot silently use v2 for
authentication: they remain read-only with an upgrade message. This schema
revision changes no directory ABI or community identity. Origin activation and
revocation require verified controller-authorized configuration, not just an
untrusted manifest's assertion or a matching Host header.

## 5. Sessions and hostname isolation

Each enabled origin serves the app and /api on that same origin, backed by the
same community service and data. Application links, assets and API calls use
the current enabled origin; sharing metadata may name preferredOrigin but must
not force navigation or authentication there. Preserve host-only Secure, HttpOnly cookies;
bind every session and login nonce to community, wallet and exact origin.
Sign-in domain/URI and request Origin must match the actual validated public
origin, not merely any member of an allowlist. A signature, nonce or copied
cookie from one enabled host must be rejected at the other. Reauthenticate on
the second host; never copy tokens, cookies or private keys between hosts.

At trusted ingress, derive the public origin from an authenticated route map.
Reject unknown Host values and spoofed forwarding headers. Require same-origin
writes and keep credentialed cross-origin CORS disabled. HNS gateway forwarding
must preserve the verified public origin without treating attacker-supplied
X-Forwarded-Host as authority. WebSocket origin checks use the current enabled
origins for that ticket's community. Removing an origin revokes its sessions,
nonces and active sockets without invalidating the NFT or the other host.

## 6. Acceptance and current status

Acceptance must demonstrate a zero-funded new user authorizing the exact claim
and receiving the active ERC-721 in its wallet, with the registration charge and
actual gas paid by the disclosed sponsor. Verify the deployed registry's code,
event, owner, generation, term and locked renewal price. Check invalid/short,
premium, reserved, taken and price-changed names; exhausted budgets; recipient
substitution; concurrent/replayed claims across both domains; unknown transaction
outcomes; and allowance preservation across transfer and restore. Successful
local fixtures do not establish a live MOSS/paymaster or funded signup. Include
a successful safe mint to a real initialized MOSS account with its exact onchain
code/delegation/module profile and active owner readback, plus rejection by an
incompatible receiver. Signing successfully is not NFT-receipt acceptance.

For each selected mode, test public reading, login, renewal/logout, signup,
same-origin writes, post/playback and the selected wallet on the actual client.
In both mode prove shared community/NFT/content state and rejection of cross-host
credentials and spoofed hosts. Test pending/failed DNS and certificates, loss of
domain control, service-side origin revocation and recovery without duplicate
resources. Verify the wizard refuses setup changes after a deployment attempt;
there is no add/remove-domain acceptance path in v1. In HNS-only mode prove no
community Web2 setup requirement, implicit public alias or forced login redirect
to the community's own Web2 address. Separately prove MOSS embedded passkeys and
the external creator-wallet flow in the actual HNS client, recording browser,
OS, passkey provider and wallet origins. Their use is not a failure of the
community-alias rule. Successful operation in the intended network environment
is still required; dependency failure is incomplete acceptance, not permission
to weaken auth.

Current registry evidence is MegaETH testnet 6343 at 296c97d. The wizard PR 15
slice provisions a workers.dev setup page; it does not implement these modes,
the full application or sponsored username signup. This amendment is source
design only. First-song service integration keeps its existing priority;
customer sponsorship, optional-domain provisioning and HNS client acceptance
must be implemented and qualified in their owning lanes. Mainnet, funds,
credentials and deployment operations require their own scoped authorization.

The provider checks used the official [Alchemy custom-domain documentation](https://alchemy.run/cloudflare/networking/custom-domains/)
and [Cloudflare Worker Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
The [registry source](https://github.com/pirate-social-club/pirate-registry/blob/296c97d7f0fa05711d78c5074f8ee13fe01b50d9/src/SLDRegistry.sol)
owns price, mint and renewal behavior. [MOSS](https://joinmoss.megaeth.com/)
documents sponsored gas; that capability is not evidence of our integration.
The [ERC-721 receiver contract](https://eips.ethereum.org/EIPS/eip-721#specification)
specifies the callback; the pinned registry's safe-mint implementation applies
that check during registration.
