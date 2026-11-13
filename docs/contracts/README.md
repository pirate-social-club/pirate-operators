# Decentralized contract boundaries

The [application contract inventory](inventory.md) is the current entry point.
It distinguishes the supported target from retained predecessor implementations,
the separate reward experiment and testnet helpers. It also records the shared
naming cutover gates and the two concrete Dance contracts.

Pirate manages shared contract infrastructure. Community operators use
application permissions. Name-holder ownership and external TLD authority remain
separate from infrastructure administration. SharedNameRegistryV3 is implemented
on its feature branch but has not been accepted, deployed or adopted downstream.
The directory and callers still require namespace-aware migration before using
one shared registry across communities.

LearningResultsV4 is the target for new learning integrations. Follow the
[V4 sign-in specification](../learning-results-v4-sign-in.md) and
[V4 rollout](../learning-v4-rollout.md). LearningRecords and LearningResultsV2/V3
remain historical sources; they are not alternative new-community setup paths.
Retain their original source, policies, result identities and pending journals.

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
