# Community accounts, sponsorship and portability, version 1

Launch applicability, November 8: the workspace owner is the only song
publisher and publishes through the ordinary account, with no creator
activation or posting-time Palm; see
[owner-only MegaETH song publication](megaeth-song-publication.md). Learner
participation and cash-out verification rules are unchanged. The wallets,
royalties and costs section describes deferred creator revenue routes.

The 2026-11-06 [learner-held history specification](learner-history.md) owns
private language-history portability, optional encrypted backup and tutor access.
Local community account IDs do not give communities ownership of that history.
The [compact results amendment](learning-results-v2.md) supersedes the next
implementation's per-line payment/publication shape; the existing runtime
observations below remain dated evidence.

Design contract, 2026-11-04. This document separates community identity from
wallet authority and records the future protocol direction. It does not
implement another sign-in method, change a contract or enable a deployment.
Cloudflare, Alchemy and MOSS remain the MVP path. The creator passkey remains
specific to registered song releases.

The first Nostr integration should connect an identity to an existing account
and optionally share posts. Connecting Nostr does not enable login, confer
membership or create a spending allowance. Nostr-first login and a community
using a VPS, Spaces and Nostr are later capabilities with their own acceptance
work.

## Current evidence and ownership

The runtime baseline is operators commit
`e2f906195fb4fa853f84d053d197b2ca97e0d272`. Its community session contains a
wallet address, not an independent account ID. The browser cookie contract is
also a target design; the headless skeleton still returns bearer tokens.

| Boundary | Current source and constraint |
| --- | --- |
| Authentication | `services/community.ts`: `/session` stores `wallet`; tickets, purchases and qualification read `session.wallet`. |
| Sponsorship | `services/community-purchases.ts`: `wallet:<address>` holds usage, sequence and the open ticket in one atomic record. The per-wallet cap is implemented; configurable per-credential and community-period budgets remain deployment work. |
| Reward entry | `services/community.ts`: `entry:<wallet>` stores a signed operator result. `contracts/RewardPool.sol` binds the claimant, recipient, attempt, drawing/pool scope and nullifier. |
| Community storage | `services/storage.ts`: `D1Store` is the only `AsyncStore` implementation. Conditional writes, one-use consumption and compare-and-set behavior are part of its contract. |
| Operator storage | `services/runtime.ts`, `services/operator-tx.ts` and `services/records.ts`: Durable Object storage and transactions also support payment and grade state, beyond the karaoke socket. |

This is a multi-file authorization change, not just replacing a session field.
No implementation estimate has been established. The MOSS consent lane owns
verification of actual MOSS signatures and contract compatibility; adding an
account ID cannot establish either.

The [browser contract](community-web-client.md),
[operator payments](operator-payments.md),
[reward pool](reward-pool.md) and
[Very reward scope](very-reward-scope.md) keep their existing security rules.
This document replaces the browser contract's wallet-as-account assumption,
not its cookie, origin, CSRF, nonce or attempt-key requirements.

