# Decentralized contract boundaries

Proposed interface slice, 2026-11-04. The workspace_owner requested explicit
contract boundaries and confirmed human Dance review. This slice defines the
first-song directory and post ABIs, content publication and feed projection.
It does not implement or deploy those contracts. The existing
[setup plan](../decentralized-setup.md) and [operator protocol](../operator-protocol.md)
retain their admission, creator activation and registration gates.

## Inventory and authority

| Area                       | Authority and responsibility                                                                                               | Inspected state / next boundary                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SLD naming                 | TLD owner delegates through HNS; registry admin controls sale policy; SLD holder or record manager controls app records.   | `pirate-registry` implements SLDRegistry and RegistryFactory. Testnet rehearsal exists. Factory provenance does not prove TLD ownership.                                               |
| Community directory        | Pirate verifies namespaces and selects listings. Community controls its own config and publisher.                          | [Directory ABI and authorization](community-directory.md) proposed here; no implementation.                                                                                            |
| Rules and roles            | Community controls admission policy; LearningRecords owns public qualification-policy activation and grader authorization. | No separate governance contract required for first song. Future delegated roles belong to community authority, not Pirate's listing administrator.                                     |
| Song and video publication | Community publisher submits admitted, immutable content references under a scoped author ID and pays gas.                  | [Post ABI](community-posts.md) proposed here; video admission still needs its own policy. No media in contract storage.                                                                |
| Comments                   | Community-local author and content policy.                                                                                 | On-chain representation remains open. No comment ABI or automatic public pinning is introduced.                                                                                        |
| Operator work payments     | Community purchase authority buys bounded operator work.                                                                   | OperatorPayments and per-line accounting live on the active segment-payments branch; not reimplemented here.                                                                           |
| Study, Karaoke and Dance   | Typed assessment records; distinct graders, including human owner review for Dance.                                        | [LearningRecords draft](learning-records.md) and [assessment adapters](assessments-rewards.md); public wallet-linked records are specified, with no grade-contract implementation yet. |
| Daily qualification        | Sponsor-approved verifier evaluates frozen task policy, deduplicates entries and commits a drawing root.                   | Karaoke policy already specifies periods, thresholds and retry deduplication. Multi-task acceptance and assessor authorization need an extension.                                      |
| Reward pots and bridge     | Separate funding, custody, purchase, bridge reconciliation and claim accounting.                                           | Existing RewardPool is a local single-sponsor/single-drawing experiment. Cross-chain/shared-pot replacement is not implemented or ratified by this slice.                              |

The directory stores the canonical community-approved config pointer and hash,
not editable copies of every rule. A later community governance contract may
become its controller; it would authorize updates through the same interface.
There must remain one current config revision, not competing policy pointers
owned by Pirate and the community. Delisting changes discovery only.

## Content and read path

```mermaid
flowchart LR
  U[Community user] --> C[Community API and D1 jobs]
  C --> R[Private R2 upload and sealed evidence]
  R --> A[Real admission gate]
  A --> I[Public admitted assets and manifest on Filebase IPFS]
  I --> P[MegaETH post reference and event]
  D[MegaETH directory and signed community config] --> G[Goldsky event indexing]
  P --> G
  G --> F[Aggregate feed projection and API]
  F --> B[Community or aggregate client]
  I --> B
```

The registration adapter has separate activation and confirmed-receipt states;
it is omitted from this storage diagram for readability, not removed as a
first-release dependency. Song bytes are stored in the media layer; DATA is
the external asset-registration boundary. Neither a CID nor a MegaETH post
receipt establishes IP registration. See [media publication](media-publication.md).

[Goldsky indexing](feed-indexing.md) can build per-community and aggregate feeds
from the events. A subgraph is already an available option, not dependent on a
future chain launch. Indexing cannot supply missing bodies, authorize authors,
prove HNS control, grade a performance or enforce eligibility for Pirate funds.

## Order of implementation

First implement and test directory authorization, namespace verification and
post publication; connect the existing creator flow, upload/seal/admission
jobs, real providers, DATA testnet registration and feed reads. Prove setup,
app.tld login, interrupted resume and one real admitted song playing after
reload. This is the first milestone. Admission here means pre-publication
evidence and the publication gate, not a new moderator dashboard.

Then implement LearningRecords with actual graders, learner consent, public
wallet-linked history and the agreed shared learning clock. Its manifest
coverage, payment-status mapping and categorical/non-line adapters need
implementation design before an ABI is fixed. Human Dance review alone grants
no Pirate-funded reward authority. Later roles remain community-controlled.

Finally define and implement multi-task qualification, the adopted funding/pot
model, Base custody if approved, and a measured bridge route with recovery.
Comments, Base custody, Dance eligibility for Pirate-funded drawings and
decentralized adoption of the centralized shared-pot/open-funding direction
remain explicit decisions.
They do not block writing or implementing the directory and post contracts.

## Source baseline

This slice starts from operators guidance `3d44fd8`, with the restored protocol.
It also inspected payment source `0dec600`, registry source `296c97d`, static
client `388018f` and creator design `9c7899b`. These are separate lanes and
maturity levels. The branch integrates guidance successor `f8f8d17` before
publication. The later owner-approved LearningRecords draft 2 is preserved
byte-for-byte with a [source digest](learning-records-source.json); its task
record distinguishes decisions from implementation checks. A branch SHA is not
evidence that GitHub reviewed or tested it.

New ABI source is under `contracts/interfaces/community/`; the
[source index](../../contracts/README.md) records existing ownership. Existing
`packages/protocol/` is retained. No active payment or frontend file moves,
new provider account, deployment or funded operation belong to this slice.
