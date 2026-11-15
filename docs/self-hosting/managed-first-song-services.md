# Managed first-song services

Status: fresh managed composition under finite local qualification, unqualified
for deployment. The correction-v4 review packet records actual commands, source
hashes, results and retained failures. Earlier source-only packets retain their
original UNRUN status. No Alchemy provider apply or deployment is authorized by
these local checks.
The installed native first-song qualification is historical evidence for its
own immutable release; it does not qualify this service composition.
Both product PR merges are held until owner morning, including changes to
Alchemy/deployment settings even if later gates pass. Physical MOSS and live
inputs also wait morning. This source packet authorizes no deployment or merge.

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
D1 installation. Both signed journal digests must be complete canonical bytes32
strings; LF, CRLF and Unicode line terminators refuse before an installation row
is created. Its signed configuration supplies the public recognition
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
and registered custody/issuer original. Prepare also reselects an existing exact
durable original after expiry, revocation, disablement or active-registry removal.
It returns the stored selection without claiming a window or creating anything.
A missing/fresh original still needs live eligibility; changed bytes conflict. The selection is the existing
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
Reconcile the same original before deciding what to do next. An existing durable
attached acknowledgement can be returned after expiry without another effect.
An attaching marker remains unknown; it cannot be promoted by repeating attach.
An authenticated absent observation permits only same-original retry while live.

Reconciliation authenticates the retained original registration and preserves
historical attachment acknowledgements after expiry, revocation or removal from
the active configured registry, while its original issuer trust remains pinned. Such a receipt does not authorize new work. Historical journal identity is
separate from fresh external eligibility and survives an RPC outage; it records
what the service actually authenticated before the durable prepare/attachment,
not a fresh assertion about current external chain state. New service
work still checks the current grant time, D1 registration and canonical roles.
Existing `claimOwnerWindow` and `reserveOwnerBudget` keep counters and all five
ceilings keyed by the original owner/community/policy/window. Replacement grant
hashes and configuration changes cannot replenish a window. No budget reset or
cleanup is part of this flow. Apply revocation/disablement to the durable journal
through the controlled producer before updating deployment configuration. A
configuration swap cannot retroactively change an in-flight Worker environment;
the atomic reservation predicate and final dispatch read use durable D1 state.

Managed attachment and application attachment are separate systems. Readiness
requires W1's retained application acknowledgement and an actual managed
acknowledgement for the same selectionDigest, grantDigest and admissionReference.
A managed receipt cannot substitute for application attachment. A generic fresh
GET `/health` is refused without both exact scope headers. The owning
runtime consumer must add `x-pirate-community` and `x-pirate-owner-grant` for a
scoped health read; the scoped response checks an attached original, current
authority, lifetime and release credential/signer configuration. This consumer
is present in the combined committed source at
`services/first-song-runtime.ts`; each exact-candidate local result is recorded
in the v4 packet. This source slice does not edit that shared consumer.

## Worker composition and package selection

`services/managed-publishing-worker.ts` explicitly selects `managed-web2`,
`historical-owner` or `historical-registered`. There is no fallback from a
missing fresh admission to a static grant. The fresh profile accepts catalog
owner release paths and delegates them to the existing managed handler with
one trusted journal-selected grant/pairing/deployment. Canonical calls and pin
dispatch require the shared managed admission gate. Its final interface and
consumer are present in the combined base; local results and remaining external
qualification are recorded separately in the v4 packet.
The historical profiles retain the existing registered/static-owner behavior. Historical automated moderation
is not enabled in the fresh catalog profile.
Accordingly the fresh App omits only the deferred OPENAI_API_KEY binding. Its
canonical MODERATION_SIGNER_PRIVATE_KEY and selected provider secrets remain
required Config.Redacted inputs. Historical App secret requirements, including
OpenAI, stay intact. Signing-only has no secret Config bindings. Qualification
collects the actual selected Alchemy resource program and resolves its real
Config values through an explicit isolated fixture ConfigProvider; no cloud
provider, real secret store or blank production credential substitutes for it.

