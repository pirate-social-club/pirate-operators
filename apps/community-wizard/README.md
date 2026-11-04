# Community wizard v1

This is the runnable provisioning slice: a Solid browser wizard backed by a
trusted local Node runner. It reviews a fixed resource plan and invokes Alchemy
for an ordinary HTTPS setup page, D1, private R2 and a queue. It does not yet
provide the completed login, upload, moderation or first-song application.

## First-song test scope

The owner confirmed on November 4 that song contracts and flows must be testable
without waiting for Handshake. A genuine test registry and its admin can create
an unverified directory entry and publish through the selected publisher. HNS
delegation and a fresh namespace attestation gate verified Pirate discovery;
opening app.tld is a separate browser/transport check. Neither gates the first
song test. A factory event alone does not establish namespace ownership.

The wizard defaults to Pirate-operated moderation. Communities using that
service do not supply OpenAI/ACRCloud keys and those keys never enter their
Workers. Policy settings are deferred; existing publication rules apply,
including allowing explicit lyrics. Service pairing, authorized operator
identity, signed results and the actual checks still require integration.
Choosing a service is not evidence that it works. The advanced independent
operator path retains provider intake into that operator's Infisical scope.
Co-locating keys in its Worker does not by itself establish operator signing
identity; that is another release requirement.

The owner explicitly chose a capped operator budget for first-song test creator
activation, with no creator payment screen. Native Sui/Ika fees are paid by the
registration operator. Communities using Pirate's registration service do not
supply its treasury secrets. Creator checkout, pricing and refunds are deferred;
this test choice does not claim a permanent commercial pricing policy. The
service's balances, finite budgets and activation limits must be checked before
releases. No new funds, credentials or fee transactions were created here.

The queue has no moderation consumer. Creator activation/registration, sealed
media, public IPFS publication, directory/post transactions and reload/playback
remain integration work. First-song readiness stays incomplete after successful
infrastructure provisioning. Spaces, sponsored name purchases, ElevenLabs,
OpenRouter and Telegram remain outside this slice.

## Run locally

Use Node 24 from this directory:

```sh
npm ci
npm run check
npm start
```

Open `http://127.0.0.1:8789`. Without runner credentials you can save settings,
review resources and inspect readiness. State defaults to
`~/.local/state/pirate-community-wizard`; `PIRATE_WIZARD_STATE_DIR` selects a
private directory for another community and `PIRATE_WIZARD_PORT` selects its
port. Repository state directories are refused. The browser uses no
localStorage and stores no provider keys. Older saved configurations without a
moderation mode retain independent operation and require a new reviewed plan;
they are never silently converted to managed service.

## Runner access and deployment

Prepare an existing Cloudflare account with workers.dev enabled and access to
Workers, D1, R2 and Queues. Inject `CLOUDFLARE_API_TOKEN` and
`PIRATE_WIZARD_STATE_PASSWORD` through an approved secret workflow, preferably
Infisical. The state password must contain at least 32 bytes and must be retained
in the approved secret store for recovery. The runner does not generate it or
write it to disk. Enter the nonsecret account ID and existing workers.dev
subdomain in the wizard. Use cf for diagnostics; Alchemy alone reconciles the
resources. There is no automatic adoption or destroy action.

Only independent moderation needs provider credential intake. Prepare an
existing Infisical project/environment/dedicated folder and inject its scoped
machine identity as `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET`, with
read/create/update access to that folder. The default site is
`https://app.infisical.com`; a trusted runner may set `INFISICAL_SITE_URL` to
its own HTTPS origin. Imports and reference expansion are disabled. The adapter
updates only named OpenAI, ACRCloud and optional CloudConvert secrets. Managed
mode rejects this intake and never reads those provider secrets.

Saving keys is an Infisical operation, not a moderation test. Partial writes can
be retried at the same names. Saved status requires readback of every required
name. Values never return to the browser or enter setup JSON/status messages.

The intended resource plan binds settings, source, deployment helpers and the
lockfile. It is not a Cloudflare diff. Explicit deployment runs Alchemy `plan`,
then `deploy --stage setup --no-input --yes` using fixed arguments. Account
charges can apply. No live plan/deploy was executed in this source repair.

After apply, the runner polls the exact reviewed HTTPS origin for up to three
minutes, with per-request timeouts and bounded backoff. It accepts only a receipt
with the expected plan ID and installed D1 schema. A slow endpoint becomes
`health_pending`, not a failed apply; an unchanged-plan retry only checks HTTPS.
Changing source or credentials requires a reviewed redeployment. Infrastructure
success does not prove storage round trips, job processing or first-song playback.

workers.dev is a staging origin owned by the Cloudflare account. Choose the
community's canonical origin before production login: changing it requires
reauthentication and origin/allowlist updates. This slice promises no automatic
session continuity or custom-domain migration.

## Protected state, diagnostics and recovery

