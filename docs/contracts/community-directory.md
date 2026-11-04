# Community directory V1

This is the proposed contract for
[ICommunityDirectoryV1](../../contracts/interfaces/community/ICommunityDirectoryV1.sol).
An interface does not enforce these rules. Implementation and adversarial tests
are required before deployment.

## Identity and state

One deployment indexes registries on its own chain. The stable community ID is
`keccak256(abi.encode(block.chainid, registry))`. The registry address and
`tldHash = sha256(UTF8(canonical TLD label))` are immutable for that entry.
Canonical labels follow the naming registry's accepted label rules, not a new
normalizer. The factory must be approved and `isRegistry(registry)` must hold;
read `registry.factory()` and `registry.tld()` as well. These code/provenance
checks do not establish HNS delegation or ownership.

Registry replacement creates another ID in V1. Migrating its history or claiming
it replaces an old community requires an explicit future migration policy.
Never silently reuse an old ID after an HNS delegation change. Duplicate TLD
claims can exist in chain history; discovery chooses only the currently verified
binding. A directory migration also requires an explicit deployment manifest.

Configuration contains the controller, publication account, OperatorPayments
and LearningRecords contract addresses, URI and SHA-256
digest of the exact JCS bytes at that URI. The public manifest identifies schema
`pirate.community-config/1`, chain/directory/community/registry/TLD, app label
and token generation, canonical session/API origin, ordinary HTTPS alias if
used, HNS ingress choice, public feed endpoint/signing-key ID, controller,
publisher, those contract addresses, and versioned policy references. The two
later contract addresses may be zero during first-song setup; clients must
disable the corresponding operation rather than infer a deployment. Nonzero
addresses must have code on this chain and their selected deployment/interface
must be verified. Indexers retain address history and start blocks across
changes; changing a pointer does not erase prior records. Private provider credentials,
wallet-to-author mappings and deployment state do not belong in it.

The service and verifier check redundant manifest fields against chain state;
the contract cannot fetch JSON. Every URI is a bounded immutable `ipfs://`
reference, at most 512 UTF-8 bytes, with no query or fragment. Require nonzero
controller, publisher and content hash. The deployment fixes the supported
factory set and the namespace-verifier and listing-authority accounts; no
unbounded super-admin or upgrade path is implied. Use governance accounts with
their own key recovery if needed. The interface defines no Pirate override of
community control and no lost-community-key recovery bypass.

## Authorization and replay protection

Only the configured namespace verifier may register an entry, after independently
checking current HNS authority, app control and the proposed configuration.
The initial controller must also consent to that exact record. Registration is
once per community ID, creates config revision 1, emits both registration and
configuration events, and starts with listing=false, listingRevision=0 and
verificationRevision=0. Registration is not an active listing.

Only `msg.sender == current controller` can call `configure`. That is a
community-authorized on-chain transaction, including calls from its smart
account. A Pirate verifier, listing key, publisher or arbitrary relayer cannot
rewrite config. Relayed config updates are not part of V1. `expectedRevision`
must equal the stored config revision, then the transaction increments it once.
The current controller can replace the publisher without Pirate's consent.

Changing the controller additionally requires consent from the new controller.
Initial and transfer consent use EIP-712 domain name `Pirate Community Directory`,
version `1`, the actual chainId and directory verifyingContract. The exact type is:

```text
ConfigurationConsent(bytes32 communityId,address registry,bytes32 tldHash,uint64 revision,address controller,address publisher,address operatorPayments,address learningRecords,bytes32 sha256Digest,bytes32 uriHash,uint64 deadline)
```

`uriHash` is `keccak256(bytes(uri))` for EIP-712 string binding; it is not the
SHA-256 manifest digest. The consent covers revision 1 on registration or
expectedRevision+1 on transfer. Require `block.timestamp <= deadline`, a valid
low-s ECDSA signature or ERC-1271 result from the proposed controller, and all
fields equal to the submitted configuration and immutable binding. An unchanged
controller update requires empty consent and deadline=0. Reject cross-chain,
cross-directory, stale-revision and expired consent. Guard external signature
validation against reentrancy before mutating any state.

An exact retry after success returns the retained receipt through the service;
it does not increment the revision again. A raw repeated contract transaction
reverts on the consumed revision. If its receipt is uncertain, reconcile the
canonical event and current state before constructing another update.

## Verification and listing are separate

Only the namespace verifier can submit a fresh verification. It checks HNS
delegation to this chain/registry, current app ownership/records and endpoints,
and the config/publisher binding. Record the HNS height and block hash, observed
time, expiry, exact config revision and SHA-256 of the retained evidence body.
The body also records relevant MegaETH block/hash and endpoint checks. The
contract stores an attestation, not an on-chain HNS light-client proof.

`verifyNamespace` consumes an exact verification revision, increments it once,
and requires the current config revision. Require nonzero evidence/block hashes
and `observedAt <= block.timestamp < validUntil`; expiry must satisfy a bounded
maximum age fixed by the deployment profile. Evidence must be no older than
the previous observation. A profile without a selected freshness bound is not
deployable. Key compromise can forge these attestations; this is Pirate's
explicit namespace-verification trust boundary.

Only the separate listing authority calls `setListed`, using an exact listing
revision. It may list, delist and record a public reason digest. It cannot edit
config, controller, publisher or content. `isDiscoverable` is true only for an
existing, listed entry with a current, unexpired verification bound to its
current config. Listing=true requires that predicate except the listing bit.
Config changes immediately stale the verification. Verification refresh does
not undo an explicit delisting. Namespace revocation/reorg invalidation requires
prompt delisting; readers also apply their verified canonical HNS view.

The posts contract checks the community's publisher and config revision, not
the listing bit. Pirate can stop advertising a community without acquiring
control over its publications. Conversely, being listed never authorizes a
community to draw Pirate-funded rewards.

## Required implementation tests

Prove unauthorized registration/config/listing/verification rejection; fake
factory refusal; initial controller consent; EOA and contract-controller
consent; revision and domain replay refusal; rotation invalidating old publisher
calls; listing expiry and stale-config filtering; delisting without config
mutation; controller transfer with both authorities; and deterministic ID/event
reconstruction. Test malicious ERC-1271 callbacks and failed transactions leaving
all revisions unchanged. HNS ownership and gateway acceptance require a real
verifier integration beyond the Solidity tests.
