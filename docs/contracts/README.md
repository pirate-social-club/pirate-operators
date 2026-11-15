# Decentralized contract boundaries

Current delivery decision, November 14: the [Web2 release plan](../self-hosting/checkpoint-1-pilot-delivery-20261114.md)
supersedes HNS-required registration/discovery and combined login/publication
consent below. Web2 and HNS communities share the same on-chain identities and
publication/discovery rules. The first-song profile disables learning-results.
The baseline [PR58](https://github.com/pirate-social-club/pirate-operators/pull/58)
at `9374f4c`, Directory [PR56](https://github.com/pirate-social-club/pirate-operators/pull/56)
at `aef30d0`, and consent [PR59](https://github.com/pirate-social-club/pirate-operators/pull/59)
at `c6c98cb` are merged and CI-qualified source. First-song application/runtime
and selected-host acceptance remain unqualified. V5 and Dance V2 stay inactive
pending application and policy gates; listing-service and indexer acceptance
remain separate work.

The [application contract inventory](inventory.md) is the current entry point.
It distinguishes the supported target from retained predecessor implementations,
the separate reward experiment and testnet helpers. It also records the shared
naming cutover gates and the retained V1 and inactive V2 Dance pairs.

Pirate manages shared contract infrastructure. Community operators use
application permissions. Name-holder ownership and external TLD authority remain
separate from infrastructure administration. SharedNameRegistryV3 has an accepted
compiled source boundary; this does not establish deployment or adoption of a
new naming successor. Web2 enrollment does not require naming.
[Directory V3](community-directory-v3.md) is the explicit Web2-first enrollment
source foundation. Optional HNS naming requires its own verified attachment and issuance
authority; existing manifests and deployments are not silently migrated.

The first-song profile has no learning-results target. The merged
[separate publication-consent specification](publication-consent-v1.md) defines
the inactive V5/Dance V2 foundation, not an activated application profile. The
[V4 sign-in specification](../learning-results-v4-sign-in.md),
[V4 rollout](../learning-v4-rollout.md), LearningRecords and LearningResultsV2/V3
remain retained source and history, not alternative new-community setup paths.
Preserve their original policies, result identities and pending journals.

## Contract responsibilities

[Community directory](community-directory.md) owns community configuration and
publisher authorization. [Posts](community-posts.md) stores published references
and revisions, not raw media. [Namespace authority](namespace-verifier-authority.md)
and [listing authority](community-listing-authority.md) separate namespace
attestation from discovery control; delisting affects discovery.

[Operator payments](../operator-payments.md) handles deposits and signed work
payments. Its spending-cap limitation remains a separate finding. A learning
result or Dance verdict does not itself authorize payment or fund a reward.
[Dance verdicts](dance-verdicts-v1.md) use a separate capture-policy validator.
[RewardPool](../reward-pool.md) remains an independent drawing experiment.

The [implementation profile](community-implementation.md),
[disposable profile](disposable-first-song.md),
[media boundary](media-publication.md) and [feed indexing](feed-indexing.md)
describe their respective interfaces. Historical LearningRecords source and
[digest record](learning-records-source.json) remain unchanged. A source or ABI
specification is not evidence of a deployed and accepted community.

## Setup and migration

The [setup plan](../decentralized-setup.md) describes the existing HTTPS path.
Its per-TLD registry prerequisites reflect the retained deployment model, pending
the shared-registry caller migration; do not create a new clone as a shortcut to
shared naming. The wizard and directory cannot switch merely by substituting a
V3 address for an old registry address.

New selection requires accepted build and ABI evidence, migrated directory and
client interfaces, and explicit treatment of existing holders, locked renewal
terms, community identities and historical post references. Preserve existing
deployment manifests and original transaction reconciliation sources throughout
the cutover. No deployed address, authority, reward setting or funds are changed
by this documentation.
