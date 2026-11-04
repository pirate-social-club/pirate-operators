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
unbounded super-admin or directory upgrade path is implied. Both authority
addresses must be governance smart accounts with signer rotation and a defined,
tested recovery path. Do not bind either role to a single hot EOA. Deployment
acceptance must revoke/replace an operational signer while preserving the
account, directory and posts addresses, configuration and all post IDs. The
recovery authority must survive loss of an operational signer; it is not a
claim that an account can recover after every recovery credential is lost.
The interface defines no Pirate override of community control and no
lost-community-key recovery bypass.

## Authorization and replay protection

The current `registry.admin()` registers its own entry by an account transaction.
Require `msg.sender == registry.admin()` and `configuration.controller == msg.sender`.
The contract derives tldHash from the registry's canonical `tld()`, checks its
`factory()` against the deployment's fixed approved factory set, and checks that
factory's `isRegistry(registry)`. Check the expected clone/implementation profile;
arbitrary contracts cannot establish provenance just by returning familiar values.
No Pirate signature, HNS verification or listing approval is needed to register.

Registration is once per community ID, creates config revision 1, emits both
registration and configuration events, and starts with listing=false,
listingRevision=0 and verificationRevision=0. A factory clone of a claimed TLD
is not its official namespace. Anyone able to create a genuine factory registry
and act as its admin can self-register and publish under that registry's ID;
Pirate discovery still requires independent HNS verification and listing.
This supports independent publication without treating unverified claims as
discoverable. The fixed factory profile remains a protocol compatibility limit,
not a per-community approval queue.

Only `msg.sender == current controller` can call `configure`. The submitted
controller must remain the current one. The expected config revision must match,
then it increments once. Publisher/address/config changes clear any pending
controller transfer and stale namespace verification. Registry admin authority
is used only for bootstrap: a later registry-admin change cannot seize an existing
directory entry. A deliberate community-controller transfer is separate.

Controller transfer uses two account transactions. The current controller calls
`proposeControllerTransfer` with the exact next configuration, its current
revision and a future deadline. Require a nonzero, different next controller.
Store a per-community, strictly increasing proposalId, baseRevision, deadline,
proposedController and `configurationHash = keccak256(abi.encode(configuration))`.
This ABI hash commits every field, including the URI; the inner sha256Digest
still binds the JCS manifest bytes. Replacing a proposal emits a cleared event
for the previous proposal and consumes a new ID. IDs never reset after clearing.

The proposed controller calls `acceptControllerTransfer` from its account with
the proposal ID and exact configuration. Require its sender, the stored hash,
unchanged base revision and `block.timestamp <= deadline`. Acceptance increments
the config revision, installs the configuration, clears the proposal and emits
ConfigurationPublished. Only the current controller may cancel a specific
proposal. Clearing on cancellation, replacement, acceptance or configure emits
ControllerTransferCleared; a getter reports proposalId=0 when none is pending.
Old, expired or replaced proposals cannot be accepted. Every failed call leaves
directory state unchanged. There is no Pirate recovery override.

These are calls from the authorized account, not necessarily transactions whose
outer sender is that account. A smart wallet may execute them through its own
validated call path. Check `msg.sender`, never `tx.origin`, a relay address or
an address supplied in calldata. The wallet transaction binds chain, destination
and calldata; revisions/proposal IDs protect application-level retries. A relay
calling the directory directly has no authority. The directory accepts no
detached ECDSA/ERC-1271/ERC-8010 consent blob in V1.

An exact retry after success returns the retained receipt through the service;
it does not increment the revision again. A repeated raw contract call reverts
on its consumed revision/registration/proposal. Uncertain receipts remain pending
until reconciled against canonical state.

## Operator bootstrap and MOSS acceptance

