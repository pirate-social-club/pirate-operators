# Pirate operators

A standalone local experiment for community-operated song admission, karaoke,
operator payments and pooled rewards. The workspace_owner approved the six
experiment decisions and public source publication on 2026-11-03.

The headless skeleton runs from wallet sign-in to token withdrawal. It uses
isolated Cloudflare Workers with distinct role keys: the community on D1, the
operator with a Durable Object for its live karaoke session, and a fake Very
attester. It also uses a WebSocket performance replay, the pinned karaoke
scorer, and actual Solidity contracts executing on Anvil. Operators are paid
through the `OperatorPayments` contract, as
[the operator payments contract](docs/operator-payments.md) specifies.

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
Admission costs 2,000 test token units and each karaoke line 1,000, each paid
by one redeemed purchase.

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

Checks cover the protocol, the payment contract, the community's purchase
limits, the operator's redemption queue and crash recovery, focused Solidity
failure cases and the complete headless flow. Build packages
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

Community sessions use signed EIP-4361 messages and single-use nonces. Session
tokens stay in the headless client process. The community accepts only results
from its configured operator and applies the reward score and cutoff rules.
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
contract. The treasury sponsors tickets; the community pays operators through
`OperatorPayments`. Neither receives the participants' allocated winnings.

The registration window starts when a finalized winning drawing is settled
into the pool. Passing zero for the constructor duration selects seven days;
a positive duration explicitly overrides it, including 60 seconds in the local
fixture. This is a default, not an
enforced seven-day minimum. The immutable duration must be disclosed before
participation. Registration is strictly before the deadline; at or after it,
anyone can finalize. Missing registration means no allocation. If nobody
registers, winnings become sponsor credit.

The participant signs an EIP-712 registration fixing their payout address.
Anyone can submit it with the qualifying entry proof and scoped Very
attestation, paying gas for them. Anyone can later pay out that allocation
to the signed address. The headless flow batches both steps through the
community relayer; participant wallets sign but send no transactions.
Sponsored registrations use the claimant's original ECDSA key. Empty-code EOAs
and EOAs carrying an exact EIP-7702 delegation marker are accepted. Other
contract wallets and ERC-1271 signatures are not supported.
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
A pool pays its configured token on its own chain, and a payout address does
not bridge funds anywhere. Where the reward pool runs, given that Megapot is
on Base and our contracts deploy to MegaETH, is an open decision.

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

The skeleton is the first runnable deliverable, not full revision 5 acceptance.
Remaining work includes provider failure modes and audio-window extraction,
complete entity state machines and vectors, leaderboard indexers,
credential sponsorship buckets, membership gate enforcement,
ERC-1271/passkey compatibility, scheduled operator ticks, service-owned entry
commitments, the complete adversarial matrix and broader lifecycle invariants. The pool
now has stateful Foundry checks for token conservation, finality, allocations
and duplicate prevention, plus emergency sponsor recovery and the focused
sponsored-registration failure cases.
The static client and operator container conformance test also follow this run.
The [community web client and deployment contract](docs/community-web-client.md)
specifies that client, its cookie sessions, the karaoke socket handshake,
publication-time public pages, localization and deployment modes. None of it
is implemented yet.

Operator payments run locally against Anvil and on MegaETH testnet (chain
6343), as [the testnet record](docs/megaeth-testnet.md) describes. Public
learning records follow [the LearningRecords encoding](docs/learning-records-contract.md):
the operator publishes a consented karaoke result line by line, and an
independent reader rebuilds a learner's grades from chain logs and public
manifests alone. Leaderboard indexers and the Dance and Study record shapes
are not built. M3 requires real Very and live Megapot integration; neither is
complete. The fork proves contract-held tickets against pinned deployed
Megapot code. Live drawing delivery and Very nullifier stability remain
integration questions. No one-person assurance follows from the fake
credential.

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
