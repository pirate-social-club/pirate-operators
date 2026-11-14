# Shared community directory V2 — proposed source protocol 1

This is the explicit successor to CommunityDirectoryV1, not an upgrade. V1 contracts,
IDs, manifests, publication history, journals and deployment evidence retain their
original meaning. Source and prepared tests are unrun until Root's allocated gates.

The accepted registry dependency is pirate-registry source
56d63ad2738e0e6816b6157dba7174198700f2fa, source schema
`pirate.shared-registry-source/1`, full generated ABI SHA256
e580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802.
Its accepted compiler/CI boundary is independent of this directory's future build
and of still-unrun application/service integration. No directory address, runtime
hash, creation artifact or deployed source profile is invented in this proposal.

## Identity

All hashes below use Keccak-256, UTF-8 domain text and Solidity `abi.encode`.

```
communityId = H(abi.encode(H("pirate.community/2"), uint256(chainId), communityKey))
namespaceId = H(abi.encode(H("pirate.namespace/1"), H(bytes(tld))))
```

`communityKey` is the persistent random nonzero public bytes32 portable reference.
`communityId` is its chain-specific directory instance, also used as the registry
scope/FreeClaim community ID. It intentionally excludes registry and directory
addresses. The complete application locator includes chain, directory and ID;
equal IDs in two directory deployments do not merge their histories or authority.
The V1 `communityId(chainId, registry)` helper retains its old formula and meaning.

`installationId`, HTTPS hosting origin, issuance TLD/namespace and source deployment
are separately bound. Hosting origin is committed with SHA256 of the exact canonical
HTTPS origin. CommunityDirectoryV2 stores these binding fields immutably for an
enrolled instance. An install/origin/source move requires the explicit migration
boundary, not a configuration that silently changes the binding. Two communities
can select the same registry and namespace; full-name uniqueness belongs to the
registry. Identical labels under distinct TLDs remain independent.

TLDs are exact lowercase ASCII DNS labels of 1–63 bytes, no edge hyphen, no `xn--`,
case folding, root dot, whitespace or Unicode terminator. Namespace helpers reject
noncanonical input. These are TLD rules; member issuance separately uses the
accepted registry's ordinary-label minimum of eight characters.

## Governance, configuration and discovery

Only Pirate's admin can admit a source deployment and enroll a community. This binds
the public key to the controller selected by Pirate and prevents public-key
front-running. Source admission commits runtime code hash, source commit and ABI
digest; each registry address can be admitted once. It is not HNS ownership proof.
The registry address and binding cannot be repointed in-place.

The testnet admin is one explicitly selected account with propose/accept handover.
It also performs discovery attestation/listing for this testnet profile. Multisig
provisioning remains deferred. The configuration controller and publisher are
explicit Pirate application/service roles; operators receive app permissions, not
an implicit contract administrator key. The admin has no override to seize a
registered community's configuration. Controller changes use the inherited exact
configuration commitment, revision, deadline and two-step acceptance protocol.

The constructor allows only 6343 or local 31337 and requires an explicit positive
maximum attestation age no greater than 24 hours. No account, age, gas, fee or funding
default is selected by the planner. Listing requires current configuration-bound
attestation. Source code changes invalidate discovery. Discovery is never authority
to publish, issue names, transfer holder assets or change locked renewal terms.
No old factory/admin/tld getter is consulted. Registry signer, transaction submitter,
HNS observer, application membership and name holder remain distinct boundaries.

The V1 `getCommunity` tuple and `ConfigurationPublished` event stay wire-compatible
so a newly selected CommunityPostsV1 deployment can read the successor's publisher.
Existing PostsV1 deployments have immutable directory pointers and cannot be
repointed by this work. V1 registration/address-ID selectors explicitly revert on
V2. The inherited interface supplies tuple types; original V1 bytes are unchanged.

## Typed callers and profiles

`shared-directory.ts` exports an explicit consumer ABI subset, not generated build
output. The prepared ABI test compares its semantic argument/tuple/event shapes and
mutability to Root's actual compiled V2 artifact. Full ABI generation/source pins
remain a later gate. Registry ABI fragments are not transcribed here.