`services/shared-recognition-worker.ts` exports real awaited fetch, typed queue
and scheduled handlers. It builds the existing `sharedRecognitionRuntime` from
event-owned captured inputs, actual D1/Queue bindings and a real server account.
Its canonical clients select only admitted pinned deployments. The separate
recognition DB holds recognition journals; `ADMISSION_DB` is the managed D1
binding used to recheck the exact active attached grant before and after
canonical reads for new effects. Signed status requests retain original identity
authentication without applying a new-effect eligibility decision. Entry and
canonical boundaries check live admission for new work. The combined base includes Alpha's
final cf173 upload guard: it authenticates owner authority and samples the
original window synchronously after awaited preparation, immediately before
upload. It requires no new SharedRecognitionRuntimeInputs, CanonicalCommunity,
configured-runtime, wire or grant constructor join. Identity checks alone after
a delayed await do not authorize a fresh upload. Retained read/status must still
work. Alpha's separate results do not qualify these owned integration cases. There is no isolate-global mutable authority registry.
The existing runtime retains its policy, quota and receipt behavior. Cron
recovery enqueues existing due originals; it does not generate outcomes.
Unsupported cancellation/withdrawal refuses instead of fabricating evidence.

The new `managedWeb2ServicesPackage` / `writeManagedWeb2ServicesPackage` APIs in
`harness/managed-package.ts` select fresh packages explicitly, build both real
bundles and retain transitive owned source, dependency lock and schema hashes.
The existing historical packager defaults remain unchanged. Fresh writers refuse
an existing deployment directory before overwriting package/profile artifacts;
retain and reuse an already generated immutable package rather than rewriting it.
The fresh writer checks bundle identity and links the existing verified managed dependency tree.
It does not choose or reserve migration ordinals. Integration must supply
reviewed distinct migration filenames after reviewing the current ledger.
The admission SQL remains unnumbered, unchanged source. Root assigns generated
copies `0005_managed_publishing_admission.sql` after the existing managed0001–0004
ledger and `0001_shared_recognition.sql` for the separate new recognition DB.
That recognition source already includes reservations: never also apply
reservation-schema.sql. Qualification applies only these copies in disposable
local engines and checks repeat application preserves ledgers/counters. No live
ledger, migration ordinal reservation or existing deployment database changes.

Alchemy remains the sole infrastructure owner. A fresh package requires
`MANAGED_SERVICE_PACKAGE_PROFILE=managed-web2` and a distinct reviewed
`MANAGED_WEB2_PREFIX`, explicit plan ID and expected canonical package digest.
The historical `pirate-managed-firstsong-20261105` prefix and its entire resource
namespace are forbidden for both new profiles. Package identity binds profile,
plan, prefix and `pirate-encrypted-local` state stack. Alchemy validates the
presence of the generated `managed-web2-package.json` first: a missing, empty
or incompatible profile selector refuses before any stack/state/provider
initialization for both fresh service and signing-only packages. Historical
defaults apply only without that fresh package marker. It then validates actual
generated package bytes and selected env identity before initializing
state/providers; the same checked prefix is passed to Alchemy.Stack and the
existing encrypted store uses state/<stack>/<stage>. Its separate encrypted stack owns managed D1/R2/Queue
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

Integration must qualify the committed W1 modules and scoped health consumer,
qualify the included Alpha live-effect guard, assign/apply reviewed
schema ordinals, provision real signed registrations and
custody references, install per-installation credentials, configure real
provider association/credentials and dedicated signers, qualify origins and
perform exact-candidate types, bundle/schema/dependency checks, HTTP/D1/queue/
scheduler/key-channel integration and a fresh installed first-song journey.
Tests produce sanitized repeatable artifacts under their configured evidence
directory (the default is `.local/managed-first-song-service-tests/`). The v4
qualification recorder selects a separate directory for each actual phase and
records UTC bounds, exit status, elapsed time, exact source hashes and failures.
Actual managed/recognition D1 journals remain in the inherited private temporary
root, with their paths recorded in the phase artifacts. Preserve failed cases
and original journals; never replace them with an invented ready receipt.

Persistent service data includes encrypted Alchemy state, both D1 journals,
managed media and outside catalog/provider records. Ordinary process restart
must retain those originals. This unexecuted source is not a supported backup,
restore or disposal procedure. Automated upgrades/restoration, historical chain
retention and cross-host recovery remain unqualified and deferred. Disposing
an installation requires explicit treatment of each retained store and outside
provider obligation; deleting local state does not prove external deletion.


## Shared effect gate and atomic original window

The combined base contains W1's final `ManagedAdmissionGate` in
`packages/release/managed-admission-gate.ts`, exposed through
`ManagedEnv["MANAGED_ADMISSION_GATE"]`. The own adapter uses that shared type;
there is no duplicate wire/grant declaration. Its methods are
`reservationCondition(grant, original)` returning ReservationCondition and
`beforeDispatch(grant, original)` returning Promise<void>. Reservation original
binds operationId, requestHash, asset and requested; dispatch original binds
operationId and requestHash. The closure captures the exact authenticated
registration revision, selection digest, admission reference, community and
publisher from trusted configuration/D1.

