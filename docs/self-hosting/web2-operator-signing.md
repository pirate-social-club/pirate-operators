# Paired Web2 operator signing

This slice connects the paired Wizard to MOSS enrollment and a separate owner
publishing review. The admitted application chain is MegaETH testnet 6343. Local
fixtures use disposable Anvil, actual HTTP handlers, D1, cryptography and public
content reads. Their SDK and Pirate admission boundaries are explicit fixtures;
they do not qualify real MOSS, public RPC execution or a public deployment.

The browser initializes SDK 1.0.8 with `network: "testnet"`, error logging,
`debug: false` and a 45,000 ms handshake, using its normal transport. It calls
`mega.signData({data})` once for the retained typed request. It checks account and
network before and after signing. Cancellation retains the request. The
controller defaults the editable owner nomination; both reviews show the
controller, owner and configured server publisher as distinct responsibilities.
The server publisher is never a browser wallet or the human controller.

The exact enrollment preparation retains community, installation, invitation,
registration commitment, policy, origin, configuration URI and revision 1 bytes.
The UI displays the gas allocation and storage/disposal notice before signing.
Registration already publishes configuration revision 1: the approved first-song
policy belongs there. Safe registration, configuration-event and public-content
authentication reuse the pinned enrollment readers. A mismatch blocks the path;
no extra configuration transaction is generated.

The controller proof is saved before redemption and reused only for that same
enrollment's controller gas proof. `createWeb2PublisherProofSigner` captures an
already provisioned key reference, generation, installation and lease. It checks
the actual key address inside the existing managed `withKey` port, reconstructs
only `enrollmentTypedData`, and rechecks custody and challenge lifetime after
awaits. It returns signature bytes and the public recipient, never key material.
Fresh browser-supplied recipient proofs are refused. Previously retained proofs
remain usable to reconcile their original operations.

`ManagedOwnerGrantPort.prepare` must select an externally configured Pirate
grant with an authenticated service-side admission reference. Its scope binds
enrollment, Directory installation, host installation, deployment, community,
origin, controller, nominated owner, policy, chain, Posts and publisher. Limits
and window come solely from that authority. The digest authenticates bytes; it
does not create an issuer. No numeric validator ceiling supplies a grant.

The owner review displays that grant's policy, window, destination and all five
service limits. Authorization uses the existing `{authorization,signature}`
envelope with schema `pirate.owner-publishing-authorization/2`. Its EIP-712 domain
is `Pirate Owner Publishing Authorization`, version 2, admitted chain and
Directory address. `OwnerPublishingAuthorization` contains, in order, `schema`,
`communityId`, `ownerWallet`, `policyVersion`, `policySha256`, `validFrom` and
`expiresAt`. Policy fields are the exact flattened projection. This signature is
separate from enrollment, login and per-song terms.

V2 verification uses the trusted public client's `verifyTypedData` at an explicit
safe block. It rechecks the block hash, freshness and current configuration and
samples expiry after the final await and at new-effect boundaries. Account,
lease, original-request and owner-budget-window fences remain in force. V1
retains lowercase 65-byte ECDSA personal-sign verification over the raw
`hashJson(authorization)` bytes. It never treats that hash as UTF-8 text. Unknown
schemas fail. Plain origin-bound SIWE still signs exact text and uses public
`verifyMessage`, preserving smart-account and wrapped-signature support.

Private versioned signing sidecars retain immutable selection and accepted
authorization originals separately from the existing Wizard journal. The
current sidecar records attachment intent and observation. An unknown reply
requires reconciliation against the same selection before retry. Accepted
bytes and windows cannot be replaced by a retry or restart. The runtime binder
reloads these sidecars, authenticates the same managed admission and puts the
grant, authorization and attachment digest in the signed derived graph. Signed
installation plans and application originals bind the same attachment digest.
Conflicting preembedded owner bindings fail. Older signed originals without
the optional digest retain their existing interpretation and are never rewritten.
Readiness checks require the matching managed grant, selection and admission
reference. Publisher material remains in existing secret bindings.

The operator Wizard stays on its paired loopback HTTP listener. Direct MOSS
embedding below that HTTP ancestor is unavailable for real WebAuthn; headers
alone do not repair it. Authenticated host/setup input `signingOrigin` selects
one exact HTTPS origin. It is public configuration, never a form-selected URL.
Each actual Connect or signing gesture synchronously opens an owned top-level
`/operator-signing?openerOrigin=<loopback-origin>` window before awaiting work.
Only public opener metadata enters that URL. The exact request, fresh 32-byte
channel nonce, digest, expected controller and testnet selection cross a bound
postMessage channel with explicit target origins. Both sides check the exact
window source and origin. Connection and signature responses are distinct;
wrong digest/account/network, replay, late callbacks, cancellation, close,
blocked popup and timeout cannot submit proof. Retry requires an explicit new
gesture. No operator/pairing token, key, login or service authority enters the
helper. Normal SDK initialization/connect/signData runs only after review in
that HTTPS window. Enrollment and owner publishing remain separate prompts.

