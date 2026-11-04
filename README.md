# Pirate operators

A standalone experiment for independently operated communities, song admission,
karaoke and operator payments. The [setup-to-first-song plan](docs/decentralized-setup.md)
explains the required happy path: selected application origins, namespace authority, community directory,
Alchemy.run provisioning, Infisical secrets, real moderation and first post.
The [signup and optional domains specification](docs/community-signup-and-domains.md)
adds one sponsored 8–63 character MegaETH ERC-721 claim and Web2 only, HNS only,
or both access modes. Web2 is optional; the wizard uses Alchemy/Cloudflare to
manage it when selected. V1 setup choices are fixed upfront; later domain/HNS
changes are custom OSS migrations, not standard wizard functions. HNS-only still
depends on external MOSS and creator-wallet HTTPS services. Customer signup
implementation follows the first-song service path. The recovered
[operator protocol](docs/operator-protocol.md) owns admission/publication rules.
Its [payment specification](docs/operator-payments.md) is a published copy of
the active payment lane's design; that document's implementation-state section
describes the source branch recorded in its provenance, not this runtime.
[HNS resolution and ingress](docs/hns-community-ingress.md) puts actual HIP-5
client support before transport selection. It retains prior gateway evidence
and requires a separate instance if that HTTPS route is chosen.

Spaces support is deferred beyond the decentralized community MVP. The wizard
may show "Spaces — Coming soon" as a disabled option. Wizard v1 starts on
ordinary HTTPS as its first engineering slice, without making Web2 mandatory
for HNS-only communities. Spaces infrastructure and a
possible Cloudflare Containers port
are later work under the [namespace scope](docs/decentralized-setup.md#mvp-namespace-scope).

Our application contracts target MegaETH testnet 6343. Ordinary wallet access
uses MOSS. The active payment implementation uses OperatorPayments deposits
and signed purchases for admission jobs and karaoke segment takes. This main
baseline still contains the older local payment harness; the segment-payments
branch owns its replacement. Do not deploy that baseline or invoke its old
public-network harness. The present documentation change does not claim the
runtime migration is complete.

External Megapot operates on Base. That fact does not make Base a deployment
target for Pirate contracts. The reward prize source and production payout
route are undecided. A local pool experiment and external-provider fork tests
do not settle that decision.

## Local development

Use Node.js 24 and Foundry 1.9.0 with the pinned dependency lockfile:

```sh
npm ci --ignore-scripts
forge build
npm run check
```

On Linux, run the checks with only loopback after dependency installation:

```sh
unshare -Urn sh -c 'ip link set lo up && npm run check'
```

The local acceptance harness runs actual Worker handlers, cryptography,
WebSockets, SQLite persistence and Solidity on Anvil. Provider calls and payment
providers are explicitly simulated. Its synthetic audio and public fixture
keys are test material, never credentials for a public deployment. Local tests
exercise behavior; they do not prove hosted security or real provider results.

`npm run build` currently packages the local Worker using cf. The planned
community stack is provisioned by Alchemy.run. cloudflare.config.ts is a disabled
packaging template, not a production deployment. The harness supplies isolated
local runtime configurations. Hosted authentication, real clocks, removal of
debug routes, provider secrets and durable job reconciliation remain work.

## Current work

The [community browser contract](docs/community-web-client.md) specifies the
verified community application origins, separate same-origin cookie sessions, karaoke handshake,
publication-time pages and read-only IPFS mirrors. PR 9 adds a fixture-backed
static client under apps/web; it does not yet connect all real services.

The creator-wallet design in PR 10 adds operator-funded Sui/Ika setup and a
creator-owned EVM recipient for the separate Aeneid song-registration test.
It does not change ordinary MOSS participation or establish a production DATA
migration. Saved passkey access and reopen-and-sign acceptance remain to be
implemented. Provider keys stay with the operator that uses them.

The active payment branch replaces the service payment mechanism, moves
community state to D1 and adds a durable transaction sender. The setup wizard,
public-post/discovery contract, live publisher, provider adapters and complete
second installation are not built. Use the setup overview and task records
instead of assuming the existing local skeleton is ready to expose.

## Local reward and provider research

The existing RewardPool models one immutable drawing, signed registration,
fixed-recipient payout, conservation and emergency recovery. Allocations do not
expire after finalization. Its sponsored path requires the claimant's original
ECDSA key; ERC-1271 and delegated-key compatibility are not established.
The community verifier and selected Very attester remain trusted inputs.
See [the local pool contract](docs/reward-pool.md).

[External Megapot fork tests](docs/megapot-fork.md) read pinned provider code
and mutate only a local Foundry fork. They prove selected contract call shapes,
not live drawing delivery or a chosen reward route. The
[provider boundary](docs/megapot-boundary.md) records those limits.

A [Very diagnostic probe](docs/very-probe.md) and
[scope contract](docs/very-reward-scope.md) address credential nullifiers.
One recorded enrollment passed the diagnostic comparisons; it does not prove
one enrollment per person or complete reward eligibility. Follow the
[assurance limits](docs/very-assurance.md).

PROVENANCE.json records the copied scorer's source and changes. The experiment
has no runtime imports into the centralized API or SSR frontend. No licence
grant has been added to the experiment.
