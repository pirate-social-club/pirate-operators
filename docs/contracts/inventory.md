# Application contract inventory

This is a source inventory, not a deployment-address list or a deployment
approval. The supported target is Pirate-managed shared infrastructure.
Community operators receive application permissions, not responsibility for
registry deployments or contract administration. Name-holder and external TLD
owner rights remain separate from Pirate administration.

The [Web2 release plan](../self-hosting/checkpoint-1-pilot-delivery-20261114.md)
governs new deployment selection. Directory V3 is the Web2-first candidate;
Directory V2 is superseded for new deployments. First-song enrollment has no
learning-results target. Consent redesign and optional HNS/naming adoption remain
separate work; retaining earlier source does not select it for deployment.

## Source inventory and deployment boundaries

| Contract                     | Repository       | Responsibility                                                                                                                                            |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SharedNameRegistryV3         | pirate-registry  | ERC-721 SLD ownership, transfers, records, registration and renewal across admitted namespaces and communities.                                           |
| CommunityDirectoryV3         | pirate-operators | Web2-first identity, bounded registrar, revisioned address and separate verification/listing; explicit integration and deployment qualification required. |
| CommunityPostsV1             | pirate-operators | Published post references and revisions.                                                                                                                  |
| NamespaceVerifierAuthorityV1 | pirate-operators | Retained V1 namespace-service authority; not the V3 role configuration.                                                                                   |
| CommunityListingAuthorityV1  | pirate-operators | Retained V1 listing authority; not the V3 role configuration.                                                                                             |
| OperatorPayments             | pirate-operators | Community deposits and signed payments for operator work.                                                                                                 |
| LearningResultsV4            | pirate-operators | Retained origin-bound result/consent implementation; not selected for the new first-song profile.                                                         |

SharedNameRegistryV3 is feature-branch source, not an accepted deployed source.
At exact source56d63ad, release solc and separate Solar tests, generated ABI byte
comparison, types, Node tests and isolated shared acceptance with an independent
committed-source rebuild pass in CI43452867716. This verifies the contract
interface; downstream migration and application acceptance remain required. The retained V1 directory
derives community identity from a per-TLD registry and checks that
registry's factory/TLD interface. Pointing it at V3 is not a supported migration.
The bundled protocol-2 naming manifest is retained until an explicit accepted
source selection replaces it.

The [V4 sign-in](../learning-results-v4-sign-in.md) and
[V4 rollout](../learning-v4-rollout.md) documents describe retained source. V4 uses
explicit `/2` deployment and activation profiles in the maintained Study tools.
Their `/1` profiles describe the historical V3 rollout. A configured community's
pinned source and unresolved journals remain authoritative until an explicit
reviewed cutover; this inventory does not switch them.

## Additional application contracts

| Contract             | Status               | Responsibility                                                      |
| -------------------- | -------------------- | ------------------------------------------------------------------- |
| DanceVerdictsV1      | Dance feature source | Categorical Dance verdict lifecycle for one community.              |
| DanceCapturePolicyV1 | Dance feature source | Stateless capture-policy validation pinned by the verdict contract. |
| RewardPool           | Separate experiment  | One drawing with signed registration, payout and recovery.          |

The [Dance source contract](dance-verdicts-v1.md) describes the two concrete
Dance contracts. Their presence in source does not establish deployed Dance
acceptance. RewardPool is not a required naming or learning deployment.

## Historical implementations

| Contract          | Repository       | Retained purpose                                                               |
| ----------------- | ---------------- | ------------------------------------------------------------------------------ |
| SLDRegistry       | pirate-registry  | Existing per-TLD names, ownership, records and locked renewal terms.           |
| RegistryFactory   | pirate-registry  | Provenance and verification of the older per-TLD registry deployments.         |
| LearningRecords   | pirate-operators | Original per-line learning records and their historical verification.          |
| LearningResultsV2 | pirate-operators | Earlier compact results and source-bound history.                              |
| LearningResultsV3 | pirate-operators | Earlier enrollment-consent results, in-progress work and source-bound history. |

These are retained implementations, not choices for new integrations. Preserve
original ABIs, source, deployment manifests, consent policies and transaction
journals needed to verify or reconcile existing state. Historical verification
is distinct from offering predecessor deployment as normal community setup.
Do not reinterpret an older name, result or authorization as a newer version.

The `megaeth:records` command and `harness/megaeth/deploy-results-v2.ts` are
historical testnet measurement/rehearsal tools, not the current learning setup.
Use the V4 rollout's reviewed `/2` profile rather than substituting a new ABI or
contract name into these older scripts.

## Testnet helpers and exclusions

| Contract                   | Repository       | Purpose                                      |
| -------------------------- | ---------------- | -------------------------------------------- |
| PirateTestUSD              | pirate-registry  | Valueless test currency.                     |
| DisabledDiscoveryAuthority | pirate-operators | Permanently unlisted disposable communities. |

There are 15 concrete application contract definitions in this combined source
inventory, including the undeployed V3 branch and the two Dance contracts.
The earlier count of 13 omitted those Dance contracts. The two testnet helpers
are separate. Libraries, interfaces, abstract bases and test mocks are excluded.
Counts describe source definitions and do not describe deployed addresses.

## Retirement boundary

Remove predecessor paths from normal setup only after migrating their actual
callers. Naming needs namespace-aware community identity, directory validation,
resolver/SDK selection and an accepted holder-preserving migration before a
source switch. Existing names retain their terms and history. Learning source
selection must preserve old results, consent/disclosure bindings, open lessons,
offers and pending transactions. Deleting predecessor Solidity files would not
perform either migration.

Deployment evidence and frozen source/digest records remain unchanged. No
funding, deployment, reward activation or authority change follows from this
inventory.
