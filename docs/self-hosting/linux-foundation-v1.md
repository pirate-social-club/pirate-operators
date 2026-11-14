# Linux runtime foundation candidate

This increment is a qualification candidate for Linux amd64, not a supported
community deployment. It separates a genuine source artifact producer from
image assembly and runs the actual application entrypoint with native workerd,
local D1-compatible SQL and R2-compatible objects. The backend modules are
unchanged Miniflare 4.20260730.0 source, used directly by workerd 1.20261110.1.
The Miniflare supervisor is not started. Native localDisk is experimental and
the package declares an older workerd dependency. Container compatibility,
storage lifecycle and upgrades require actual qualification.

## Explicit community composition

The Linux entrypoint requires a validated server deployment profile. It has no
fallback to First Song. Fetch, configuration history, public reads, queue and
scheduled consumers receive the same origin, community, directory and posts
identity. The existing First Song consumer supplies its explicit default data.
Endpoint and schema validation do not establish registry authority, provider
connectivity or feature readiness. Chain code, event, configuration and content
checks remain in the real handlers.

A hosting origin can be a TLD or an SLD. It does not determine the issuance
namespace or grant control of its parent or siblings. Controlled-TLD import and
authority verification remain separate requirements. No custom browser or
resolver behavior is introduced here.

## Artifact and process boundary

After the actual live assets are built, the admitted source producer calls
buildCommunityArtifacts with the Linux target and records owned Git source,
Worker, asset, SQL, backend and runtime hashes. A source archive is not a
substitute for that genuine Git topology. The Docker context contains sealed
artifacts and runtime files; its Dockerfile performs no package installation,
source build or provider command.

The candidate image pins the official Node 24.18.1 Bookworm slim linux/amd64
manifest. Compose runs an unprivileged initialization process before the
application. It uses fresh private bind directories, a read-only image,
dedicated internal network and a loopback-only published TLS port. No engine
socket is mounted into a container. Initialization uses an unexposed Unix
socket and sealed SQL, with a durable migration ledger and atomic per-migration
batches. Serving refuses a missing or different release marker.

The foundation deliberately has no JOBS binding, scheduler, Learning operator,
managed service, creator process or private-media renderer. Its selector
disables those optional features and startup refuses another composition.
This is a diagnostic profile, not a replacement for the selected complete
community. Default app configuration, chain and content dependencies remain
real; they are not replaced by fixed responses, an offline verifier or an
HTTP invocation envelope. Without configured peers, their real routes fail.

## Acceptance and recovery

The first container gate must verify actual image and process identities,
asset bytes and MIME types over TLS, wrong-host refusals, native migration and
object state, clean stop, restart and a complete cold state copy reopened in
a fresh directory. It must preserve all namespace metadata, SQLite files and
sidecars, object bytes and release markers. Same-host reopening does not prove
independent-machine or user recovery.

Before full create/restore, qualify two independent communities through genuine
chain and content services, actual sign-in, state isolation, durable jobs and
selected service processes. Integrate authenticated wizard control and a real
Linux runner. The full backup cohort must be quiesced, authenticated and
encrypted, transported with the reviewed Files SDK boundary, and recovered
with a separate key. Filebase remains the preferred destination where its
verified role fits; B2/custom S3 and a self-hostable alternative remain optional.
Public pinning, private objects and backup transport remain distinct roles.

Restore must not reopen access revoked after the snapshot. Reauthentication
alone does not settle credential-binding or authority revocation; choose and
qualify that policy before enabling restored user operations. Full HTTPS and
generic Handshake browser acceptance, second-machine restore, interrupted jobs,
upgrades and release checks remain mandatory later work.
