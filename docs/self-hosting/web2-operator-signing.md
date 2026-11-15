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

Three deployment inputs remain external: authenticated Pirate grant selection
and admission with configured limits/window; the preprovisioned publisher's
managed custody binding; and a useful paired URL permitted to embed MOSS.
Absent inputs are unavailable states. Existing Alchemy-owned provisioning is
unchanged. Storage/disposal limits stay explicit; backup, restore, upgrades,
learning, Dance and naming are outside this slice.

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
manual qualification after the three deployment inputs exist.
