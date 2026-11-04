# MegaETH aggregate feed

Yes: directory and post events can drive a community feed and a Pirate
aggregate feed. Goldsky is the proposed event-indexing service. The feed is
a rebuildable read model over canonical publications and verified public
manifests; it is not another ownership or eligibility authority.

## Current service choices

The [Goldsky MegaETH documentation](https://docs.goldsky.com/chains/megaeth)
lists Turbo and Subgraphs for both mainnet and testnet. These identifiers
belong to different products:

| Network         | Chain ID | Subgraph network     | Turbo chain slug     |
| --------------- | -------- | -------------------- | -------------------- |
| MegaETH mainnet | 4326     | `megaeth-mainnet`    | `megaeth_mainnet`    |
| MegaETH testnet | 6343     | `megaeth-testnet-v2` | `megaeth_testnet_v2` |

Use testnet for the admitted implementation. Mainnet support is documentation,
not deployment authority. Partner sponsorship requires approval; no free usage
is assumed. That chain page does not provide MegaETH Edge RPC or Compose, so
this design depends on neither. Recheck service support at deployment time.

Turbo can stream into a supported database sink, with a feed API and a separate
manifest-hydration worker. Select and pin the actual MegaETH dataset/version
and deployment start block after contracts exist. Do not invent a dataset name
by appending an event to the chain slug. The example PostgreSQL sink does not
establish a native D1 sink; community D1 and the aggregate read store have
different jobs. The exact aggregate sink is an implementation choice to verify.

A subgraph can instead expose the indexed entities through GraphQL. Deploy it
from a local schema/mappings or start from the contract ABI with Goldsky's
instant-subgraph option. Subgraphs need not wait for a later migration; Turbo
first and a subgraph later is a choice, not a requirement to run two indexers.
ABI-only generation exposes raw events but does not implement the full product
projection, metadata validation or visibility rules described below.

## Event and entity requirements

Directory events identify a community and registry, every config revision and
URI/hash, namespace verification and expiry, and each listing revision. Post
events include communityId, postId, scoped authorId, kind, post revision,
configuration revision and manifest URI/hash. Both proposed interfaces expose
these fields without fetching transaction sender as the author.

Retain raw logs keyed by chainId, contract address, blockHash, transactionHash
and logIndex. Retain block number, transaction index and canonicality so order
is deterministic. Build current state by canonical event order; never by the
service-declared publishedAt field. Post revisions use a separate logical key
`(chainId, postsContract, communityId, postId, revision)` and can be replaced
when a reorg changes canonical history. Deduplicate delivery without discarding
the evidence needed to undo an orphaned event.

The projection stores Community, ConfigurationRevision, NamespaceVerification,
ListingRevision, Post and PostRevision entities, plus hydration status. Query
per explicit community ID independently of listing; Pirate aggregate discovery
includes only currently discoverable communities. Unverified claims must not
appear as verified TLD communities. Use a stable cursor
containing canonical ordering keys and post identity; define a snapshot height
and restart behavior if a reorg invalidates the cursor. Expose provisional versus
confirmed ingestion status and a last-processed block, not a false finality claim.

Namespace freshness must also be evaluated at query time or through expiry jobs:
an unexpired record can become expired without emitting another event. Reorgs,
config changes, expiry and delisting update feed visibility. Historical post
records remain available as history rather than being mistaken for active
directory entries. Explicit future hide/restore events need corresponding
projection rules when their authorization model is added.

## Manifest hydration

Decode only logs from the pinned deployment addresses and expected ABI/network.
Fetch the referenced immutable manifest, cap response bytes and processing time,
verify its SHA-256 and schema, and compare chain/community/post/author/revision
fields with the event. Apply current display policy, including rating and cover
withholding. Missing content remains pending/unavailable; it is not replaced by
unverified JSON from a community endpoint.

Treat manifests as untrusted input. Resolve `ipfs://` through configured gateways,
not arbitrary URLs into internal networks. Reject unsupported schemes, redirects
outside the configured policy, oversized bodies and executable markup. Preserve
content hashes and escaped display text. No private admission capability is
ever an aggregate metadata URL. A compatible IPFS resolver can replace Filebase
for retrieval without changing the on-chain reference.

The on-chain publisher is trusted for its admission assertion. Goldsky does not
prove the media passed a real provider check. Pirate may apply stricter aggregate
display policy without changing the community's records. Future prize funding
likewise requires its own eligibility policy, regardless of directory listing.

## Acceptance before a live feed

The separate [LearningRecords draft](learning-records.md) adds public assessment,
completion, eligibility and prospective policy-activation events for streak
boards. Discover its and OperatorPayments' addresses through directory config,
retaining address history. Keep board qualification separate from Pirate-funded
drawing eligibility. Local song boards use stable publication tuples, with
external registrations
only as policy-controlled cross-community grouping references. The proposed
Dance clock uses the first final owner decision's canonical block time; late
reviews do not take their upload period. Public history plus referenced
policies must be sufficient
to rebuild a board without a private API. Its two-independent-reducer acceptance
at an identical head/evaluation time is required later; a working post feed
does not establish that acceptance.

Replay from the deployment blocks into an empty read store and reproduce the
same state. Exercise duplicate delivery, missed ranges, out-of-order arrivals,
reorg rollback, expired namespace evidence without a new block event, listing
changes, config/publisher rotation and multiple post revisions. Verify manifest
tampering is withheld, unavailable content retries without corrupting state,
pagination is stable and one admitted song plays in its community after reload.

No Goldsky pipeline or subgraph is deployed by this slice. The interfaces are
not deployed addresses, and there is no honest working pipeline YAML until its
source dataset/version, start blocks, ABI and sink have been selected and tested.
