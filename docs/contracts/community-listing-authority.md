# Community listing authority and emergency delisting

Recommended V1 implementation profile, 2026-11-04. CommunityListingAuthorityV1
is a new, unimplemented contract dependency alongside the
[namespace verifier authority](namespace-verifier-authority.md). The directory
already accepts its contract address as `listingAuthority`; no directory/post
ABI change is proposed. A direct Safe in that slot would require its normal
threshold for every delisting, so the emergency key cannot simply call around it.

## Authority and permitted calls

Use a non-upgradeable contract with an immutable, nonzero, code-bearing
`governance` account. Qualify a separate recoverable listing Safe under the
[account profile](governance-accounts.md). It must differ from the verifier's
governance Safe. The authority starts unbound with `directory` and `emergencyKey`
zero. No governance-address setter, proxy upgrade or external recovery override
is provided; signer recovery preserves the governance Safe's address.

Only governance may bind a directory, once. Require a nonzero target with code,
`listingAuthority() == address(this)` and a distinct code-bearing namespace
verifier. Governance must verify the target's reviewed bytecode and deployment
manifest; getters alone cannot prove a genuine directory. Emit the binding and
refuse rebinding. Binding must not require the peer authority to have bound yet.

Only governance may set, rotate or disable the emergency key, emitting old and
new addresses. Zero disables it; a nonzero key requires a bound directory and
must differ from governance, both authority contracts and the directory. The
deployment/key-rotation profile must also keep it distinct from the verifier
service key, with separately controlled credentials and operational access.
Address inequality alone does not establish independent custody. No emergency
key is created, funded or installed by this specification.

Governance alone may forward the typed directory call
`setListed(communityId, expectedListingRevision, listed, reasonSha256)` with
either value of listed. Preserve the caller's expected revision. Listing true
still requires current, unexpired namespace verification in the directory; an
emergency recovery never bypasses HNS verification. Governance must revalidate
the namespace and incident before restoring a listing, not merely observe a
non-expired attestation that could have been forged.

The current nonzero emergency key may call only
`emergencyDelist(communityId, reasonSha256)`, with a nonzero public incident-reason
digest. The contract reads that community's current listing revision at execution
and calls the bound directory's setListed with that revision and literal false.
An unknown community reverts. No caller-supplied destination, selector, listed
flag, calldata blob, value, delegatecall or general execution is accepted. It
cannot verify a namespace, pause the verifier, change config, publish content,
move protocol funds, rotate a key or grant itself further authority.

Forward false even if the community is already unlisted. Advancing the listing
revision invalidates a queued governance restoration built against the older
revision. If restoration executes first, a later emergency call reads the new
revision and delists again. Emergency jobs reconcile canonical receipts/events
before retrying; repeated raw calls advance revisions and spend gas. Directory
reverts propagate atomically. The reason digest is an operator assertion, not
on-chain proof of misconduct, and must not expose private incident details.

## Incident handling and recovery

Emergency delisting needs one key, without waiting for two Safe signers. The
verifier Safe still disables or rotates a stolen verifier service key. Neither
operation erases its earlier attestations. Once a delisting is canonical, fresh
verification alone cannot restore discovery: listing remains false until the
listing governance Safe makes a separate successful restoration call.

A stolen emergency key can wrongly delist any or all registered communities,
disrupt aggregate discovery and invalidate queued listing transactions. It cannot
add listings or alter community publication/control. Its own bounded gas balance
is also exposed. Governance must disable or rotate that key before restoring
listings, otherwise the attacker can remove them again. A restoration queued
with an old listing revision must be rebuilt after reconciliation.

For verifier compromise, delist affected communities, disable/rotate the verifier
key, gather fresh trusted evidence and only then consider restoration. Verify
the correct authority/key state and listing revision on the canonical chain;
reorgs can undo a delisting or revocation. Measure detection, transaction and
feed/cache suppression delays. The emergency path reduces dependence on signer
availability but does not guarantee immediate wall-clock removal during RPC,
chain or indexing outages. It changes Pirate discovery, not access to independent
community feeds. If this emergency key is unavailable, governance can still
delist through its normal threshold path.

## Deployment and acceptance

Implement, review and locally test both authority contracts before deploying
the directory. In a separately admitted deployment, create both unbound, deploy
the directory with those fixed addresses, then let each governance Safe bind its
authority once. Verify both bindings before enabling service/emergency keys.
Qualify actual account recovery, the emergency submission path and reader
invalidation before enabling live listings. No deployment, key operation or
runtime acceptance has been performed for this design.

Test governance-only binding/rotation, wrong targets, rebinding, unbound/disabled
calls and old-key refusal. Prove the emergency key cannot list true, call other
targets/functions or affect namespace/config/publication/fund state. Delisting
must work with stale or expired verification. Exercise both orderings of an
emergency call and queued restoration, repeated delisting while already false,
receipt retry, reorg reconciliation and verification refresh after delisting.
Rotate a compromised emergency key through governance and show that only a fresh
authorized restoration with valid verification can restore discovery. Include
the actual directory artifact in local tests and a real governance/emergency
account acceptance during the admitted deployment; existing fixtures prove
neither this authority nor incident-response latency.
