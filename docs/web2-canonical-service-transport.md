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

At source checkpoint e76b602, the default complete root type check passes in
6.6 seconds. The three selected actual HTTP cases pass in 131.4 seconds with no
failure, cancellation or skip. Ordinary and lost-acknowledgement publication each
retain one broadcast, one catalog upload and three pins. Their artifacts retain
original signed recognition envelopes and public transaction/manifest witnesses,
with independently checked SHA-256 commitments. The other four first-song cases
remain required in hosted CI; this focused run is not a full-suite result.

The ordinary revision-validation handoff at 964cada was independently rerun with
pinned Node 24.18.1, Foundry 1.9.0, a fresh private temporary directory and a
240-second execution bound. The same three actual HTTP cases pass in 196.275
seconds with no failure, cancellation or skip. Its complete root type check was
already recorded at 6.650 seconds. These are direct results for 964cada, not the
earlier e76b602 evidence above.

Independent patch review found that the authorization method omitted the new
pre-transport revision guard. Commit 5f5490f8ebe11a27fa2d358b47e859e68a135957
routes that method through the same guard and extends the retained HTTP boundary
case. Source, posting, publication, lookup, audio, authorization and readiness
now each reject revision 2 without a transport request. The complete root type
check and the same three integration cases pass on this commit, the latter in
191.782 seconds with no failure, cancellation or skip. Both bounded runs left no
test-owned process or listener; unrelated retained Storybook and separate Linux
fixture processes were not touched.

All eleven real Wizard integration cases also pass in 12.2 seconds. The existing
first case now verifies valid checksummed input becomes canonical lowercase,
while malformed input produces a field-specific correction before preparation
or effects. The correction is separately preserved in b0d7d19.

Two earlier whole-root type attempts reached finite limits without diagnostics.
A later targeted check identified a missing type import during protocol
extraction; that import is corrected. The exact reason those earlier whole
checks did not exit with diagnostics is unproven. Their incomplete receipts stay
separate from the direct successful default local check above.

Final independent review and exact-head hosted CI remain mandatory. No
installed-host or live-provider readiness is claimed.
