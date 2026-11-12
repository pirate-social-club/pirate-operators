# Portable storage boundary

`packages/community-setup/storage.ts` validates a versioned, nonsecret storage
profile. Public IPFS publication defaults to the existing Filebase pinning
flow. Private object and backup destinations default to Filebase object storage.
B2 and operator-controlled custom S3 endpoints are explicit alternatives.

The public IPFS profile has no bucket or S3 credentials. It must continue through
the existing pinning token, publication authorization and CID verification flow.
An object-storage adapter does not provide IPFS pinning or a CID.

Private Filebase profiles use `https://s3.filebase.io`, region `auto`, and the
selected bucket. These settings follow the current
[Filebase S3 documentation](https://filebase.com/docs/s3-api/overview), rather
than the Files SDK adapter's older default endpoint. A profile requests private
storage; it does not inspect or change the bucket's access policy.

B2 requires the bucket's cluster region and derives the matching S3 endpoint.
Custom S3 requires an explicit endpoint and region. HTTPS is required except for
literal localhost loopback destinations used in local development. Custom
destinations are operator configuration, not untrusted request parameters.

Profiles reject credential fields, pinning tokens, secret references, public URL
overrides and readiness flags. They preserve explicit provider choices and can
be serialized into setup state. Nothing currently saves them into the wizard.

## Server transport

`packages/storage/files.ts` is a Node operator/backup boundary using
`files-sdk/effect` and the native Filebase, B2 and S3 adapters. The SDK and its
native S3 peers are pinned in the owning manifest and lock. The AWS client
libraries speak S3; their use does not require an AWS account or AWS hosting.

Call `createObjectStorage(profile, credentials)` with credentials resolved in a
separate server secret scope. Both access-key fields are required explicitly;
the factory does not fall back to environment or instance-metadata credentials.
Filebase's IPFS pinning token is not an S3 access key. The returned `profile` is
nonsecret; the returned client and layer remain server-side.

The result exposes the real Files client, its Effect layer and `close()`. Provide
the layer to Effects that yield `Files` from `files-sdk/effect`. After operations
and downloaded body streams finish, call `close()` in `finally` to destroy the
native S3 client. The Effect service supports streaming downloads and the native
adapter supports multipart uploads of unknown-length streams. Capabilities come
from the actual SDK adapter; this boundary does not enable conditional writes
or permanent public URLs by configuration.

Backup callers must encrypt a self-contained archive before uploading it and
retain a usable independent recovery key. This transport does not implement
encryption, a backup schedule, retention, verification or restore. A successfully
constructed client establishes none of those properties.

## Verification and remaining integration

On 2026-11-12, the full repository `npm run check` and local Worker packaging
passed on commit `5662e915`. The run included all twelve storage cases, 1,659
Node passes with one existing optional skip, 248 Forge passes, and acceptance
with scope `local-skeleton/1`.

The focused tests exercise profile validation and the real SDK's Effect layer,
native adapters, signing, serialization, multipart assembly and body streaming.
The S3 request handler is replaced with an in-process protocol fixture before
operations. No network sockets or provider calls are used. This verifies the
boundary against that fixture; it does not qualify Filebase/B2 service behavior,
TLS, network interruption, workerd compatibility or a production backup.

Current application handlers still use R2 bindings, and Alchemy still provisions
their Cloudflare infrastructure. Neither consumes these profiles yet. The next
increment must give storage its own server secret/configuration scope, connect
the wizard's profile selection and review to that scope, then route an actual
operator upload/backup through it with restore verification. Runtime R2
replacement needs separate native workerd qualification or a local storage
service. A configured destination must not appear as connected or recoverable
until those operations have actually passed.
