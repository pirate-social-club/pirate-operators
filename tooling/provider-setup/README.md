# Provider setup rehearsal

This is the stage-one developer runner for the next community's onboarding.
It is separate from the active wizard and first-song runtime. It does not
implement the packaged wizard, deploy a community, register a song, publish
IPNS or use Filecoin. No live-provider acceptance follows from local tests.

It creates one Filebase IPFS bucket, one ACRCloud recognition project and one
OpenAI project/service account, separately selectable. Resources are retained
for the later wizard rehearsal. The runner has no delete or rotation operation.
Its persisted plan and journal contain identifiers and receipts, never keys.
Returned recognition/model keys go directly to the selected Infisical runtime
folder with exact readback. Setup credentials remain in a separate bootstrap
folder; Filebase account keys are never copied to runtime.

## Prepare credentials when the reviewed runner is ready

The first qualification should use a fresh free Filebase account with no
buckets. Keep it empty: the runner creates its bucket and refuses an account
containing another bucket. Filebase account keys are account-wide and Filebase
documents one key pair per account. Do not rotate an existing application's
pair to prepare this test. A new ACRCloud account is useful for observing fresh
signup and catalog access. An existing OpenAI organization can supply an Admin
API key for a new project/service account. No new subscription is assumed;
working access and sufficient available quota/credits determine acceptance.

Sign into Infisical with `infisical login`. First-time account signup/sign-in
still involves the owner. The secure entry command below creates the bootstrap
folder and stores these values without opening the secrets dashboard or typing
their names. Keep values out of chat, shell arguments and repository files:

| Secret | Owner action | Use |
| --- | --- | --- |
| FILEBASE_ACCESS_KEY_ID | Copy the S3 Compatible API field labelled Access token. | Setup-only S3 signing. |
| FILEBASE_SECRET_ACCESS_KEY | Copy the same section's field labelled Secret key. | Setup-only S3 signing. |
| ACRCLOUD_CONSOLE_TOKEN | Create a token in the fresh account's Console Developer Settings. | Create/reconcile its recognition project. |
| OPENAI_ADMIN_KEY | Create an Admin API key in the selected OpenAI organization. | Create/reconcile a new project and service account. |

### Secure terminal entry

From the repository root, inspect the selected target without authentication:

```sh
node tooling/provider-setup/run.ts credentials --provider filebase \
  --project-id PROJECT_UUID --environment staging \
  --bootstrap-path /onboarding/provider-rehearsal/bootstrap
```

Append `--execute` to prepare the folders and enter credentials. This command
uses the verified Infisical CLI login, shows the nonsecret destination, and
prompts for Access token, then Secret key, matching Filebase's dashboard labels,
with terminal echo disabled. Paste each value and
press Enter. It requires a real local terminal; piped input is refused before
authentication. Values are passed in memory directly to the Infisical SDK,
read back for exact equality, and omitted from output. They never enter command
arguments, shell history or plaintext files. The command creates no placeholders.

Existing valid entries are retained by default. An incomplete pair, empty value
or recognized placeholder stops the command. Explicit `--replace` asks for the
values again and permits replacing existing entries in this selected folder.
All missing/replacement inputs are collected before any secret write; cancelling
entry writes neither Filebase value. A failed write can leave a partial vault
result, which is reported as incomplete. Readback resolves lost write responses;
a partial pair can be repaired with explicit replacement of both values.

This is a credential-store preparation operation, not provider qualification.
Its `--execute` authorizes only the selected Infisical folder/secret writes;
provider requests still require the separate immutable plan and exact digest.
Use `--provider acrcloud` or `--provider openai` for the corresponding setup token.
Linux xterm-compatible terminal entry, cancellation, backspace and echo restore
are exercised in real pseudo-terminal tests with synthetic values.

For the Filebase-first run only its two values are needed. Keys can be provided
one provider at a time. The operator supplies the nonsecret Infisical project
ID/environment and OpenAI organization ID in the profile. This source runner
does not implement the future wizard's account pickers.