The Wizard Vite build emits `moss-signing.html` and `.vite/manifest.json`.
Native's managed publishing Worker must map the fixed public GET route
`/operator-signing` to that HTML and serve its manifest entry's complete recursive
`imports`, `dynamicImports`, `css` and `assets` closure at the emitted paths.
The HTML's emitted module path is part of that closure. It must never serve the
Wizard `index.html`, operator API or private setup state. No runtime dependency
on historical probes is present. W1 supplies these artifacts; Native owns the
Worker/Alchemy packaging and its qualification separately.

Required helper responses: `Referrer-Policy: strict-origin`,
`X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
`X-Frame-Options: DENY` and CSP `default-src 'none'; script-src 'self';
style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.megaeth.com;
frame-src https://*.megaeth.com; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`. Use Permissions Policy
`publickey-credentials-get=(self "https://account.megaeth.com"),
publickey-credentials-create=(self "https://account.megaeth.com")`.
Keep the exact HTTPS opener relationship intact: do not set COOP `same-origin`
or `noopener` on this route; use `Cross-Origin-Opener-Policy: unsafe-none`.
These are source packaging requirements, not evidence of a deployed helper or
real MOSS acceptance. The loopback Wizard retains self-only scripts, exact
Host/Origin, CSRF, pairing and frame-ancestors protections.

`ManagedAdmissionGate` is trusted private composition, never a grant or wire
schema field. The new managed wrapper must capture its authenticated admission
reference, selection digest, original registration revision, community and
publisher and validate the exact parsed grant in both methods. Its
`reservationCondition(grant, {operationId, requestHash, asset, requested})`
returns an actual D1 condition on that active original admission/revision and
current database time. `reserveOwnerBudget` invokes the supplier lazily after
identical-existing-reservation comparison and ANDs it with the retained owner
window condition in the SAME reservation transaction. This is required for
songs, pin additions and pin bytes. `beforeDispatch(grant, {operationId,
requestHash})` rechecks admission after final canonical/provider preparation,
immediately before a paid pin add. Missing fresh-wrapper gate is unavailable;
historical profiles retain their original behavior. Scoped fresh health uses
`x-pirate-community` and `x-pirate-owner-grant` and checks the selection/reference;
a health response is never managed admission. No deferred moderation is enabled.

Cryptographic identity validation, canonical reads, original status/receipt
reconciliation and settlement retain exact signature, scope, current authority,
account, lease and request fences after expiry/revocation. They do not obtain a
new window. New reservations, provider sends and broadcasts recheck live
eligibility after awaits. Authenticated completed attachment observations may
be recorded after expiry but do not confer installation/start readiness.
Authoritative absence clears only the pending hold: an explicit retry uses the
same original bytes and requires a live window. Unknown remains held.

Public deployment still requires real hosted enrollment AND top-up Worker
composition; real V3 Directory/Posts deployments with source/runtime pins,
registrar/funder roles and caps; authenticated Pirate grant selection/admission
and configured limits/window; preprovisioned publisher managed custody; Native
managed producers and the pinned helper asset/header composition. Real MOSS
prompts, public-provider wrapped verification and the resulting first-song
publication/playback remain manual acceptance gates. Missing joins fail
unavailable. Existing Alchemy-owned provisioning is unchanged. Storage/disposal
limits stay explicit; backup, restore, upgrades, learning, Dance and naming are
outside this slice.

The signing mechanism follows [MOSS Sign Data](https://moss.megaeth.com/developers/methods/signing/sign-data)
and [viem public verifyMessage](https://viem.sh/docs/actions/public/verifyMessage).
Existing real evidence is preserved in
[the MOSS consent probe](../evidence/moss-consent-probe-2026-11-04.json) and
[the MOSS activation and ERC-1271 record](../deployments/learning-results-testnet-20261106.moss.json).
Those records establish earlier actual SDK/account verification mechanisms,
not this Web2 authorization or deployment's acceptance. The workspace coordinator
also supplied the prior guarded-recovery record, section 1005–1080 of
`tasks/records/pirate-manual-rewards-testnet-20261107.md`: HTTPS ancestor repair
enabled actual Connect/Approve, and canonical evidence recovered an original
operation after a lost callback. This slice preserves the same conservative
retention and reconciliation principle without importing the older consent,
grant or deployment policy.

Validation commands, candidate source digests, failures and remaining acceptance
are recorded privately under `.local/web2-owner-signing-implementation` for the
coordinator's exact-source review. Real paired MOSS signing, public RPC wrapped
verification, publisher custody and first-song publication/playback remain
manual qualification after the real compositions and deployment inputs exist.