Related proposals were inspected at fixed revisions: the
[creator wallet v4](https://github.com/pirate-social-club/pirate-operators/blob/bc60731c721f98107192eb592ff8e70b28fa7833/docs/creator-wallet.md)
and the
[post identity contract](https://github.com/pirate-social-club/pirate-operators/blob/8833ab67dd767761e5f63fc9117413aa58dddd63/docs/contracts/community-posts.md).
References to those proposals do not merge their branches or claim deployment.

## The first account change

Recommend implementing this bounded slice before independently operated
communities accumulate persistent user data. It does not block the current
MOSS/creator-wallet spike. Implementation and its release gate need their own
review; this specification does not declare the change shipped.

An account has a server-generated, opaque random `accountId`, scoped to one
community. It is neither a wallet address, a handle nor a global user ID. Keep
it private. A public author pseudonym is a separate random value, with its
mapping to the account stored privately; do not expose the account ID in
feeds, manifests or chain events.

Initially, every account has exactly one verified MOSS wallet binding. A
credential record identifies its namespace/network and normalized subject,
its account and the purpose it authorizes. The first record permits login and
identifies the MegaETH wallet. Future social connections do not automatically
gain either permission. An account does not imply membership or eligibility.

Successful MOSS authentication atomically finds or creates the unique binding
and account. Concurrent logins for the same credential converge on the same
account; a failed write must not leave an accepted session or an orphaned
authoritative binding. The client cannot choose an existing account ID to
attach to. The implementation must establish this invariant using the
storage adapter's actual atomic operations, not unrelated unchecked writes.

Sessions identify the account, the authenticating credential, the community
and expiry. The browser stores only the opaque session cookie under the
browser contract. Handlers resolve the account's verified wallet explicitly
when the requested capability requires one. Public reading requires neither.
Missing membership, missing wallet authority and exhausted sponsorship are
different conditions and must not be treated as a generic login failure.

Local profile and membership records refer to `accountId`. Financial and
attempt records may add that private reference, but retain their current
wallet keys, signed bodies and uniqueness constraints in the first slice.
In particular, a reward entry is not reduced to just an account ID. Retain
the original result, claimant, attempt and applicable drawing/pool context.

Tickets, learning-record consent, purchases, reward attestations and
registrations keep their existing wallet fields and signature domains.
Capture the exact authorized wallet and request context when an operation
begins. Retries and settlement use that captured authority, not whatever
wallet happens to be linked later. Settlement must remain possible after a
session expires. A future credential change cannot redirect a payout or
re-sign existing consent.

No account merge, wallet replacement, unlinking, Nostr login or AT Protocol
login is included in this slice. Handle ownership or transfer never merges
accounts or transfers private history and sessions.

## Sponsorship is a separate decision

For every funded action, answer four questions independently: which account
is requesting it, whether that account is eligible, who pays and what signing
authority the action needs. A Nostr signature proves control of a key. It does
not prove unique personhood, membership, funds or a right to sponsorship.

In the current payment design, the community funds its operator deposit and
signs bounded purchases. The operator redeems those purchases for completed
work. A learner need not pay the operator from their own wallet, but the
ticket and consent paths still name and authenticate a supported EVM wallet.
MOSS remains that integration target. The creator's Ika wallet is a separate
capability, not a prerequisite for studying or karaoke.

A later Nostr-first journey would be: authenticate the Nostr key, resolve the
local account, satisfy the community's admission policy, and link a supported
MegaETH wallet before a wallet-bound action. Then reserve the allowance and
issue the existing ticket/purchase. Any wallet activation or relay gas needs
an explicit payer too; sponsoring operator work does not automatically fund
every transaction. Do not create an Ika wallet just to bypass this requirement.

Sponsorship policy must define its scope, period, verified eligibility subject,
limits and payer. Where Very is used, use the appropriate verified scoped
subject and maintain its consumed allowance across account/credential changes.
Do not substitute a client-supplied handle, Nostr key or account ID for that
subject. Keep admission/sponsorship scopes separate from the frozen reward
scope encoding. Very's live assurance limits still apply; this is not a claim
that unique-human admission has been proved.

Fresh Nostr keys, linked wallets, account recreation and handle transfers must
not replenish an existing subject's allowance. Reserve and settle spending
atomically, retain evidence across retries, and enforce both subject and
community limits. Exhaustion refuses new sponsored work or offers a separately
authorized payment option; it must not silently charge the member or exceed
the operator budget. These broader policy buckets are future work, not a
description of today's per-wallet limiter.

A community without MegaETH could later pay a service provider through another
billing adapter and sponsor its own study/karaoke service. That does not make
today's signed ticket, payment contracts or reward pool chain-independent.
MegaETH rewards still need the supported claimant wallet and existing consent
and nullifier rules. No alternative billing flow is specified here.

## Connecting protocols and publishing content

Treat these as separate stages, each enabled only when implemented:

1. Connect a Nostr identity to an existing MOSS account. Require fresh proof of
   control of the existing account and the Nostr key, bound to the community,
   origin, connection purpose, nonce and expiry. The nonce is single-use. A
   claimed handle/address or matching profile is insufficient. A connection
   conflict fails; it never silently merges accounts.
2. Offer explicit sharing of admitted posts to selected relays. Obtain the
   needed signing authorization; an account-link proof does not authorize
   future posts. Distinguish member-signed posts from community-signed notices.
   Persist publication receipts and retries without changing the original
   post's identity. Revoking sharing stops future sends, not existing copies.
3. Consider Nostr-first login separately. It needs a login challenge and
   credential policy, membership and sponsorship handling, recovery and explicit
   wallet attachment at the relevant feature. It must not activate merely
   because a key was connected for sharing.
4. Consider native group participation and a community-operated relay when
   there is demand. NIP-29 is a candidate, requiring compatible clients and
   enforcement of admission/moderation at the relay boundary. External clients
   must not bypass song checks by publishing directly. It is not a promise
   that any Nostr client supports the complete Pirate workflow.

The first two stages provide social identity and reach. A relay adds a native
social interface and another distribution path; it is not a replacement for
private community state, operator execution or media persistence. A Nostr
signer may use an extension or remote signer and chooses its own unlock flow.
No passkey count is promised. Sign-in alone needs no community-operated relay,
although a remote signer may itself communicate through relays. See
[NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md),
[NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) and
[NIP-29](https://github.com/nostr-protocol/nips/blob/master/29.md).

AT Protocol follows the same separation between connecting, sharing and later
login/native participation. Verify the OAuth account's stable DID; a mutable
handle is not the account key. Request only the necessary permissions and
keep publication consent distinct. Existing accounts can use their own PDS;
the community need not host one just to connect them. Custom records and a
community feed require schemas and indexing; posting them does not guarantee
visibility in Bluesky. Standard AT handles use DNS, so a Spaces name would be
an additional alias. See [OAuth](https://atproto.com/specs/oauth),
[Lexicon](https://atproto.com/specs/lexicon) and
[handles](https://atproto.com/specs/handle).

Separate reusable content from each transport's signed envelope. Keep chain,
contract, community and other replay-prevention context in signatures that
need it. Today's public post identity remains the chain/contract/community/post
tuple. A list of publication channels alone does not remove that dependency.
Track native event IDs separately and do not assume an author signed content
that was only attested by a community publisher.

## Spaces and a future VPS profile

Hosting, naming, account authentication, publication and money/rights are
separate choices with explicit compatibility requirements. They are not yet
interchangeable implementations. The later profile is a community service and
web client on a VPS, a supported persistent store, public media pinned on IPFS,
Spaces naming and optional Nostr connections/sharing or a relay. HTTPS/origin
resolution still needs a supported access path for the chosen clients.

Spaces Fabric documents `nostr` address records containing a public key and
relay information. They are one-way assertions: verify namespace ownership
against a trusted current anchor and independently prove control of the Nostr
key. A handle is not sufficient account-link evidence. Separate handle-key
custody, issuance, renewals/operations and transfer policy from social-key
custody. A Nostr signer is not automatically a Bitcoin transaction signer.
Operating handle issuance adds infrastructure beyond running the community
app. See the [Fabric SDK](https://spacesprotocol.org/docs/developers/sdk/) and
[handle issuance](https://spacesprotocol.org/docs/infra/subs/).

The workspace_owner's provisional discovery direction allows independently
operated communities using other protocols to become eligible for Pirate
listing, subject to identity verification and moderation. The MVP directory
still uses its approved EVM registry path. A second registration/indexing route
is deferred; a Spaces record or relay alone does not currently obtain listing.

## Hosting, media and recovery

Alchemy owns provisioning, but selecting its Hetzner provider does not port
Workers bindings, D1, R2, Queues or Durable Object semantics. Keep host resource
types in deployment/runtime adapters and application storage/publishing calls
behind small capability boundaries. Do not introduce a universal plugin
framework or a second implementation merely to claim portability.

Continue using Durable Objects where needed. A supported Alchemy/celld/Rivet
path may later supply that runtime; do not recreate it for launch. Validate
the selected version's transactions, recovery, sockets, jobs and bindings on
the actual host. D1's SQLite basis and R2's S3 API are useful starting points,
not proof that another implementation preserves our behavior.

The first non-Cloudflare restoration exercise should include a file-backed
SQLite adapter if no qualified runtime supplies the required store. External
Postgres is also possible with its own adapter and atomicity checks; Hetzner
does not force SQLite. Alchemy's
[Hetzner/Postgres guide](https://alchemy.run/hetzner/data/drizzle-postgres/)
uses an external database. This exercise and new deployment stacks are
post-MVP work.

IPFS is the chosen public-media layer. Share admitted media/manifests through
their content references and supported gateways. Pinning and serving still
have operators and costs; a CID alone is not availability or a recoverable
community. Private upload staging, rejected media, sessions, eligibility data,
jobs and secrets need private storage and must not be published to IPFS.
See [IPFS persistence](https://docs.ipfs.tech/concepts/persistence/).

Removal stops serving/pinning controlled copies and withdraws their references
where possible. It cannot erase independent IPFS pins or third-party protocol
copies. A community relay's removal applies to that relay. Share only content
approved for public distribution and disclose this limit before enabling
sharing; link cards do not make already-public media revocable.

Export/recovery must cover versioned private records, membership/credential
links, spending/nullifier history, pending operations, public content and pin
inventory, configuration and domain control, plus Alchemy deployment state.
Community-generated signing keys need an operator-controlled encrypted recovery
path with a separately recoverable decryption key; an unreadable Worker secret
is not that backup. Do not assume the wizard already provides it. This is
community-operator recovery, not a change to the creator wallet's separate
user-key recovery policy. Restore drills must prevent two active writers or
duplicate settlement after failover and must not revive expired sessions.

## Wallets, royalties and costs

MOSS supplies the current MegaETH wallet path. The creator proposal separately
creates a Sui control account and an Ika secp256k1 dWallet with an EVM address.
It does not automatically create Solana or Bitcoin wallet flows. Ika documents
Bitcoin/EVM signing and Ed25519 support for Solana; a Solana integration needs
the appropriate additional dWallet. A Sui-coordinated dWallet can control
native BTC through a Bitcoin integration, but the application must implement
and verify receive/send, transaction construction, signing, fees and recovery
on the selected network. This is future capability, not current product
support. See [Ika's SDK](https://github.com/dwallet-labs/ika/blob/main/sdk/typescript/README.md).

A connected Nostr key neither controls those wallets nor routes their funds.
Ika supplies signing, not Lightning infrastructure, exchange or royalty
accounting. Lightning tips, native BTC receipts and public IPFS plays do not
automatically reach the royalty module. Each revenue route needs an explicit
payment/rights integration and reconciliation policy. The current creator
registration scope and its testnet limits remain unchanged.

| Optional capability | Cost and payer to define before enabling it |
| --- | --- |
| Nostr connection/sharing | Signature verification, delivery and retries; selected signer/relay services may charge. No Bitcoin transaction is required just to prove a Nostr key. |
| Native relay and VPS | Compute, persistent storage, bandwidth, backups, moderation and operations, paid by the community or its selected provider. |
| Spaces naming/issuance | Name acquisition, applicable Bitcoin transactions and issuance/resolution operations; separate from every login or post. |
| AT Protocol connection/sharing | OAuth/session maintenance and indexing/delivery; PDS/provider terms and quotas apply. Hosting a PDS or AppView adds separate costs. |
| Media and funded actions | IPFS pinning/gateways, operator checks, chain/relay fees and creator-wallet protocol fees, each with an explicit sponsor or payer and cap. |

These are cost categories, not price commitments. Protocol availability does
not imply a free hosted service. Measure real provider quotes and failed/retry
costs when enabling a capability, without adding pricing infrastructure now.

## Implementation and acceptance handoff

The first slice touches session issuance/lookup, credential/account storage,
the wallet resolver in community handlers, and their fixtures/acceptance flow.
Inspect `services/community.ts`, `services/community-purchases.ts`,
`services/storage.ts`, `test/payments-fixture.ts`,
`test/operator-payments.test.ts` and `harness/acceptance.ts` together. No
contract or signature-format change is required by the proposed boundary.

Use a versioned, idempotent per-community migration for any persisted pilot
data: map each verified wallet identity to one private account, preserve all
financial keys, public author pseudonyms, signed evidence, consumed allowances
and nullifiers, and check for duplicate mappings and orphaned references.
Back up first and verify a restore. Existing sessions may be invalidated for
reauthentication. Never infer new credential ownership from a handle or reset
real records as if they were fixtures. Each independent operator controls their upgrade; Pirate
cannot assume access to every community database. A rollback must not restore
an old writable schema after new financial activity without reconciliation.

Acceptance must establish that concurrent/repeated MOSS logins resolve the
same account; replay, wrong origin and account substitution fail; no social
connection enables login or spending implicitly; existing ticket/payment and
reward bytes and uniqueness rules remain valid; expired sessions do not block
settlement; and migration preserves balances, allowances and pending work.
Future credential linking additionally needs two-sided control proofs and
tests that identity changes cannot obtain another allowance or redirect an
existing payout. Nostr/AT adapters and a second host remain separate later
work, with compatibility and restore evidence required before advertising
support.
