# Pirate operators

A standalone local experiment for community-operated song admission, karaoke,
operator payments and pooled rewards. The workspace_owner approved the six
experiment decisions and public source publication on 2026-11-03.

The first headless skeleton runs from wallet sign-in to token withdrawal.
It uses four isolated Cloudflare Workers with distinct role keys and SQLite
Durable Object storage, a WebSocket performance replay, the pinned karaoke
scorer, and actual Solidity contracts executing on Anvil. A fifth local Worker
is the simulated payment provider, with its own persisted store.

## Run locally

Install Node.js 24 and Foundry 1.9.0, then install the pinned dependencies:

```sh
npm ci --ignore-scripts
forge build
```

Bootstrap may access the network. Subsequent acceptance runs need only loopback:

```sh
npm run acceptance
```

This starts and stops its own Workers runtime and Anvil on loopback port 18545.
It seeds one community, a synthetic MP3, three test wallets and one drawing.
It prints JSON lines and exits nonzero on a failed assertion. Temporary Worker
stores are created under the operating system's temporary directory. Contract
artifacts are written under .local/artifacts. Nothing is deployed remotely.

The fixture win is 10,000,001 test USDC units: three participants each withdraw
3,333,333, the sponsor receives two units of dust, and the pool ends at zero.
This example does not promise that pools generally empty; allocations never
expire. The fixture ticket costs 1,000,000 token units (one test USDC), with the same
amount as its spending cap; the pool reads the quote rather than hardcoding it.
Admission costs two simulated units and each attempt costs two.

On Linux, enforce the offline boundary rather than relying on configuration:

```sh
unshare -Urn sh -c 'ip link set lo up && npm run check'
```

This requires permission to create user and network namespaces. CI installs
dependencies first, then runs checks in a network namespace with only loopback.
The Workers runtime separately refuses outbound external fetches.

```sh
npm run check
npm run build
```

Checks cover the protocol, persisted payment retries, reservation concurrency,
focused Solidity failure cases and the complete headless flow. Build packages
the Worker through cf. The cf configuration is a disabled packaging template;
the acceptance harness supplies the isolated runtime configurations. Hosted
deployment and service authentication are later work. No Wrangler file is used.

## Protocol subset

The service-envelope skeleton remains version 0. The reward attestation domain
is `Pirate Reward Pool`, version `1`, as specified.
Evidence, tickets and results use EIP-712 envelopes with canonical JSON hashes.
Audio evidence hashes the actual uploaded MP3 bytes. Pool reward attestations
bind the chain, pool, drawing scope, claimant and expiry. Test subjects produce
one nullifier per scope independently of their wallet.

Community sessions use signed EIP-4361 messages and single-use nonces. The
headless client holds a bearer token; the skeleton also persists its raw value
in the community session key. Hashed session storage and atomic nonce
consumption are required before the planned D1 migration. The community
accepts only results
from its configured operator and applies score, coverage and cutoff rules.
The pool trusts the community verifier's entry commitment and the configured
Very attester. It cannot establish whether a provider was actually called.

The pool currently handles one immutable drawing. It reads a per-drawing
ticket price, enforces an immutable token spending cap, buys under a separate
executor role, and holds the resulting ticket NFTs itself. Settlement requires
both advancement beyond its drawing ID and a nonzero finalized winning ticket.
The local provider implements the minimal Megapot V2 call shapes used by
the pool. A separate pinned Base mainnet fork exercises the deployed provider
for wins, losses and emergency recovery; it does not test live oracle delivery.
See [the boundary review](docs/megapot-boundary.md) for source pins and limits.
The headless executor builds the entry root and submits it using the community
verifier's fixture key. Moving root preparation and chain submission behind
the community service is remaining M1 work.

Public fixture keys are derived from the integers one through nine. They must
never hold assets outside a disposable local chain. The local-only handlers,
debug routes and fake attester are not suitable for hosted operation.

## Winnings, registration and withdrawal

Megapot winnings are claimed by the reward pool and transferred into that
contract. The treasury sponsors tickets; the Tempo operating wallet pays
operators. Neither receives the participants' allocated winnings.

The registration window starts when a finalized winning drawing is settled
into the pool. Passing zero for the constructor duration selects seven days;
a positive duration explicitly overrides it, including 60 seconds in the local
fixture and 30 seconds in the public-testnet fixture. This is a default, not an
enforced seven-day minimum. The immutable duration must be disclosed before
participation. Registration is strictly before the deadline; at or after it,
anyone can finalize. Missing registration means no allocation. If nobody
registers, winnings become sponsor credit.

