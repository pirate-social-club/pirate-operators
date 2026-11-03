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
expire. Admission costs two simulated units and each attempt costs two.

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

Local skeleton version 0 intentionally names its own signature domains.
Evidence, tickets and results use EIP-712 envelopes with canonical JSON hashes.
Audio evidence hashes the actual uploaded MP3 bytes. Pool reward attestations
bind the chain, pool, drawing scope, claimant and expiry. Test subjects produce
one nullifier per scope independently of their wallet.

Community sessions use signed EIP-4361 messages and single-use nonces. Session
tokens stay in the headless client process. The community accepts only results
from its configured operator and applies score, coverage and cutoff rules.
The pool trusts the community verifier's entry commitment and the configured
Very attester. It cannot establish whether a provider was actually called.

The pool currently handles one immutable drawing. The mock Jackpot interface
is explicitly simulated and has not been established as Megapot-compatible.
The headless executor builds the entry root and submits it using the community
verifier's fixture key. Moving root preparation and chain submission behind
the community service is remaining M1 work.

Public fixture keys are derived from the integers one through eight. They must
never hold assets outside a disposable local chain. The local-only handlers,
debug routes and fake attester are not suitable for hosted operation.

## Remaining M1 work

The skeleton is the first runnable deliverable, not full revision 5 acceptance.
Remaining work includes provider failure modes and audio-window extraction,
complete entity state machines and vectors, streaming consumption and channel
voucher/credit/close accounting, credential sponsorship buckets, membership
gate enforcement, ERC-1271/passkey compatibility, bound segment manifests,
ticket expiry alarms and synchronized timer draining, service-owned entry
commitments, the complete adversarial matrix and Foundry invariant handlers.
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