The committed `reserveOwnerBudget` invokes the supplier lazily only AFTER
checking an existing original's request hash and amount, and ANDs its result
with `ownerWindowCondition` in the SAME D1 reservation transaction. The own
predicate additionally requires `unixepoch() >= original.validFrom` and
`unixepoch() < original.expiresAt` alongside active original/revision, attached
selection and journal epoch/anchor checks. Thus expiry while a captured condition
waits cannot consume a reservation or counters. It neither replaces the owner
window predicate nor chooses new limits/windows. Identical authenticated replay
and settlement retain their original interpretation after expiry. Conflicting
replay still refuses; new work and final dispatch need live authority.

The shared consumer's `beforeDispatch` belongs after final awaited preflights
and immediately before actual paid ADD/send. A post-response refusal cannot
fence that effect. Source presence is not runtime qualification: actual HTTP,
D1 captured-condition expiry, lazy replay, settlement and dispatch regressions
are recorded separately for each actual v4 phase, including failures. Alpha's
final guard is already included; this slice does not edit its runtime/adapter
or invent an additional callback/constructor interface.

## Narrow signing-only HTTPS component

The explicit `operator-signing-only` profile serves `/operator-signing` and only
its pinned Vite manifest dependency closure. It routes before lazy backend
imports or env/D1/key/provider initialization. Every backend/health route and
queue/scheduled handler is unavailable in that profile. No grant, database,
provider credential, publisher key or funding input is needed to serve it.
Historical profiles keep their original routes. The static handler enforces
exact HTTPS origin/Host, GET/HEAD, fixed closure paths, response digest pins
and bounded files. The entry requires exactly
`/operator-signing?openerOrigin=` plus encodeURIComponent of the canonical public
`http://127.0.0.1:<explicit nonzero port <=65535>` origin. No localhost, IPv6,
duplicate/extra parameter, encoded key alias or alternate query encoding is
accepted. Assets remain queryless and encoded path aliases refuse. URL-normalized
dot paths outside the static route remain backend-unavailable 503 with no data.
It forwards no incoming cookies, authorization or signing data to the ASSETS binding.

W1 owns moss-signing.html, its JavaScript and the exact opener origin/source,
nonce, requestDigest and controller handshake. The committed source contract selects
`apps/community-wizard/dist/moss-signing.html` and its `.vite/manifest.json` entry
`moss-signing.html`, including recursive imports, dynamicImports, css and assets.
The v4 qualification builds this worktree's real Vite artifact, independently
records the emitted manifest and recursive file digests, and checks the actual
packaged bundles serving those bytes. The five-file retained closure includes
HTML, three JavaScript chunks and its manifest. These local artifact checks do
not qualify a public deployment or a real MOSS prompt. OperatorSigningBuildInputs
is this packager's bounded intake shape. The helper packager generates no HTML/JS
source and copies only the reviewed emitted closure. Synthetic static-boundary
fixture assets do not prove the real MOSS handshake.

The exact committed CSP is `default-src 'none'; script-src 'self'; style-src
'self'; img-src 'self' data:; connect-src 'self' https://*.megaeth.com; frame-src
https://*.megaeth.com; base-uri 'none'; form-action 'none'; frame-ancestors
'none'`. Responses use Referrer-Policy strict-origin, X-Content-Type-Options
nosniff, Cache-Control no-store, X-Frame-Options DENY and
Cross-Origin-Opener-Policy unsafe-none. Permissions-Policy is
`publickey-credentials-get=(self "https://account.megaeth.com"),
publickey-credentials-create=(self "https://account.megaeth.com")`. The Worker
requires that exact CSP, including only the specified MegaETH wildcards. This
keeps the bound opener intact; the postMessage source/origin/nonce/digest/
controller checks stay in W1's source. Raw requests and signing channel data do
not enter the URL or ASSETS request.

A qualified local top-level HTTPS signing-helper component may be tested with
real MOSS before a public VPS, public domain or full managed backend. The first
selected real MOSS environment is local. No actual MOSS prompt was run here.
The existing paired Wizard remains HTTP loopback-only; community TLS, CSP or an
iframe ancestor does not make that Wizard MOSS-ready. Do not expose or relax
Wizard Host/Origin rules or place keys/tokens in helper URLs or a JavaScript bridge.

The full public managed backend separately needs reviewed actual D1, queues,
provider/custody configuration, genuine admission/policy and deployment pins.
Public hosted enrollment/top-up factories are NOT mounted by this fourteen-path
Worker/Alchemy slice. A real registrar/funder Worker, routes/resources, caps,
funds, actual contract deployments/source pins and managed roles are missing
joins, not just missing URLs or keys. They are not added or deployed here.
