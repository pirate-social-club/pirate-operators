# Automated namespace verifier authority

Recommended V1 implementation profile, 2026-11-04. This specifies a new contract
dependency; no Solidity implementation, ABI, service, key or deployment is added
by this document. It does not grant HTTPS-only discovery or reward eligibility.
The [directory](community-directory.md#verification-and-listing-are-separate)
continues to require HNS evidence for Pirate discovery.

## Authority and permitted calls

NamespaceVerifierAuthorityV1 is a small, non-upgradeable authority contract. The
directory fixes its address as `namespaceVerifier`. A separate recoverable
governance Safe administers it; the listing Safe remains a different address.
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
policy, maximum evidence age, refresh cadence and retry budget. The fixture's
one-day age is not a production choice. This design changes the verifier input's
implementation profile without changing the existing directory/post ABI.

In a separately admitted deployment, create the authority disabled and unbound,
then deploy the directory with that authority's address and a separate listing
account. Governance verifies and binds the actual directory once. Read the
binding back, then enable the selected service account through governance. No
predicted address or replaceable placeholder is needed to break this dependency.
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

On compromise, governance disables or rotates the operator. This stops new
calls from the old key but does not invalidate existing attestations. The
independent listing authority must delist affected communities promptly; otherwise
an unexpired false attestation can remain discoverable. Revalidate from fresh
trusted observations, submit a new valid attestation where justified and make
a separate listing decision. For invalid namespace bindings, remain delisted;
do not write a fake "revoked" attestation into the HNS fields. Keep incident and
verification receipts so readers can reconstruct canonical state. Expiry remains
the fallback when timely delisting is unavailable.
