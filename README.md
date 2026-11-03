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

Community sessions use signed EIP-4361 messages and single-use nonces. Session
tokens stay in the headless client process. The community accepts only results
from its configured operator and applies score, coverage and cutoff rules.
The pool trusts the community verifier's entry commitment and the configured
Very attester. It cannot establish whether a provider was actually called.

The pool currently handles one immutable drawing. It reads a per-drawing
ticket price, enforces an immutable token spending cap, buys under a separate
executor role, and holds the resulting ticket NFTs itself. Settlement requires
both advancement beyond its drawing ID and a nonzero finalized winning ticket.
The local provider now implements the minimal Megapot V2 call shapes used by
the pool; this does not establish compatibility with any deployed contract.
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
into the pool. Its duration is immutable and disclosed before participation;
the local fixture uses 60 seconds, and no real duration has been chosen.
Registration must occur strictly before the deadline. At or after it, anyone
can finalize the split among accepted registrations. Missing registration
means no allocation; with zero registrations, winnings go to the sponsor.

An accepted registration needs the entry wallet and a valid scoped Very
attestation. Provider unavailability fails closed, with no alternate provider
or automatic extension. The contract has no administrator deadline-extension
or sweep function. The local constructor requires a positive duration but
sets no product minimum or maximum; practical duration policy is remaining work.

After finalization, an allocation never expires. The registered wallet can
withdraw to its own or another address, and a failed transfer preserves the
allocation for retry. Losing the signing key can leave the money locked
indefinitely. The sponsor receives only its unused ticket funding, rounding
dust, or winnings when nobody registered; it cannot take a participant's
unwithdrawn allocation. Transaction submission and gas sponsorship are separate
from the allocation and are not established by this local demonstration.

## Remaining M1 work

The skeleton is the first runnable deliverable, not full revision 5 acceptance.
Remaining work includes provider failure modes and audio-window extraction,
complete entity state machines and vectors, streaming consumption and channel
voucher/credit/close accounting, credential sponsorship buckets, membership
gate enforcement, ERC-1271/passkey compatibility, bound segment manifests,
ticket expiry alarms and synchronized timer draining, service-owned entry
commitments, the complete adversarial matrix and broader lifecycle invariants. The pool
now has stateful Foundry checks for token conservation, finality, allocations
and duplicate prevention, alongside the focused failure cases.
The static client and operator container conformance test also follow this run.

M2 replaces simulated transport with Tempo on Moderato. M3 exercises Very and
the pool on Base Sepolia. Neither has been run. Very nullifier stability,
Tempo voucher headroom charging, and real Megapot contract-held tickets remain
integration questions. No one-person assurance follows from the fake credential.

The experiment decisions are: standalone ownership; initial operators run by
Pirate; testnets for later integrations; community-local accounts; one reward
registration window; and Very as the sole reward credential. Self may gate
membership. See PROVENANCE.json for the copied scorer's source commit, hashes
and the single import-path change. There are no imports into api-next or the
existing SSR frontend. No license grant has been added to the experiment.