The runtime folder is `<runtimePath>/<intent UUID>` and is prepared by the
runner. Future Worker secret access must be scoped to runtime, excluding the
bootstrap folder. The personal CLI login has broader account permissions; a
folder name does not restrict that login's authority. Only cloud Infisical is
supported by this rehearsal; instance/profile selection remains future work.

Filebase's [S3 Compatible API credentials page](https://console.filebase.com/keys/s3)
provides Access token and Secret key for automatic bucket creation and S3
uploads. An IPFS bucket can also be addressed through the separate IPFS RPC API.
The application's RPC bearer credential is a separate setup concern. The S3
pair is not the console's short-lived RPC token. The wizard should show this
direct S3 link beside its matching field labels.

## Install and plan

Use Node 24 on Linux. From this directory run `npm ci --ignore-scripts`, then
`npm run check`. These tests use explicit fake providers, including real S3
request signing/CAR parsing and the actual runner entry point. They need no
keys and can run with external networking disabled. Existing root checks are
separate and unchanged. This package is not the distributable operator wizard.

Copy `profile.example.json` to a private file outside every repository with
mode 0600. Replace its placeholder project ID and choose the
bootstrap/runtime folder paths. Do not add secret fields. Create a new private
state directory with mode 0700. From the repository root, initialize it:

```sh
node tooling/provider-setup/run.ts init \
  --profile /absolute/private/provider-profile.json \
  --state-dir /absolute/private/provider-state
node tooling/provider-setup/run.ts provision \
  --provider filebase --state-dir /absolute/private/provider-state
```

Both commands are non-network planning operations. The second prints the
saved plan without authenticating. Review its intent, exact resource names,
vault scopes and request limits, and retain its `planDigest`. The plan is
immutable. Reopening uses the same state directory; do not initialize a new
intent to escape an uncertain create or lose the resources intended for stage
two. No native transactions or community deployment are part of this profile.

`openaiOrganization` is optional for a Filebase-only plan. OpenAI provisioning
requires the actual organization in that provider's plan, before any key read
or provider call. Different provider intents may retain separate receipts and
runtime references; the later wizard must reuse the already qualified resources.

## Run the bounded provider test

Only after exact-source review and the owner credential handoff, append
`--execute --approve PLAN_DIGEST` to provision the selected provider:

```sh
node tooling/provider-setup/run.ts provision \
  --provider filebase --state-dir /absolute/private/provider-state \
  --execute --approve PLAN_DIGEST
node tooling/provider-setup/run.ts qualify \
  --provider filebase --state-dir /absolute/private/provider-state \
  --execute --approve PLAN_DIGEST
```

Filebase creates a unique bucket, uploads at most one tiny public test object
as a CAR with `import=car`, verifies the returned root CID, and retrieves and
checks the exact original bytes through Pinata. The IPFS S3 endpoint is
`s3.filebase.com`, region `us-east-1`; the general object-storage `.io` endpoint
is not substituted. Independent retrieval is limited to five requests per
intent. A lost upload response reconciles through object metadata. A retrieval
failure never triggers another upload. No media or private test clips enter
this public object. Successful API use qualifies the actual account/route,
not an unlimited free plan or all remote-pinning endpoints.

### Optional read-only RPC compatibility experiment

Before initializing its plan, set `filebaseRpcCheck` to
`sdk-base64-read-only` to allow at most three RPC reads after the S3 probe and
independent retrieval have passed. Plans without this field do not call RPC
and retain their original limits. The experiment constructs a candidate using
the published Filebase PinManager's base64 account-key/secret/bucket format and
sends it only to `https://rpc.filebase.io/api/v0/pin/ls`, filtered to the exact
verified probe CID, with redirects refused. Base64 preserves the account pair's
authority; it is not attenuation or encryption. The pair is sent to Filebase
inside this TLS request. The exact execution plan must explicitly allow that
credential use; it is never implied by a successful S3 upload.

