# Pirate operators

A standalone experiment for independently operated communities, song admission,
karaoke and operator payments. The [setup-to-first-song plan](docs/decentralized-setup.md)
explains the first milestone: ordinary HTTPS, a genuine registry, community
configuration, Alchemy.run provisioning, Infisical, real moderation and first
publication. Native app.tld/browser acceptance is a separate follow-up.
Sponsored customer name purchases are later work. The recovered
[operator protocol](docs/operator-protocol.md) owns admission/publication rules.
The [payment specification](docs/operator-payments.md) is pinned to the merged
main baseline in its [source record](docs/payment-specification-source.json).
Its original implementation-state notes are dated; the runtime and current
integration limits below take precedence over those status observations.
[HNS resolution and ingress](docs/hns-community-ingress.md) puts actual HIP-5
client support before transport selection. It retains prior gateway evidence
and requires a separate instance if that HTTPS route is chosen.

Spaces support is deferred beyond the decentralized community MVP. The wizard
may show "Spaces — Coming soon" as a disabled option. Wizard v1 starts on
ordinary HTTPS, with HNS as an optional follow-up. Spaces infrastructure and a
possible Cloudflare Containers port
are later work under the [namespace scope](docs/decentralized-setup.md#mvp-namespace-scope).

Our application contracts target MegaETH testnet 6343. Ordinary wallet access
uses MOSS. The active payment implementation uses OperatorPayments deposits
and signed purchases for admission jobs and karaoke segment takes. Payments
and [LearningRecords](docs/learning-records-contract.md) are merged from PRs 14
and 18, with separate [testnet evidence](docs/megaeth-testnet.md). This does not
establish a deployed first-song application or real managed moderation. The
payment signer can choose any recipient and amount within its community/token
deposit; admin-controlled recipient and spending limits are not implemented.
OperatorPayments is optional for the disposable first-song path.

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
stable community HTTPS origin, same-origin cookie sessions, karaoke handshake,
publication-time pages and read-only IPFS mirrors. PR 9 adds a fixture-backed
static client under apps/web; it does not yet connect all real services.

The creator-wallet design in PR 10 adds operator-funded Sui/Ika setup and a
creator-owned EVM recipient for the separate Aeneid song-registration test.
It does not change ordinary MOSS participation or establish a production DATA
migration. Saved passkey access and reopen-and-sign acceptance remain to be
qualified across supported devices. PR 13 records an owner-reported real-
browser activation/reopen/sign pilot with independently checked chain/signature
evidence; broader browser/device and actual registration acceptance remain open.
Provider keys stay with the operator that uses them.

The merged [account and portability design](docs/community-accounts-portability.md)
separates private account IDs, credential bindings and public authors. It is
specified, not implemented; the current runtime remains wallet-keyed. Payments
use the D1 community store and durable operator transaction sender, but the
complete publication-job schema and first-song orchestration are still missing.

PR 15 implements the provisioning wizard and records disposable infrastructure
recovery acceptance. Its latest launcher still needs independent review and a
first live startup qualification. PRs 12 and 17 separately specify and implement
the directory/posts profile; they are not merged or deployed here. Current c22
stays independent for storage/job testing. First-song acceptance needs a new
managed-mode community, its own TLD fixed before initial deployment and its own
operator-controlled registry clone before contracts qualification. The wizard
does not create that clone. Managed moderation, real registration, publication
and fresh-browser playback remain unfinished in their owning lanes.

## Local reward and provider research

The existing RewardPool models one immutable drawing, signed registration,
fixed-recipient payout, conservation and emergency recovery. Allocations do not
expire after finalization. Its sponsored path requires the claimant's original
ECDSA key. Exact EIP-7702 delegation markers are supported; delegated session
keys, ERC-1271 and other contract-wallet signatures are not supported.
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
