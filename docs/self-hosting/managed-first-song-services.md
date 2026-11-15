# Managed first-song services

Status: source-only composition, unqualified. No build, typecheck, integration
case, migration, Alchemy apply or deployment has been run for this change.
The installed native first-song qualification is historical evidence for its
own immutable release; it does not qualify this service composition.

This profile is the managed Web2 first-song service subset: a per-community
Pirate grant admission service, existing owner pins-only release handlers and
the existing shared recognition runtime. It supports MegaETH testnet 6343,
with disposable local chains for integration. It does not claim full protocol
revision 5 or M1 conformance. Learning publication, Dance, naming, HNS, Spaces,
backup/restore and automatic upgrades are outside this profile.

## Authority and provisioned inputs

Only the Pirate provisioning process may produce a
`pirate.managed-publishing-registration/1`. It must explicitly select an
existing `OwnerBudgetGrant`, its finite validity window and every service
limit. Validator maxima are safety bounds and must never be used as policy
values. The producer supplies an authenticated admission reference and signs
this registration using the existing `pirate.local-signed-record/1` format.
The independently installed Pirate public trust anchor authenticates that
signature. A request, community application or operator browser never chooses
the issuer, grant, RPC endpoint, key reference, generation, limits or window.

The registration binds the complete frozen W1 `OwnerGrantScope`, pinned Web2
deployment, exact configuration digest, existing original registration plan
and signed transaction, publisher custody reference/generation/digest and an
installation-scoped credential digest/reference/generation. The scope includes
enrollment, Directory installation and host installation, community, origin,
controller, nominated owner, policy, chain, Posts and publisher. The publisher
custody digest is the existing W1 digest of its four selected binding fields.
The credential is a high-entropy installation capability, not a Pirate sponsor
or issuer signing key. Provision it through the managed key channel separately;
only its digest and reference enter the registration.

The issuer's signature establishes the off-chain admission decision, including
owner nomination and custody attestation. The installation/enrollment mapping
is an issuer assertion. Its content digest alone cannot prove that decision or
prove external custody. The service separately reconstructs and authenticates
the original registration transaction with the existing binder/observer, then
reads current safe Directory configuration and pinned Directory/Posts source.
It checks current controller, publisher, origin, policy, installation, community,
configuration digest, code hashes, safe-block identity and explicit freshness.
A changed configuration requires reviewed new admission; it never mutates an
existing original. This intentionally freezes the admitted revision-1 profile.

`provisionManagedPublishingInputs` is the callable manual pilot producer. After
an explicitly reviewed schema migration, the provisioning process gives it the
signed configuration and separately installed trust anchor. It retains the
installation epoch/restore anchor and exact signed originals in D1, then calls
existing `claimOwnerWindow`. It cannot reactivate revoked records or replace
originals. A provisioning marker remains unavailable until its owner window is
claimed. Retries require the retained complete window, ceilings and counters;
missing counters produce `managed_provisioning_unknown` instead of recreating
budgets. An interrupted/conflicting provisioning attempt is not readiness;
reconcile its retained rows before a further controlled attempt. No HTTP path
invokes provisioning or recreates a missing installation.

`provisionSharedRecognitionInputs` explicitly admits the separate recognition
D1 installation. Its signed configuration supplies the public recognition
profile, provider-project binding, epoch/restore anchor, explicit finite
service/community quotas and admitted signed community registrations. Actual
ACRCloud identify credentials, catalog token and recognition signer are
server-only secret bindings. Their existence and binding must be checked;
provider association evidence is an issuer attestation requiring independent
provider qualification before use. Public local fixture keys are refused with
public RPC profiles. No mainnet application deployment is supported.

## HTTP originals and attachment state

The managed service accepts POST requests at:

- `/v1/managed-publishing/prepare`, with exactly `{scope}`;
- `/v1/managed-publishing/attach`, with exactly `{selectionDigest}`;
- `/v1/managed-publishing/reconcile`, with exactly `{selectionDigest}`.

Each request uses the exact configured HTTPS origin, an installation Bearer
credential, `x-pirate-installation` and `x-pirate-admission`. A supplied Origin
must equal the service origin. Bodies are bounded at 32 KiB. Credentials are
compared through fixed-size digests with a timing-safe comparison. The service
never redirects a credential-bearing request. Linux calls have a 15-second
transport budget and a 64 KiB response limit. There is no browser key bridge.
Do not log authorization headers, credential bytes, secret bindings or keys.

Prepare persists the exact scope, grant, selection digest, admission reference
and registered custody/issuer original. An identical retry returns the same
selection; changed bytes conflict. The selection is the existing
`pirate.web2-configured-owner-grant/1` envelope. Its digest is `hashJson` of the
body excluding `selectionDigest`; authority comes from configured issuer
signature plus the authenticated service, not from that digest.

Attach retains an `attaching` marker before claiming the existing owner window.
It rechecks D1 revocation/current canonical authority and time after awaited
boundaries, then durably records `attached` before acknowledging. An incomplete
marker is `unknown`. A retained prepare that has never begun attachment is
`absent`. A missing row, inaccessible database or lost response is never proof
of absence. Linux returns an observation bound to the same original with state
`unknown` after transport uncertainty; it performs no automatic attach retry.
Reconcile the same original before deciding what to do next.

