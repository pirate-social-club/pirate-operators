# Canonical community service transport

The installed community owns its database, private objects, account fence and
publisher key. Managed recognition and pinning services need explicit operations
over HTTPS instead of the fixture's in-process database and function references.
Provider credentials remain with those managed services.

## Failure model before implementation

An anonymous caller, another community, the owner wallet or a retired service
signer must not read private intent, lyrics or audio. Requests bind the selected
community, current configuration digest, action, body digest, caller, random
nonce and short lifetime. The actual current configuration selects the permitted
recognition or moderation signer. Managed-only readiness is unavailable to the
recognition role. No request selects a database, object key, RPC URL or owner.

A cached response must not satisfy another request or a changed configuration.
The community publisher signs the request digest and response digest. Clients
verify that signature against their independently loaded current configuration
and recheck authority after receiving the response. Media reads are bounded and
checked against the accepted audio length and digest. Requests and responses
have finite deadlines and size limits.

The publisher signature authenticates transport. It does not prove recognition
readiness or a mined publication. Readiness carries the original Pirate-signed
reservation envelope and its complete signed status request. The managed caller
supplies the request nonce and independently verifies the recognition signature,
profile, intent, reservation, configuration, purpose and lifetime. Publication
verification uses managed-owned RPC and Posts bytecode pins, the actual safe
transaction, receipt and event, and CID/digest-validated public metadata. A
publisher-signed assertion cannot replace those proofs. The controller-signed
owner authorization is also retained and independently checked.

An account unlink, owner revocation, changed sealed input, changed prepared
transaction or missing receipt must still fail the existing canonical checks.
The server delegates to those checks and repeats source validation across audio
reads. A supplied accepted intent must equal the current original. An arbitrary
private object path is never an audio request.

Recognition charges retain the original operation and owner allowance. Replaying
a transport request cannot replenish that allowance. Managed readiness uses the
community's existing publisher-signed reservation client, with the live original
publication lease checked before and after the send. It cannot sign a replacement
posting or perform a provider purchase.

The first-song HTTP integration must use the real community handlers, D1/R2,
cryptography and local chain. It must publish and recover without duplicate
transactions or provider acquisitions, and retain independently verifiable
execution evidence. Rejected signatures, changed scope/body, replayed responses,
expired requests and revoked source authority must fail before new effects.
External provider and content transports remain explicit simulations.

Remote cancellation and withdrawal have no admitted native producer in this
slice. They must refuse explicitly; this work does not claim those paths or an
installed-host, provider or restart acceptance result.

## Qualification in progress

The first bounded seven-case HTTP attempt passed four cases and failed its new
refusal setup before reaching the 180-second limit. The diagnostic reproduced
the refusal setup failure: a session foreign key correctly prevents deleting its
credential binding. The corrected setup changes the credential subject while
preserving that reference and retains the denial and no-new-effect assertions.
Both failed receipts remain evidence; they are not suite passes.

The retained ordinary publication and lost-acknowledgement cases use actual HTTP.
The new refusal case also uses an actual malicious HTTP peer whose responses
have valid publisher signatures but forged recognition or chain claims. The
other retained cases keep their existing in-process real-handler composition.
This avoids repeating the complete HTTP publication journey for every unrelated
policy assertion. Their production handlers and assertions remain unchanged.

The affected strict transitive production and test types pass. Two earlier whole
root type commands reached their finite limits without diagnostics, so complete
root types and final runtime qualification are still outstanding at this source
checkpoint. Independent source review may proceed in parallel with the focused
checks. No installed-host or live-provider readiness is claimed.
