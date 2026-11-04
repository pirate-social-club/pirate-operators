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
| `listing`    | Address with code, distinct from verifier.                                                                                                | A separate governance account and operational listing policy.                                                                                                                                          |
| `maximumAge` | Nonzero uint64 seconds; bounds the complete observedAt-to-validUntil interval.                                                            | Choose the observation freshness and refresh service budget. The fixture's one-day bound is a test parameter, not a selected production policy.                                                        |

`CommunityPostsV1(directoryAddress)` requires a directory address with code and
stores it immutably. Deployment acceptance must verify that address and its
reviewed bytecode/profile; code presence does not prove the intended interface.
Neither constructor creates an account, deploys a registry, funds gas or enables
any rewards. The application target remains MegaETH testnet 6343; tests use the
local chain. This slice includes no deployment script or public-chain operation.

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
