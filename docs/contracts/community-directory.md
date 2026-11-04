# Community directory V1

[CommunityDirectoryV1](../../contracts/community/CommunityDirectoryV1.sol)
implements [ICommunityDirectoryV1](../../contracts/interfaces/community/ICommunityDirectoryV1.sol)
locally. The [implementation profile](community-implementation.md) defines its
constructor and URI checks. Local adversarial tests cover on-chain behavior;
namespace verification, governance/MOSS account acceptance and deployment are
separate gates.

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

The V1 manifest must include `publisherRevocations`, initially an empty array.
This is community-controller-authorized feed policy, committed by the manifest's
on-chain hash; it is not a new Solidity field. Each entry contains a nonzero
`postsContract`, a nonzero `publisher` (both lowercase 0x-prefixed 20-byte hex),
and `fromBlock` (canonical unsigned decimal string, no leading zero except "0",
within uint256 and no later than the configuration event's block). The publisher
must occur in this community's earlier canonical configuration history. The
entry applies only to this manifest's chain/directory/community and the named
post deployment, never other communities using the same publisher.

Entries are cumulative across canonical config revisions. Later manifests must
retain every entry unchanged; they may add entries, including an earlier cutoff
for the same account/deployment. Matching entries combine by the earliest
fromBlock. The resulting publisher must differ from every revoked publisher for
the community's covered post deployments. A missing array, removed/altered entry,
future cutoff, or reselected revoked publisher makes the manifest invalid for
the compliant feed. The contract still accepts only a URI/hash and does not
parse or enforce this policy. A client that ignores the policy is not a recovery-
aware feed. No live JSON validator is supplied by these docs.

See [publisher recovery](community-posts.md#publisher-compromise-and-recovery)
for the inclusive block rule, restoration and trust limits. Ordinary publisher
rotation retains the array and does not retroactively distrust old publications.

The service and verifier check redundant manifest fields against chain state;
the contract cannot fetch JSON. Every URI is a bounded immutable `ipfs://`
reference, at most 512 UTF-8 bytes, with no query or fragment. Require nonzero
controller, publisher and content hash. The deployment fixes the supported
factory set and the namespace-verifier and listing-authority accounts; no
unbounded super-admin or directory upgrade path is implied. Both authority
addresses must be stable governance-controlled contracts with signer rotation
and a defined, tested recovery path. The recommended verifier is a
[bounded authority contract](namespace-verifier-authority.md) whose service key
is rotated by a recoverable governance Safe. A separate
[listing authority contract](community-listing-authority.md) lets its governance
Safe manage listings and an independent emergency key only remove them. Do not
bind either directory role directly to a single hot EOA. Deployment
acceptance must revoke/replace an operational signer while preserving the
account, directory and posts addresses, configuration and all post IDs. The
recovery authority must survive loss of an operational signer; it is not a
claim that an account can recover after every recovery credential is lost.
The interface defines no Pirate override of community control and no
lost-community-key recovery bypass.

## Configuration publication lifecycle

Pin and verify configuration manifests before publishing their references, just
as for [post manifests](media-publication.md). This applies to initial
`registerCommunity`, every `configure` (including routine address changes and
incident rotation), and `acceptControllerTransfer`. A missing current config
withholds the community's whole compliant feed, not just one post.

The operator service first reads canonical directory state and prepares the exact
next configuration. Validate the complete schema, chain/community identity,
controller/publisher and contract addresses, plus cumulative revocations against
the retained canonical history. Serialize JCS once, compute SHA-256 over those
exact bytes, and durably pin the immutable IPFS object. Confirm pin completion,
then retrieve through the configured consumer retrieval path and verify the CID,
exact byte digest, schema and chain bindings. An upload response or a hash of
local bytes alone is insufficient. Retain the CID, digest, pin status and
retrieval result with the publication job; never record private credentials.

Only then submit the matching URI/hash and expected revision. Reconcile canonical
state immediately before submission. If a concurrent change invalidates the
prepared configuration, rebuild and repeat validation rather than updating only
the expected revision. A failed pin, unavailable body or mismatch holds the
transaction for retry; incident urgency does not bypass this order.

For a transfer, complete the same preparation before `proposeControllerTransfer`
so the receiving account can review the exact committed body. Before acceptance,
the receiving account's client independently retrieves and verifies that same
URI/hash and checks the live proposal ID, base revision, expiry and full
configuration hash. Do not rely on the proposer's earlier availability check.
If content cannot be verified, do not accept. Changed bytes or configuration
require a replacement proposal; they cannot be substituted under the old ID.

Keep current and historical config objects pinned and available for replay;
rotation or transfer must not unpin the previous revision. Monitor availability
and retry verified retrieval through another configured IPFS gateway as needed.
A successful preflight is point-in-time evidence, not a perpetual availability
guarantee. If content later disappears, the feed still follows its fail-closed
policy until verified retrieval succeeds. These are service/client acceptance
requirements; the directory cannot fetch JSON, and this PR adds no uploader,
availability monitor or manifest validator.

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

## Operator bootstrap and recovery

The registry admin and community controller need not be MOSS accounts. V1
supports an ordinary operator EOA making testnet bootstrap transactions with
its own bounded gas budget. Treat that account as temporary: the wizard must
track handoff to a controller account with demonstrated independent recovery
before mainnet or real-user onboarding. Testnet first-song acceptance can count
with the EOA; recovery readiness is a separate tracked result. A
[Safe governance account](governance-accounts.md) is another candidate alongside
MOSS. Each selected profile must pass its own recovery acceptance; successful
execution or code presence alone is insufficient. The receiving account must
execute acceptance. Keep the EOA controller until acceptance is confirmed; a failed
initialization or expired proposal must not surrender control. Registry-admin transfer, publisher changes
and community-controller transfer are separate authorities; transferring this
directory entry alone does not move the registry admin or service credentials.
Pirate's verifier/listing roles still require the stable governance-controlled contracts
specified above; this operator bootstrap does not relax that requirement.

An EOA has no protocol key-reset or recovery mechanism. If its private key is
lost without a usable backup, or an attacker has taken control and no trusted
handoff can be completed, neither the registry admin nor Pirate can recover the
directory entry. A registry-admin transfer cannot overwrite an existing entry.
A still-authorized publisher might continue writing under the old config, but
that does not restore controller authority or the ability to rotate it safely.
If access remains, a legitimate handoff may contain a compromise; this two-step
protocol does not guarantee winning a race against a stolen controller key.

Within the existing shared directory/posts deployment, restoring community
control then requires a new registry and registration, producing a new
communityId. The old community and post history remain on chain; they are not
moved or erased. Even reusing a postId under the replacement community yields a
different publication/streak key. There is no automatic history, author, grade
or streak migration. Any successor link or migration needs its own explicit
policy and authority checks. Replacing shared contracts is a different deployment
migration, not a per-community recovery override.

The wizard may complete the testnet first-song milestone with an EOA without
waiting for MOSS or Safe recovery acceptance. Its receipt must identify testnet,
the controller address/type and incomplete recovery; it is not production readiness.
Its controller step must track `bootstrap-only`, `handoff-proposed`,
`acceptance-pending`, `recovery-pending` and `recovery-verified`. Save the target account/profile,
proposal ID, base revision, expiry and transaction receipts without secrets.
On resume, re-read canonical directory state; an expired/replaced/cancelled
proposal returns to bootstrap-only if the EOA still controls the entry. Reconcile
any other completed handoff instead of trusting cached workflow state. An
orphaned acceptance loses completion.
An accepted handoff whose recovery check is still outstanding is recovery-pending:
the new account already controls the entry, and the EOA no longer has authority.
Verify the selected account's recovery before accepting wherever possible.
Mark recovery-verified only after the chosen confirmation policy establishes
the receiving controller and an actual signer-loss/independent-recovery check
for that account has passed without changing its address. Record which credential
losses/compromises that profile covers and prove the retired operational signer's
requests are refused. Do not promise recovery from a stolen root/delegation key
unless the account profile establishes it. Merely rotating a
still-accessible signer, simulating a call, possessing a second copy of the same
key or enrolling a passkey does not prove independent recovery.

Recovery-verified is required before mainnet or real-user onboarding, not for
the testnet first-song completion result. Track it separately from publication
and playback acceptance so an EOA test run can pass without being described as
recoverable setup. A pending recovery step remains visible after that run.
Loss of every recovery credential remains outside the guarantee. This is a
wizard acceptance requirement, not a new on-chain controller-type check.
This describes the contract integration path, not a proven first-song journey:
the directory/posts have local implementations, but the real wizard transaction
flow still needs acceptance. It does not replace MOSS as the selected ordinary participant
wallet or the separate Sui/Ika creator activation flow.

### MOSS-specific acceptance

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

V1 keeps HNS verification as the discovery prerequisite. The HTTPS-first testnet
path deliberately allows registration, publication, direct post pages and the
community's own feed while remaining unlisted in Pirate's directory and aggregate
discovery. An HTTPS origin or domain-control challenge does not satisfy
`verifyNamespace`; never manufacture HNS evidence or insert a dummy hnsBlockHash
to list an HTTPS-only community. Raw indexing does not grant discovery status.

An existing entry can become discoverable later only when the verifier proves
the matching HNS TLD's binding to that same registry/current config and the
listing authority lists it. Its publication identity then stays unchanged. If
the matching namespace cannot be established, a different TLD cannot overwrite
this entry's immutable tldHash; a new registry creates a new communityId. No
automatic history migration is implied.

HTTPS-only discovery is not a V1 verification type. If that becomes a launch
requirement, revise the verification model and ABI before deployment, including
distinct identity/display semantics for HTTPS and HNS claims. Neither the
directory nor the posts pointer is upgradeable; adding that capability after
deployment would require a new deployment and an explicit identity/history
migration plan. The current first-song test scope does not require that extension.

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
explicit namespace-verification trust boundary. Treat maxVerificationAge as
an immutable security ceiling, with a selected risk rationale and a measured
refresh/reader-suppression budget. It bounds each record's lifetime, not an
ongoing attacker who keeps renewing it; see the
[evidence-age security rule](namespace-verifier-authority.md#evidence-age-as-a-security-bound).

The [verifier authority design](namespace-verifier-authority.md) separates
automated attestation from governance signer recovery. Its implementation and
local integration are prerequisites to deployment; actual binding and refresh
acceptance precede live listings. None is established by the current directory
tests. Rotating or pausing its service key does not
invalidate already recorded attestations; incident response also requires the
separate listing authority to delist affected communities. Its emergency key
can do so without waiting for Safe signers, but cannot restore a listing.

Only the separate listing authority calls `setListed`, using an exact listing
revision. Its governance Safe may list/delist; its restricted emergency path
may only delist and record a public incident-reason digest. After any delisting,
only a new governance-authorized listing can restore discovery. It cannot edit
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

Service acceptance must also prove that failed pinning, unavailable retrieval,
hash/schema mismatch and a stale configuration prevent registration/configure
submission. Exercise transfer content becoming unavailable between proposal and
acceptance, replacement of a changed proposal, retained historical pins and a
routine address update whose config becomes unavailable after submission. The
last case must withhold the feed until verified retrieval succeeds. These checks
are not covered by the existing Solidity suite.
