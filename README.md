# Pirate operators

The [compact public results amendment](docs/learning-results-v2.md) sets the
next recording/payment direction: one terminal result per lesson or run,
internal usage accounting for Pirate's own service and guaranteed coverage for
independent providers. [Learner-held history](docs/learner-history.md) defines
the private tutoring/export boundary. These specifications do not change the
current v1 runtime or resolve the MOSS consent release gate.

For launch, the workspace owner is the only song publisher.
[Owner-only MegaETH song publication](docs/megaeth-song-publication.md) is the
active launch contract: the owner signs in with the ordinary MOSS account and
publishes a pirate.community-post/3 song under policy
pirate-owner-curated/2026-11-08/1, with no DATA registration, Ika activation,
creator wallet or Royalties step. Media and lyrics stay off-chain. That is
Release 1. Palm-verified publishing by other users is a separate later release
and is not implemented. Registration, creator-wallet and royalty material below
describes the completed registered journey or deferred integration work.

A standalone experiment for independently operated communities, song admission,
karaoke and operator payments. The [setup-to-first-song plan](docs/decentralized-setup.md)
explains the first milestone: ordinary HTTPS, a genuine registry, community
configuration, Alchemy.run provisioning, Infisical and first publication. The
current owner-curated acceptance run follows the
[explicit moderation-deferral policy](docs/owner-curated-first-song.md), with
operator-declared rating/language and genuine retained audio recognition.
Native app.tld/browser acceptance is a separate follow-up.
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
establish completed first-song acceptance. The
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
local runtime configurations. The separate first-song application has reviewed
Alchemy packages, hosted MOSS authentication, private storage and durable
publication journals. Its current qualification is recorded below.

## Current work

The [community browser contract](docs/community-web-client.md) specifies the
stable community HTTPS origin, same-origin cookie sessions, karaoke handshake,
publication-time pages and read-only IPFS mirrors. The apps/web project retains
its fixture-backed static/mirror release and separately builds the live community
client. The live client connects MOSS, private master and fixed-slot stem
uploads, job status and public song playback. Under the owner publishing policy
only the controller-authorized owner account is shown release controls, and the
release routes refuse every other account before any reservation. The launch
client has no creator wallet connection step; the server's creator connection
routes are preserved for the deferred integration.

Deferred for launch: the creator-wallet design in PR 10 adds operator-funded Sui/Ika setup and a
creator-owned EVM recipient for the separate Aeneid song-registration test.
It does not change ordinary MOSS participation or establish a production DATA
migration. Saved passkey access and reopen-and-sign acceptance remain to be
qualified across supported devices. PR 13 records an owner-reported real-
browser activation/reopen/sign pilot with independently checked chain/signature
evidence. The first-song creator has now signed in, reopened that saved wallet
and submitted the selected recording. Broader browser/device acceptance and
production service guarantees remain open. The selected real song is now
ROOT-registered to that creator wallet.
Provider keys stay with the operator that uses them.

The merged [account and portability design](docs/community-accounts-portability.md)
separates private account IDs, credential bindings and public authors. The
application now implements those boundaries, stable post/lyric identities and
explicit D1 migrations. Sealed uploads and publication jobs retain immutable
inputs, provider receipts, prepared external operations and reconciliation
proofs. These additions do not implement the entire portability specification.

PR 15 implements the provisioning wizard and records disposable infrastructure
recovery acceptance. Its launcher has independent review and live startup
qualification for the new managed-mode community. That community has its own
fixed TLD, operator-created registry clone, deployed directory/posts profile and
exact deployment manifests. The wizard does not create the registry clone or
automate those contract transactions. c22 stays independent for storage/job tests.

Draft [PR 26](https://github.com/pirate-social-club/pirate-operators/pull/26)
integrates the prerequisite sources and first-song application. The
[owner-curated rollout](docs/owner-curated-rollout.md) is live and independently
qualified. [Actual first-song acceptance](docs/deployments/first-song-managed-20261105.first-song-acceptance.json)
records both sealed stems, five verified public pins, one Aeneid ROOT registration,
one MegaETH post and anonymous playback after reload. Health reports firstSong:
ready. The selected recording was submitted with the title "Test"; its sealed
metadata is preserved. Its original held admission and three provider receipts,
including the classifier refusal, remain unchanged beside the append-only
owner-curated decision. Automated content moderation is deferred; the refusal
was not converted into a successful automated check. The [delayed-recovery
update and same-amendment replay](docs/deployments/first-song-managed-20261105.published-recovery-rollout.json)
also passed with unchanged table hashes, signer nonces and one post. Current
public read latency is about 19–31 seconds and still needs improvement.

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