The SDK documents this format for its Pinning Service API, not the RPC API.
This experiment measures whether RPC accepts it. A rejected candidate is saved
as a negative result; unknown reads can retry within the durable bound. No token
is minted, persisted, exported to runtime or printed. Even a successful read
does not prove bucket confinement, expiry/refresh, RPC write capability or full
application publication. The console's short-lived RPC tokens may use another
format or issuance path. These qualifications must be settled before claiming
the community's RPC runtime credential is ready.

ACRCloud discovers the built-in `ACRCloud Music` catalog or stops for catalog
confirmation. The documented list endpoint's availability for a fresh account
is unqualified. A confirmed catalog ID can be specified as `musicBucketId`
before plan initialization; no example ID is hardcoded. The created project
must report exactly that built-in catalog, AVR, line-in audio and the selected
region. Reported daily/total limits are kept as configured fields, including
zero without inventing its meaning. Remaining free quota is not inferred.

Before initializing an intent that will qualify ACRCloud, add `samples` with
`positive` and `negative` objects, each containing the absolute `path` and
lowercase SHA-256 of a private MP3 file. Each file must be owned by the user,
mode 0600 and at most 4 MB. The positive control is a short known commercial
recording excerpt used only for recognition; the negative control is an
unmatched original sample. Recognition receives those private clips; they are
not publicly pinned. Qualification permits exactly one request per control.
A positive match and a negative non-match must both pass; no match alone does
not prove the selected catalog works. A no-samples plan can provision ACRCloud
but cannot pass its qualification; it does not silently use another clip.

OpenAI creates one project and one project service account. Its one-time
runtime key is retained directly in Infisical. Qualification permits one free
moderation request and one separate classification request using the current
application model, `gpt-4.1-mini-2025-04-14`, with fixed short input and maximum
256 output tokens. The latter uses billed API capacity. This checks access;
the production moderation policy still needs its own application acceptance.
The runner does not configure a hard account billing limit or infer a price.

Use `--provider acrcloud` or `--provider openai` for the same provision/qualify
commands. `status --state-dir ...` reads saved evidence without authentication.
No setup token is forwarded to recognition/model requests or runtime storage.

## Recovery and pending acceptance

The private journal is atomically replaced and synced under an exclusive
process lock. Normal termination releases the lock; SIGINT/SIGTERM aborts
requests and releases it after unwinding. A hard kill can leave a lock: inspect
the recorded PID and journal before any reviewed stale-lock recovery. There
is no automatic lock removal, journal reset, resource deletion or key rotation.

Lost ACRCloud/project creates reconcile exact intent-specific names and
bindings. Filebase reconciles the same bucket/object and account identity.
Ambiguous or absent results block instead of creating replacements. OpenAI's
one-time key cannot be re-read: if it was not durably retained in the vault,
the runner stops for owner recovery. A matching retained key can recover after
a vault response is lost. Unknown/failed recognition or model requests are not
automatically repeated; a separate reviewed recovery must authorize any new
request. Bad setup authentication fails in read-only preflight before creation.

Filebase bucket-token effective scope, RPC token compatibility, remote repinning
on the fresh free account, runtime credential delivery and full media playback
remain unqualified. Filebase's account pair remains setup-only even if this
probe succeeds. No W3/W12 or complete second-community acceptance is claimed.
Wizard wiring waits until the first song and coordinator integration checkpoint.

API provenance: [Filebase IPFS upload/CAR import](https://filebase.com/docs/ipfs/pinning/pinning-files),
[Filebase account keys](https://filebase.com/docs/concepts/access-keys),
[ACRCloud projects](https://docs.acrcloud.com/reference/console-api/base-projects),
[ACRCloud Console token](https://docs.acrcloud.com/reference/console-api/accesstoken),
and [OpenAI project/service-account credentials](https://developers.openai.com/api/docs/guides/api-keys).
No credentials, provider calls or paid capacity were used to write or test this
package. Its first live run is a distinct qualification step with the owner.