Reconciliation authenticates the retained original registration and preserves
historical attachment acknowledgements after expiry, revocation or removal from
the active configured registry, while its original issuer trust remains pinned. Such a receipt does not authorize new work. New service
work still checks the current grant time, D1 registration and canonical roles.
Existing `claimOwnerWindow` and `reserveOwnerBudget` keep counters and all five
ceilings keyed by the original owner/community/policy/window. Replacement grant
hashes and configuration changes cannot replenish a window. No budget reset or
cleanup is part of this flow.

Managed attachment and application attachment are separate systems. Readiness
requires W1's retained application acknowledgement and an actual managed
acknowledgement for the same selectionDigest, grantDigest and admissionReference.
A managed receipt cannot substitute for application attachment. A generic fresh
GET `/health` explicitly returns `ownerRelease.configured:false`. The owning
runtime consumer must add `x-pirate-community` and `x-pirate-owner-grant` for a
scoped health read; the scoped response checks an attached original, current
authority, lifetime and release credential/signer configuration. This consumer
join remains with W1; it is not implemented by changing the historical runtime
in this source slice.

## Worker composition and package selection

`services/managed-publishing-worker.ts` explicitly selects `managed-web2`,
`historical-owner` or `historical-registered`. There is no fallback from a
missing fresh admission to a static grant. The fresh profile accepts catalog
owner release paths and delegates them to the existing managed handler with
one trusted journal-selected grant/pairing/deployment. Canonical calls and pin
dispatch recheck admission/current configuration. The historical profiles retain
the existing registered/static-owner behavior. Historical automated moderation
is not enabled in the fresh catalog profile.

`services/shared-recognition-worker.ts` exports real awaited fetch, typed queue
and scheduled handlers. It builds the existing `sharedRecognitionRuntime` from
event-owned captured inputs, actual D1/Queue bindings and a real server account.
Its canonical clients select only admitted pinned deployments. The separate
recognition DB holds recognition journals; `ADMISSION_DB` is the managed D1
binding used to recheck the exact active attached grant before and after
canonical reads. There is no isolate-global mutable authority registry.
The existing runtime retains its policy, quota and receipt behavior. Cron
recovery enqueues existing due originals; it does not generate outcomes.
Unsupported cancellation/withdrawal refuses instead of fabricating evidence.

The new `managedWeb2ServicesPackage` / `writeManagedWeb2ServicesPackage` APIs in
`harness/managed-package.ts` select fresh packages explicitly, build both real
bundles and retain transitive owned source, dependency lock and schema hashes.
The existing historical packager defaults remain unchanged. The fresh writer
checks bundle identity and links the existing verified managed dependency tree.
It does not choose or reserve migration ordinals. Integration must supply
reviewed distinct migration filenames after reviewing the current ledger.
The new admission SQL and existing recognition schema remain unnumbered source
in this change, and nothing has applied them.

Alchemy remains the sole infrastructure owner. A fresh package requires
`MANAGED_SERVICE_PACKAGE_PROFILE=managed-web2` and a distinct reviewed
`MANAGED_WEB2_PREFIX`. Its separate encrypted stack owns managed D1/R2/Queue
and the independently scoped recognition D1/Queue/Worker/consumer/cron. Both new
Workers use compatibility date 2026-11-15 and enable logs and traces. Historical
stack identity, default date and migration files stay unchanged. No Wrangler
configuration is introduced. Secret source remains Infisical. Configured public
origins must actually route to their respective Workers before qualification;
returned workers.dev URLs do not automatically satisfy signed origin bindings.

Queue and scheduled handler lifetime behavior follows the official
[Queues JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
and [scheduled handler documentation](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).
The installed local Miniflare/workerd fixture uses its supported 2026-08-06
compatibility target for semantic checks. That is not deployed qualification of
the new 2026-11-15 date or public provider behavior.

## Linux binding and remaining qualification

`provisionWeb2ManagedServiceInputs` validates the signed Pirate registration and
publisher enrollment policy, then uses an existing host key-channel reference
to sign only the installed managed-input record. No key is generated or rotated.
`createWeb2ManagedServiceInputs` authenticates that installed record, pins the
issuer, admission, origin, installation, publisher reference/generation and
credential reference/generation, and supplies W1's existing grant and publisher
ports. It uses `withSecret` only inside the credential-bearing bounded request
and W1's existing `createWeb2PublisherProofSigner` for exact enrollment proof.
The signer reconstructs only the retained enrollment challenge and keeps its
original lease/generation/address checks. It is not an arbitrary signing API.

Integration must join the three frozen W1 modules and scoped health consumer,
assign/apply reviewed schema ordinals, provision real signed registrations and
custody references, install per-installation credentials, configure real
provider association/credentials and dedicated signers, qualify origins and
perform exact-candidate types, bundle/schema/dependency checks, HTTP/D1/queue/
scheduler/key-channel integration and a fresh installed first-song journey.
Tests produce sanitized repeatable artifacts under
`.local/managed-first-song-service-tests/` only when actually run. No artifact
or successful result exists for these new cases yet. Preserve failed cases and
original journals; never replace them with an invented ready receipt.

Persistent service data includes encrypted Alchemy state, both D1 journals,
managed media and outside catalog/provider records. Ordinary process restart
must retain those originals. Tested source here is not a supported backup,
restore or disposal procedure. Automated upgrades/restoration, historical chain
retention and cross-host recovery remain unqualified and deferred. Disposing
an installation requires explicit treatment of each retained store and outside
provider obligation; deleting local state does not prove external deletion.
