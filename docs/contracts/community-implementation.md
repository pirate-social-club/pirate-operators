# Directory and post implementation profile

This branch implements the reviewed directory and shared post interfaces from
PR 12 at 539c94d. Existing payment, learning, registry and reward implementations
remain separate. The new contracts are local source with behavioral tests; no
live addresses or completed first-song integration are asserted.

## Deployment inputs and trust

`CommunityDirectoryV1(factories, verifier, listing, maximumAge)` has no owner,
upgrade mechanism or mutable factory set. Select and review these inputs in an
explicit chain/deployment manifest before deploying.

| Input        | Enforced by the constructor                                                                                                               | Acceptance outside this local test                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `factories`  | Nonempty list of distinct contracts, each reporting a deployed implementation. Pins both code hashes and the standard clone runtime hash. | Verify the exact RegistryFactory and SLDRegistry artifacts, initialization/label rules and addresses on the target chain. Never approve an upgradeable or arbitrary factory based only on its getters. |
| `verifier`   | Address with code, distinct from listing.                                                                                                 | A governance account with signer rotation and independent recovery; prove the actual account's authority and recovery. Code presence alone does not prove governance semantics.                        |
| `listing`    | Address with code, distinct from verifier.                                                                                                | A bounded listing authority under a separate recoverable Safe, with a delist-only emergency key; qualify actual incident response.                                                                     |
| `maximumAge` | Nonzero uint64 seconds; bounds the complete observedAt-to-validUntil interval.                                                            | Choose the false-evidence security ceiling and prove refresh/reader budgets fit. The fixture's one-day bound is not a selected deployment policy.                                                      |