The registry admin and community controller need not be MOSS accounts. V1
supports an ordinary operator EOA making registration/configuration transactions
with its own bounded gas budget. Later it can propose a controller transfer to
a MOSS account, and that receiving account must execute acceptance. Keep the
EOA controller until acceptance is confirmed; a failed initialization or expired
proposal must not surrender control. Registry-admin transfer, publisher changes
and community-controller transfer are separate authorities; transferring this
directory entry alone does not move the registry admin or service credentials.
Pirate's verifier/listing roles still require the stable governance accounts
specified above; this operator bootstrap does not relax that requirement.

The wizard should offer the EOA bootstrap without requiring MOSS readiness.
This describes the contract integration path, not a proven first-song journey:
the directory/posts are still interfaces and the real wizard transaction flow
needs acceptance. It does not replace MOSS as the selected ordinary participant
wallet or the separate Sui/Ika creator activation flow.

The November 4 MOSS test account's first transaction was not demonstrated: it
held ETH but no USDm, while the inspected CLI defaulted to USDm fees. Before
selecting MOSS for setup or transfer, prove the actual fee asset, funding and
successful account execution on the target chain. ETH balance alone is not
that proof; no gas sponsorship or funded wallet operation follows from this doc.

The pinned official wallet CLI v0.1.6 bundles Porto 0.2.37 and viem 2.54.6.
Porto's `core/internal/erc8010.ts` wraps an authorization, initialization data
and the account signature. Viem's `actions/public/verifyHash.ts` unwraps it and
uses an authorization-list simulation for an undelegated account, or ERC-1271
with the inner signature when matching delegation exists. This source evidence
does not prove the actual browser SDK's output or successful wallet acceptance.

A zero-code account cannot be assumed to verify a passkey through ERC-1271,
and a wrapped account signature is not a plain ECDSA signature. V1 therefore
uses account transactions for both bootstrap and transfer acceptance. The wizard
must prove the selected MOSS account can execute the required call: delegation
and initialization may occur in that transaction, or in a confirmed setup
transaction beforehand if that wallet requires it. A successful RPC simulation
alone is insufficient. Do not claim an arbitrary first transaction or stripping
a wrapper establishes correct account consent. No wallet/key operation ran here.

The bootstrap test must start from actual empty code, register through the
account and observe the intended directory sender/config. Repeat with an already
activated account and a fresh receiving account for controller transfer. Verify
wrong chain, target, calldata, account and unauthorized delegated-key refusal,
plus failed/retried initialization. EIP-7702 delegation can persist even when
later transaction execution reverts, so re-read account state on retry.
See the pinned [CLI source](https://github.com/megaeth-labs/wallet-cli/tree/8c53ee64797ff0f451a8e8bda315d4e744d439b4)
and [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702).

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

Prove only the current genuine registry admin can bootstrap, the initial
controller must equal that account, and no caller can overwrite an existing
entry. Refuse fake factories, self-reported provenance and invalid registry
profiles. A genuine unverified clone may register and publish but must remain
undiscoverable; a lookalike TLD must not displace the verified community.

Prove an arbitrary or former controller/publisher cannot change config or
publish; config revisions cannot replay; and old registry admins have no
recovery override. Exercise transfer proposal replacement, expiry, cancellation,
config changes during a proposal, wrong account/hash/revision and duplicate
acceptance. Verify successful acceptance changes exactly one config revision
and invalidates old publisher authority. All failed directory calls preserve
state. Exercise hostile external registry getters and reentrancy during
bootstrap validation.

Prove an unlisted community can publish from its first registered revision,
listing expiry/stale-config filtering, delisting without config mutation,
governance signer rotation without address/identity changes, and deterministic
ID/event reconstruction. Prove EOA registration and continued controller access
when a proposed MOSS transfer fails or expires, then acceptance by the correctly
initialized receiving account. MOSS acceptance is the actual empty-account flow above;
an ECDSA fixture or a successful compile is not that test. HNS authority and
browser/gateway acceptance require the independent verifier integration.
