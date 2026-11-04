# Automated namespace verifier authority

Recommended V1 implementation profile, 2026-11-04. This specifies a new contract
dependency; no Solidity implementation, ABI, service, key or deployment is added
by this document. It does not grant HTTPS-only discovery or reward eligibility.
The [directory](community-directory.md#verification-and-listing-are-separate)
continues to require HNS evidence for Pirate discovery.

## Authority and permitted calls

NamespaceVerifierAuthorityV1 is a small, non-upgradeable authority contract. The
directory fixes its address as `namespaceVerifier`. A separate recoverable
governance Safe administers it; a separate
[listing authority](community-listing-authority.md) has its own governance Safe
and an emergency key restricted to delisting.
Use the [governance account profile](governance-accounts.md) to qualify that Safe.
This delegates routine attestation to a service key while retaining independent
key administration and recovery. It does not make routine evidence multisig-verified.

The proposed constructor fixes a nonzero, code-bearing `governance` account.
The authority starts unbound and disabled, with `directory` and `operator` zero.
There is no governance-address setter, proxy upgrade or external recovery override;
Safe signer replacement preserves that governance address. Loss of enough Safe
signers to defeat its tested recovery profile is outside the guarantee.

Only governance may call `bindDirectory(address)`, once. Require a nonzero target
with code whose `namespaceVerifier()` equals this authority and whose listing
authority differs from this authority and its governance account. Governance
must also verify the target's reviewed bytecode and deployment manifest; those
getter checks alone do not establish a genuine directory. Emit the fixed binding
and refuse every later binding attempt, including from governance.

Only governance may set or replace `operator`; a nonzero operator requires a
bound directory and must differ from governance, the authority and the directory.
Setting it to zero disables new verification immediately when the transaction
becomes canonical. Emit old and new operator addresses for every change. The
service key cannot replace itself, change governance, bind another target or
re-enable itself after revocation. Transactions accepted before revocation remain
in history; reorg-aware clients must reconcile the effective operator state.

Only the current nonzero operator may submit the typed
`verifyNamespace(communityId, expectedVerificationRevision, verification)` call.
The authority forwards those exact arguments to the bound directory, without
value. It must not accept an arbitrary destination, selector, calldata blob,
delegatecall, token approval or general execution instruction. Directory checks
still enforce configuration/verification revisions, nonzero evidence hashes,
observation ordering, expiry and maximum age. A revert propagates atomically;
the authority cannot consume a revision on a failed call. This is an account
transaction from the service key, not a detached signature relayed by anyone.

The authority holds no user funds and has no payment or reward path. A bounded
gas balance belongs to the service account; that balance is exposed if its key
is stolen. No key, gas funding or secret-store change is authorized by this spec.

## Deployment and acceptance order

Before deploying a directory, implement and review this authority, qualify its
governance recovery, and pass local integration tests using the actual directory
artifact. Select the deployment manifest, namespace observation/confirmation
policy, the [evidence-age security ceiling](#evidence-age-as-a-security-bound),
refresh cadence and retry/reader-suppression budgets. The fixture's one-day age
is not a production choice. This design changes the verifier input's
implementation profile without changing the existing directory/post ABI.

In a separately admitted deployment, create both verifier and listing authorities
disabled and unbound, then deploy the directory with those distinct addresses.
Each governance Safe verifies and binds its authority to that directory once.
Read both bindings back, then enable the selected service and emergency keys
through their respective governance accounts. No predicted address or replaceable
placeholder is needed to break this dependency.
Do not enable listings or declare deployment accepted until actual signing,
rotation, disable/re-enable, freshness and recovery checks pass. Those checks
follow binding; they cannot be claimed before the directory exists.

Acceptance must refuse unauthorized binding, zero/wrong/fake targets under the
reviewed deployment checks, rebinding, operator self-rotation, old-key calls,
unbound/disabled calls and unauthorized general execution. Verify exact forwarding,
stale/wrong configuration or verification revisions, failure atomicity and
canonical recovery after a reorg. Rotate through the actual governance account
after simulating loss of an operational signer; preserve authority, directory
and post addresses and prove the retired service key is refused. A generic
governance fixture or a successful compile does not establish these properties.

## Evidence age as a security bound

`maxVerificationAge` is an immutable security setting in the directory. Select
it from the tolerated lifetime of false namespace evidence as well as the
service's refresh capacity. Record the chosen value, risk rationale, incident
detection/revocation assumptions and reader-suppression budget in the deployment
manifest. A low-cost refresh schedule alone is not sufficient justification;
the fixture's one-day value is not an approved deployment setting.

Let M be `maxVerificationAge` and T the canonical block timestamp accepting an
attestation. The directory requires `observedAt <= T < validUntil` and
`validUntil - observedAt <= M`, so `validUntil <= T + M`, including for a forged
attestation. At `validUntil`, that record no longer satisfies `isDiscoverable`.
After the last forged submission at Tlast, residual on-chain validity is at
most M. If key revocation remains canonical at timestamp R and no further
forgeries are accepted, previously submitted records expire no later than R + M.

This is not a bound on the total duration of an active compromise. Before key
revocation, an attacker can keep submitting fresh forgeries and move the expiry
forward indefinitely. Detection delay and the time needed to revoke the key
are additional exposure. Emergency delisting can suppress affected communities
sooner without waiting for revocation, because fresh verification does not
restore a false listing bit. Neither expiry nor a submitted delisting transaction
is proof that a stale index/cache has stopped showing the community.

Select the security ceiling first. Then prove the observation, signing, inclusion,
confirmation and retry budget fits inside it with refresh headroom. Account
separately for index lag, cache lifetime and incident-response latency. Readers
must check expiry at query time and withhold a claim of current discoverability
when they cannot establish sufficiently fresh chain state. If the service cannot
meet the selected bound, let discovery expire and repair service capacity; do
not silently enlarge the risk window to save refresh cost. Community publication
remains independent of discovery.

The directory has no setter to reduce M later. Honest attestations may use a
shorter validity window, but a stolen key can still request the full on-chain
maximum. A required change to that hard bound after deployment needs a new
directory and the explicit migration policy; an off-chain setting cannot claim
to change its enforcement.

Acceptance must include a forged attestation using the full allowed age, rejection
above M, the exact expiry boundary, repeated forged renewal while the key is
active, and expiry of the last accepted forgery after revocation. Also test
emergency delisting while verification remains unexpired, renewal that cannot
relist, reader/cache suppression, and loss of refresh/RPC access. These are
required tests for the proposed authorities/service, not new coverage in this PR.

## Refresh service and incident handling

The service rechecks the real HNS-to-registry binding, app records, endpoints and
the current config before each attestation, retaining the exact evidence body
whose SHA-256 is submitted. An HTTPS availability check alone is insufficient.
Refresh before expiry with measured margin for observation, signing, inclusion,
the selected confirmation policy and retries. Config changes require a new
check against the new revision. Reconcile uncertain receipts and current revisions
before retrying; do not duplicate an already successful attestation.

If observation, signing or RPC access fails, retain pending work, alert and allow
the existing record to expire. Do not extend stale evidence, fabricate an HNS
hash or bypass the discovery predicate to maintain feed availability. Show the
community's publication result independently of Pirate discovery. The chosen
cadence and outage behavior must be exercised before live listings.

A compromised service key can forge an HNS attestation for any registered
community, including refreshing an already listed community with false evidence.
Its narrow call authority prevents configuration, publication, listing and fund
operations; it does not prove the truth of evidence or equal two independent
signers. The service also needs protected credentials, retained evidence and
monitoring under its separate operational acceptance.

On compromise, the separate [emergency delisting key](community-listing-authority.md)
can suppress affected communities without waiting for a governance threshold.
The verifier governance Safe still disables or rotates the operator. This stops
new calls from the old key but does not invalidate existing attestations; without
canonical delisting or expiry, a false attestation can remain discoverable.
Verification refresh cannot undo a delisting. If the emergency key is compromised,
its governance must disable or rotate it before restoring any listings.
Revalidate from fresh trusted observations, submit a new valid attestation where justified and make
a separate listing decision. For invalid namespace bindings, remain delisted;
do not write a fake "revoked" attestation into the HNS fields. Keep incident and
verification receipts so readers can reconstruct canonical state. Once new
forgeries are stopped, the security ceiling bounds the remaining on-chain
validity when timely delisting is unavailable. It does not cap an attacker's
ability to renew while the verifier key remains authorized.