The participant signs an EIP-712 registration fixing their payout address.
Anyone can submit it with the qualifying entry proof and scoped Very
attestation, paying Base gas for them. Anyone can later pay out that allocation
to the signed address. The headless flow batches both steps through the
community relayer; participant wallets sign but send no transactions.
Sponsored registrations use the claimant's original ECDSA key. Empty-code EOAs
and EOAs carrying an exact EIP-7702 delegation marker are accepted. Other
contract wallets, ERC-1271 signatures and Tempo passkeys are not supported.
Provider unavailability fails closed, with no alternate provider or extension.
The pool has no administrator deadline-extension or allocation-sweep function.

Batches contain at most 32 items and isolate each operation with a 300,000-gas
allowance. A bad signature, duplicate proof, blocked transfer or exhausted item
can fail while the other items complete. The transaction still needs enough
gas for the whole bounded batch. These limits do not replace a relayer's
operating budget. See [the signed-claim protocol](docs/reward-pool.md).

After finalization, allocations never expire. Failed transfers preserve them
for retry. The claimant also retains direct registration and an authenticated
withdrawal to another address as fallback; a relayer cannot choose a new
recipient. Losing the claimant key after registration does not stop anyone
paying the fixed recipient, but access to that receiving wallet still matters.
A Base pool pays Base USDC. A payout address does not bridge funds to Tempo or
establish control of a Tempo-native account on Base.

The sponsor receives only unused ticket funding, rounding dust, winnings when
nobody registered, or an upstream emergency ticket refund. It cannot take
participants' unwithdrawn allocations. Before purchase, prefunding can be
recovered after the entry cutoff. After purchase, anyone can recover tickets
only if Megapot enables emergency mode for the pool's current unfinished
drawing. Recovery closes that pool and credits the sponsor, who can withdraw
separately and retry a failed transfer. An older completed drawing still
settles normally. A stalled drawing without upstream emergency mode remains
dependent on Megapot; there is no arbitrary local timeout cancellation.

## Remaining M1 work

The [creator-wallet and song-registration contract](docs/creator-wallet.md)
specifies the separate Ika testnet proof for first song
release. Ordinary MOSS participation does not create a creator wallet. The
creator owns the control capability. Saved passkey access and confirmed
on-chain activation are required before upload and Aeneid registration.
The real browser spike demonstrated activation and reopen-and-sign access;
full acceptance and first-song registration remain incomplete. The
[payment and wizard contract](docs/creator-wallet-payments.md) separates the
operator's native fee funding from creator upfront payment or explicit community
sponsorship. Billing and wizard integration are specified, not implemented by
the spike. This is not a production DATA integration.

The skeleton is the first runnable deliverable, not full revision 5 acceptance.
Remaining work includes provider failure modes and audio-window extraction,
complete entity state machines and vectors, streaming consumption and channel
voucher/credit/close accounting, credential sponsorship buckets, membership
gate enforcement, ERC-1271/passkey compatibility, bound segment manifests,
ticket expiry alarms and synchronized timer draining, service-owned entry
commitments, the complete adversarial matrix and broader lifecycle invariants. The pool
now has stateful Foundry checks for token conservation, finality, allocations
and duplicate prevention, plus emergency sponsor recovery and the focused
sponsored-registration failure cases.
The static client and operator container conformance test also follow this run.
The [community web client and deployment contract](docs/community-web-client.md)
specifies that client, its cookie sessions, the karaoke socket handshake,
publication-time public pages, localization and deployment modes. None of it
is implemented yet.

A separate [testnet spike](docs/testnets.md) now runs real MPP sessions on
Moderato and the same pool flow on Base Sepolia with simulated providers.
M2 still requires the complete payment failure matrix. M3 requires real Very
and live Megapot integration; neither milestone is complete. The fork proves
contract-held tickets against pinned deployed code. Live drawing delivery,
Very nullifier stability and Tempo voucher headroom charging remain integration
questions. No one-person assurance follows from the fake credential.

A manual [Very credential probe](docs/very-probe.md) prepares four live requests
to test nullifier stability and scope separation. It uses the hosted verifier,
issues no reward attestations and leaves the fake attester unchanged. Its
offline fixtures are not evidence of Very's real uniqueness behavior.
A live run with one enrollment passed all four requests and three comparisons
on 2026-11-03. The redacted observation supports that enrollment's scoped
nullifier behavior; it does not establish one enrollment per human or complete M3.

The experiment decisions are: standalone ownership; initial operators run by
Pirate; testnets for later integrations; community-local accounts; one reward
registration window; and Very as the sole reward credential. Self may gate
membership. See PROVENANCE.json for the copied scorer's source commit, hashes
and the single import-path change. There are no imports into api-next or the
existing SSR frontend. No license grant has been added to the experiment.