The runner is trusted. Loopback Host/Origin checks, CSRF, bounded bodies and CSP
protect its web interface, but a compromised local machine or extension can
still read runtime credentials. No HNS or registry-admin private key is collected.

The pinned Alchemy v2 encoder stores underlying Redacted values in JSON. Its
local store does not implement the v1 `ALCHEMY_PASSWORD` behavior. This stack
wraps that actual store's file I/O with AES-256-GCM and scrypt, encrypting whole
resource and output files before Alchemy's atomic writes. Authentication binds
each record to its logical stack/stage/file path, while allowing relocation of
the state directory. Wrong passwords, tampering and plaintext files fail closed.
Do not delete state to bypass a decryption error. Existing plaintext deployments
need an explicit migration; this repair does not silently convert or destroy them.

The runner uses 0700 directories and 0600 files with umask 077. After each Alchemy
phase it inspects generated deployment files for the actual supplied credential
bytes, excluding the generated dependency symlink. Unexpected symlinks, excessive
state size or plaintext matches stop the workflow. This inspection also runs on
the first real deployment; the offline encrypted-store proof is not evidence
that a live provider has emitted no other sensitive files.

Completed commands retain up to 1 MiB of combined output in encrypted private
`diagnostics/*.enc` files. Failures expose a log ID and exit status, never the
provider output. On a trusted private terminal, an operator can explicitly use:

```sh
npm run diagnostic -- <log-id> --show-sensitive
```

Decoded output can contain credentials. Do not paste it into chat or public
reports. A runner crash can lose the current in-memory command log; previous
completed logs and atomic state remain. Diagnostic decryption uses the same
managed state password and prints no output without the explicit flag.

For recovery on another machine, first stop the original runner and confirm no
Alchemy child remains. Back up `setup.json`, `deployment/.alchemy/` and
`diagnostics/` with a verified file inventory/digest through the approved backup
workflow. Keep the state password separately in the approved secret store. Do
not copy `runner.lock` or `deployment/node_modules`. Restore into a private
state directory, check the inventory/digest, install the same reviewed source and
lockfile, and inject the same password and scoped service access. The runner
regenerates its code/dependency links and retains resource identities. Recheck
the plan before resuming. Only one restored copy may deploy; this is not a
multi-machine locking system. Local tests cover the actual store's cross-path
round trip, not a live second-machine Cloudflare recovery.

After a crash, remove `runner.lock` only after confirming the old runner and any
Alchemy process have stopped. Interrupted status never counts as success. No
automatic rollback deletes resources. Settings remain fixed after the first
attempt; preserve the state when investigating errors.

## Contracts and evidence boundaries

The separate contracts agent owns implementation, tests and deployment
artifacts. This wizard consumes reviewed manifests; it implements no contract
or blockchain transaction. Shared Pirate infrastructure consists of the naming
factory/implementation and the intended directory/post deployments. The
operator controls its per-TLD registry, configuration and publisher. Verification
and listing remain separate from publication authority.

[PR 12](https://github.com/pirate-social-club/pirate-operators/pull/12) contains
the directory/post interfaces. Their implementation now has a dedicated active
task. The deployed OperatorPayments test fixture at
`0x98a5242f80ecc9e01295e03a18712b4256d9f071` is disposable test evidence, not a
community deployment default: it precedes the admin-controlled recipient and
spending restrictions. This wizard neither adopts it nor requests deposits.
Learning records and karaoke payments do not gate this first-song integration.

[PR 13](https://github.com/pirate-social-club/pirate-operators/pull/13) records
the completed owner browser activation/reopen/sign pilot and public transaction.
Its older README/software-smoke evidence has not yet been reconciled by this
lane. Device, OS and passkey-provider provenance and Android/Telegram coverage
remain incomplete. Neither that pilot nor a chain receipt proves the full
community upload/registration/publication journey.

## Verification and review

`npm run check` type-checks the stack/runner, runs tests and builds the UI.
`npm run test:browser` exercises the desktop/mobile managed setup and resume
journey. Tests include actual pinned Alchemy state persistence and actual
Infisical SDK paths with fake credentials/HTTP; no live provider is implied.
The root repository check and full dependency audit remain required.

The stack pattern originates in creator-spike `a9810cc`; no sibling checkout is
a dependency. Provider APIs were checked against pinned source and official
[Alchemy Worker](https://alchemy.run/cloudflare/compute/workers/),
[R2](https://alchemy.run/cloudflare/data/r2/) and
[Queues](https://alchemy.run/cloudflare/messaging/queues/) documentation. The
SDK's Zod override is qualified only for the authentication and CRUD paths used
here. State encryption is our wrapper around the pinned v2 local store, not a
claim of native Alchemy encryption support.

PR 15 remains stacked on PR 11. Both can be reviewed as a stack; merge PR 11
before PR 15. Passing CI and this author's repair checks are not an independent
review. No self-reviewed merge is performed.