`CommunityPostsV1(directoryAddress)` requires a directory address with code and
stores it immutably. Deployment acceptance must verify that address and its
reviewed bytecode/profile; code presence does not prove the intended interface.
Neither constructor creates an account, deploys a registry, funds gas or enables
any rewards. The application target remains MegaETH testnet 6343; tests use the
local chain. This slice includes no deployment script or public-chain write. The
separate [Safe code observation](governance-accounts.md#testnet-code-observation)
is read-only evidence about candidate governance infrastructure.

The recommended `verifier` input is the stable address of
[NamespaceVerifierAuthorityV1](namespace-verifier-authority.md), administered by
a recoverable Safe with a rotatable service key restricted to verification.
The `listing` input is a distinct
[CommunityListingAuthorityV1](community-listing-authority.md): its own governance
Safe controls normal listings and a separate emergency key can only delist.
Both are proposed new dependencies, not implemented by this PR. The directory
ABI already accepts their contract addresses; the existing governance fixture
does not prove their behavior.

For a deployment intended to support listings, implement/review both authorities
and pass local integration before deploying the directory. Create them unbound,
deploy the directory with their addresses, then let each governance Safe bind
its authority once. Prove signing, key revocation/recovery, emergency delisting,
reader suppression and refresh before enabling live listings.

The separately labelled [disposable first-song profile](disposable-first-song.md)
uses two distinct inert authority contracts instead. It can never verify or list
communities, and it does not wait for Safe custody or the real authority contracts.
This is a permanent restriction, not a placeholder upgrade path. A later
listing-capable deployment has a different posts address and different song keys.
The governance acceptance column above applies to that later profile.
For that listing-capable deployment, select maximumAge as the immutable security
bound described in the
[age policy](namespace-verifier-authority.md#evidence-age-as-a-security-bound),
not solely to match an affordable renewal schedule.

## On-chain enforcement

Registration checks the current registry admin and factory membership, the
pinned factory/implementation code, and the exact standard
[ERC-1167 runtime](https://eips.ethereum.org/EIPS/eip-1167) for that implementation.
It then reads the registry's TLD and hashes its existing canonical label. The
inspected factory uses this clone profile; another proxy format is not silently
accepted. The constructor's FactoryApproved events and factoryProfiles getters
make the selected profile observable. External identity getters are static
calls. No Pirate attestation is required to register or publish.

Only the current controller can configure or propose/cancel a transfer. The
receiving account must accept the exact configuration, proposal and revision by
the deadline. Proposal IDs never reset. Successful configure/accept clears any
pending proposal and stales the former namespace verification. Listing and
verification have independent revisions and cannot change community authority.
The contract treats HNS evidence as a trusted verifier attestation, not a light
client proof. Namespace revocation still requires the verifier/listing service.

Posts check the current directory revision and publisher every time. They keep
immutable author/kind and monotonic revisions per community/post. Listing status
never grants publication authority. State getters expose the latest revision;
events contain the complete publication references and configuration history.
No JSON, media, author-wallet mapping, grades or reward funding is stored here.
Both Song and Video enum values are accepted structurally; the publisher must
still refuse Video until its admission policy is approved.

## Recovery boundaries

A publisher can append forged revisions to every existing post, as well as
create forged posts. Rotation only stops future authority. The config-manifest
[revocation policy](community-posts.md#publisher-compromise-and-recovery) tells
readers which historical publisher/block ranges to quarantine. It is enforced
by the feed/publication service, not these contracts: `getPost` still returns
the latest on-chain revision. The replacement publisher restores content by
appending to that counter. The event-reduction tests in this PR establish raw
state reconstruction, not this manifest-aware recovery projection.

An EOA controller is acceptable for testnet first-song completion, but has no
protocol recovery after unrecoverable key loss or takeover. The wizard must
track a handoff and require verified recovery before mainnet or real-user
onboarding, separately from testnet completion. Code presence or a wallet brand
does not prove that property. A new registry/communityId is the per-community replacement route
within the current shared deployment, with no automatic post/streak migration.
See the [bootstrap and recovery requirements](community-directory.md#operator-bootstrap-and-recovery)
and [Safe candidate](governance-accounts.md). Pin and verify every config body
before its transaction under the [publication lifecycle](community-directory.md#configuration-publication-lifecycle).
No ABI or runtime change is implied by these operational requirements.

## Reference profile

The shared validator accepts at most 512 bytes with the exact `ipfs://` scheme,
a CIDv0 base58-shaped root or CIDv1 lowercase base32-shaped root, and an optional
ASCII path. Paths permit letters, digits, hyphen, underscore, tilde and dot in
nonempty segments; empty segments, `.`/`..`, percent escapes, queries, fragments,
whitespace and control bytes are refused. Prefer a bare content CID for each
manifest. Normalize other valid URI representations in the service before
submission rather than relying on gateway interpretation.

These are bounded reference-shape checks, not a multicodec/multihash decoder.
They do not prove that a syntactically shaped root is a valid CID, that content
exists or that its supplied SHA-256 matches. The publisher and namespace service
must fully decode/retrieve/verify the CID, exact bytes and JCS identity fields.
The publisher is already trusted for admission and scoped author attribution;
accepting its transaction does not establish those service checks.

## Local evidence and remaining acceptance

The Foundry suite covers forged provenance and code changes, unauthorized
bootstrap/configuration, transfer expiry/replacement/cancellation/replay,
configuration and verification revisions, freshness boundaries, signer rotation
and recovery through fixture accounts, publisher revocation, delisting without
publication control, immutable post identities, community isolation and URI
bounds. Independent log reductions reconstruct the directory and latest post
and compare them with contract getters. Fuzz cases exercise stale revisions,
late acceptance, unauthorized publishers, arbitrary post IDs and control bytes.

The disposable-profile tests use the actual empty authority contract twice and
the existing registry identity fixture. They prove publication and publisher
rotation while undiscoverable, controller handoff without listing authority,
and rejection of arbitrary callers and calldata. They do not prove a real
registry deployment, provider admission or live first-song playback.

The test factory deploys actual standard clone runtime with a deliberately
simplified identity implementation. It is not the full naming registry. The
mock governance account tests contract-level sender/rotation behavior, not the
real MOSS first transaction or a production account's recovery. These tests
cannot replace deployment against the reviewed registry artifacts and actual
accounts on the target chain.

Still required are a namespace verifier with retained real HNS evidence,
complete JSON/CID and admission validation, durable upload and publication jobs,
reorg-aware indexing, actual account/fee acceptance, creator activation and
registration, browser integration, and a real admitted song playing after
reload. Existing copied learning and payment specifications keep their exact
source digests. Public grades, comments, Dance eligibility and reward funding
are outside this implementation.