`SharedDirectoryProfile` uses `pirate.shared-directory/2`, an explicit deployment
block and runtime code hashes for both directory and accepted registry. Internal
block numbers are bigint; `sharedProfileDocument`/`parseSharedProfileDocument` use
exact decimal strings at the JSON boundary. Unknown fields/schemas/source pins and
noncanonical decimals/identifiers fail closed. No implicit V1 or address fallback.

`CommunityConfig` becomes a tagged union of `LegacyCommunityConfig` and
`SharedCommunityConfig`; shared fields are required on schema 2. Existing post and
revocation consumers can use common fields without falsifying a schema-1 document.
`validateConfig` remains legacy-only. `validateSharedConfig` explicitly binds schema
2 to the admitted shared profile and immutable installation/origin/namespace/source.

The explicit `*-shared.ts` entrypoints beside the historical MegaETH scripts plan,
inspect, verify and select the new profile. They do not execute transactions, read
credentials or select historical journals. Historical first-song/deployment/adoption
scripts and defaults retain their original bytes. The Story IP registration module
keeps its original behavior and re-exports the separate directory enrollment API.

The enrollment plan commits exact profile, config, IPFS reference, admin and calldata.
Binding signed bytes requires exact chain, to, data, zero value, nonce, gas and fee
fields plus the expected signer. No defaults, signing or broadcasting occur here.
Recovery preserves that exact raw/hash/nonce and establishes consumption from the
successful canonical original receipt and matching binding/configuration events,
independently of later controller/publisher state. Pending/unknown/reorg/refusal do
not authorize a new request, nonce or automatic replay. Root's backend must supply
the durable original-operation lease/persistence before any future broadcast.

## Revision reader and durable cache

The 256-revision cutoff is removed. Configurations are processed in order with
incremental validation state: immutable first identity, last revision, all prior
publishers and cumulative revocations. The numeric schema still requires safe
integer revisions; there is no arbitrary lifetime budget. Canonical manifests are
bounded to 65,536 bytes and cannot remove or alter earlier revocations.

RPC scans cover at most 10,000 blocks per range; dense ranges bisect. Single-block
logs are indivisible at the RPC boundary and are processed in eight-entry pages.
`readConfiguration` streams to the current state; `readConfigurationHistory`
explicitly materializes history for existing callers that require it. Staged
callbacks cannot commit side effects before the final state/reorg check succeeds.

Every publication, including cold replay and every cached reload, authenticates its
successful receipt, exact log, canonical block, content digest/canonical JSON,
contiguous revision and profile. Final row state and pinned block are rechecked.
An unchanged contract revision permits skipping new log scans, never skipping
authentication of cached evidence. No cached summary is trusted as authority.

The cache stages immutable bounded pages before publishing a CAS head. A failed
page write leaves the old head valid. A concurrent loser cannot overwrite a winner;
a reorg or regressed head compare-deletes only its stale pointer. Unknown RPC and
authentication errors propagate. Cold replay rebuilds from canonical receipts.
Orphan/old snapshots are retained; Root may later admit bounded retention after
proving they are unreachable. They are not deleted automatically here.

`directory-checkpoint-cache.sql` is an exact additive migration proposal, with no
ordinal. Root must admit/apply it before mounting the new adapter. Old configuration
rows/cursors and all application journals are preserved. There is no automatic
schema creation or fallback to unauthenticated old rows. The new cursor keys bind
the complete selected profile. Pages have content digests and are also authenticated
against chain evidence, so a forged self-hash is insufficient.

## Other owners and remaining acceptance

Naming uses the new opaque instance/install/namespace bindings and accepted registry
SDK semantics; no competing member issuance implementation is added. The actual
FreeClaim has no installation field: the backend must bind installation and member
authorization before signing the exact registry claim, not invent an ABI field.
Effective quote/maxCost must be exactly zero, ordinary labels >=8, no name-specific
exception, paid fallback or approval; term/expiry/locked renewal/gas remain explicit.
W6 owns wizard source; Root owns member/API/shared mounts/release configuration;
Storage owns its service/backend handoff. Source interfaces do not establish those
services. Payment spending-cap work, live roles/fees/currency, deployments, provider
access, funded actions and migration execution remain outside this proposal.
