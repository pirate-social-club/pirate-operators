# Community wizard v1

This is the runnable provisioning slice: a Solid browser wizard backed by a
trusted local Node runner. It reviews a fixed resource plan and invokes Alchemy
for an ordinary HTTPS setup page, D1, private R2 and a queue. It does not yet
provide the completed login, upload, moderation or first-song application.

Owner decision, 2026-11-05: the next packaged community setup uses the operator's
own ACRCloud, OpenAI and Filebase accounts and community-run moderation. Pirate
supplies shared contracts/discovery and the funded creator service. This is
ordinary provider setup, separate from operating a Sui/Ika treasury. The current
code's managed-moderation default and the first-song test profile are unchanged;
the target and its pending evidence are specified below and in the
[setup decision](../../docs/decentralized-setup.md#next-community-owner-decision-2026-11-05).

## Fixed setup and namespace

Choose the community TLD, deployment identity and service mode before the first
deployment attempt. Setup settings then stay fixed in v1. Decide any intended
Web2/HNS access mode and domain names upfront too; adding HNS, another domain
or changing that topology later is a custom unsupported migration, not a wizard
function. The open source can be adapted, but there is no automatic adoption,
identity migration or preserved-session promise. Credential rotation, reviewed
redeployment of the same setup and recovery remain supported.

This slice provisions only an ordinary HTTPS workers.dev setup page. Custom
Web2 domains and HNS access are not implemented here. Do not use it as an
HNS-only deployment or infer that it can attach HNS later. A selected namespace
can remain undelegated while first-song contracts/flows are tested. Verifying
access selected at initial setup is distinct from adding a different domain.

The TLD is required even for an unverified test community: its registry fixes
that label, and the directory identity includes chain and registry. For the
owned staging namespace, choose c22 if its real Handshake delegation will later
be exercised. This does not deploy or change any registry/delegation. Testnet
communities do not retain the same identity on mainnet. An older attempted
setup with a blank TLD needs an explicit custom state/identity migration; keep
its state, and do not start another directory against the same resource names.

## First-song test scope

The owner confirmed on November 4 that song contracts and flows must be testable
without waiting for Handshake. A genuine test registry and its admin can create
an unverified directory entry and publish through the selected publisher. HNS
delegation and a fresh namespace attestation gate verified Pirate discovery;
opening app.tld is a separate browser/transport check. Neither gates the first
song test. A factory event alone does not establish namespace ownership.

The current wizard code defaults to Pirate-operated moderation. Communities using that
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

This setup slice's community queue has no moderation consumer. Creator activation/registration, sealed
media, public IPFS publication, directory/post transactions and reload/playback
remain integration work. First-song readiness stays incomplete after successful
infrastructure provisioning. Spaces, sponsored name purchases, ElevenLabs,
OpenRouter and Telegram remain outside this slice.

## Next-community packaged wizard acceptance

This extends the runnable provisioning slice; none of these rows gains a pass
from this specification. Qualify the next disposable, unlisted community using
the existing directory/posts deployment and a new genuine registry. Lasting
governance and verified discovery are separate launch work. Keep c22 and the
first-song resources, identities and managed-mode settings unchanged.

The package's supported OS/architecture, release/source hashes and pinned runtime
must be explicit. It prepares the required runtime and authentication helpers;
the supported user journey does not require cloning source, npm commands,
hand-made runner folders, generated passwords or launcher flags. Account signup,
provider billing and unavoidable initial provider-key creation are guided owner
steps. Do not promise provider APIs or authorization flows before qualifying them.
The existing commands below remain developer/current-runtime instructions.

The wizard generates a new secp256k1 moderation evidence key through the trusted
runner and stores it in the owning service's Infisical scope before using or
publishing its address. Keep it distinct from the publisher, controller and
Pirate treasury identities. Retain only its secret reference, public key ID,
version and operation state in resumable setup metadata. Verify exact secret
readback and a signed challenge against the public address. If creation or
persistence is uncertain, reconcile the original key operation; do not publish
an ephemeral key or silently replace it. Resume reuses the stored identity.
Rotation is explicit, retains history and invalidates unstarted authorizations;
Pirate's service must separately approve the replacement signer. This prose
authorizes no real key creation or rotation.

Provision the separate server-side publisher key through the same verified
secret workflow before committing its address in community configuration.
It is distinct from the administrator wallet and moderation signer. Explicit
adoption of an existing publisher requires proof of the corresponding protected
secret and identity; never attempt to recover a key by reading Worker bindings.
The state password also needs cryptographically random generation of at least
32 bytes and verified vault persistence before encrypted deployment writes.

Filebase setup must qualify the chosen account/bootstrap and runtime credentials,
resource creation, retained pin proof and independent retrieval. A bucket label
alone does not prove the effective scope of a token. Keep any account-wide
credential within its owning service; never put it into the client or public
configuration. The current first-song token is not a default for new communities.

| ID | Required result | Acceptance evidence |
| --- | --- | --- |
| W1 | A versioned package opens the wizard on a fresh supported machine and prepares pinned dependencies without source/build/terminal setup. | Artifact/source hashes, platform identity and actual fresh-install/reopen run. |
| W2 | Cloudflare and Infisical connections select accounts/projects by name, prepare approved secret scopes and retain the generated state password before apply. | Actual account/scope readback and restore with the same encrypted state; no UUID/password copying or secret leakage. |
| W3 | The operator connects its own ACRCloud, OpenAI and Filebase accounts; the wizard automates supported resource setup and stores credentials in the calling service's scope. | Real provider checks, resources and credential references; no Pirate provider-key copying or simulated success. |
| W4 | Community moderation and publisher keys are provisioned once, durably saved and verified as distinct from each other and the controller. | Signed challenges, Infisical readback, resumed setup using the same addresses, uncertain-write refusal and explicit rotation/trust-update checks. |
| W5 | Alchemy deploys the community's actual application, private upload storage, D1 migrations and durable admission/publication jobs in the chosen Cloudflare account. | Source/package/profile binding, runtime schema and storage/job round trips; this is more than a setup page. |
| W6 | The administrator approves registry creation and configuration against verified existing shared contracts. | Canonical clone/config receipts, pinned and retrieved manifest, publisher/origin/signer readback; replay reconciles instead of creating another registry. |
| W7 | Setup checks administrator and publisher balances, presents fee ceilings and verifies an explicitly approved publisher transfer. | Gas/balance readback, low-balance warning and visible publication hold on depletion; no automatic refill without a separate bounded policy. |
| W8 | Pirate pairs this community and accepts its moderator only under the controlled grant in funding S9-S12. | Service-side trust, explicit numeric native ceilings, reservation, cutoff and pending-effect reconciliation; public signer configuration alone is insufficient. |
| W9 | A creator signs into this second origin and links the verified Active wallet through the stable wallet site using the short owner procedure. | Actual browser/passkey return and recipient binding under creator C8/C10/C13; no new wallet charge merely for another community. |
| W10 | Interrupted setup and publication resume with the same resource, key, grant and transaction identities. | Interruptions around secret persistence, apply, pinning, registration and post publication; no duplicate purchases, mints or posts. |
| W11 | The operator can update or restore the package with retained deployment identities, secret references and encrypted state. | Same-version restore on a supported machine, independent password recovery, wrong-password refusal and one active deployer; no silent deployment migration. |
| W12 | A real release passes community-run moderation, bounded sponsored registration, public retention and fresh-browser playback; rejected/held work stays unpublished. | Web-client D3/D8-D10, funding S1-S12 and applicable creator C1-C13 evidence, including seeking/reload and failed-delivery behavior. |

The implementation record must identify which existing acceptance IDs passed,
the new rows passed, skipped checks, exact deployed profiles and sanitized costs.
Per-action native ceilings are execution-profile inputs, not invented prices in
this document. Without them W8/W12 remain unready. A restore or key rotation
must not turn a submitted uncertain operation into a new funded attempt.

## Run locally

Use Node 24 from this directory:

```sh
npm ci
npm run check
npm start
```

A packaged runtime includes the built `dist/` and can use `npm ci --omit=dev`.
Alchemy, its Cloudflare provider, Effect/platform-node and tsx are runtime
dependencies. Building the UI and running development tests still requires the
full install. `npm run smoke:runtime` checks real stack imports, loopback startup
and the built page with no provider credentials; it never runs plan or deploy.

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

### Supported operator launcher

`npm run start:operator` replaces the temporary live-test launcher. It requires
Node 24 on a POSIX system, the Infisical CLI and an explicit existing private
state directory. Save initial settings with `npm start` first, then stop that
runner. The launcher reads those nonsecret settings, never creates replacement
state, never removes a lock, and never deploys. Install with `npm ci` and build
with `npm run build` before starting from a source checkout. A runtime package
can instead include the built `dist/` and install with `npm ci --omit=dev`.

Use a separate trusted Infisical runner folder containing only
`PIRATE_WIZARD_STATE_PASSWORD` and, for the default API-token mode,
`CLOUDFLARE_API_TOKEN`. The password must be the existing state's password.
Do not put provider keys or executable configuration such as `NODE_OPTIONS` in
that folder: `infisical run` injects its contents into a Node bootstrap before
the bootstrap filters the environment passed to the runner. Folder write
access is therefore trusted operator access. No credential is created by this
launcher, and it ignores ambient credentials instead of silently reusing them.

```sh
npm run start:operator -- \
  --state-dir "$HOME/.local/state/community-example" \
  --runner-secrets-path /communities/example-runner \
  --check
```

`--check` only validates nonsecret configuration; it does not authenticate,
refresh a login, retrieve secrets or start a process. Remove it to start the
runner. The project and environment default to saved independent-mode settings.
Use `--project-id <UUID> --environment <slug>` for a separate runner project or
for managed communities, which have no provider-secret scope. This does not
change the saved service mode or provider-key location. An optional
`--infisical-profile` selects a CLI login, and `--infisical-site` selects the
trusted instance; a bound state refuses another instance.

The launcher calls `infisical run` with imports, expansion, subfolder recursion
and personal-secret overrides disabled. API-token mode requires the injected
Cloudflare token and never falls back to a personal login. The optional
`--cloudflare-auth cf-login --cf-profile default` path refreshes the explicitly
selected existing cf login using `cf auth whoami`. It requires authenticated,
valid JSON status for the saved Cloudflare account, then reads the reported
private profile file and checks token expiry. Failed refresh, expired login,
wrong account or malformed output stops startup without forwarding CLI output.
Tokens and the state password stay out of command arguments and wizard files.
This launcher uses an operator's Infisical CLI login. The advanced unattended
machine-identity path continues to use `npm start` with its existing managed
environment; `start:operator` does not silently borrow machine credentials.
An OAuth token is refreshed at launch, not continuously; if it expires while
the runner is open, stop and relaunch with the same state before retrying.

The installed contracts inspected for this path were cf `1.0.0-beta.5` and
Infisical `0.44.14`. The cf JSON profile format is a CLI-owned beta interface;
an incompatible change must fail closed and be qualified before use. Alchemy
still owns provisioning; this launcher uses cf only for authentication.

For the existing c22 disposable community, use the restored state only:

```sh
npm run start:operator -- \
  --state-dir "$HOME/.local/state/pirate-community-wizard-c22-staging-restored" \
  --runner-secrets-path /communities/c22-wizard-staging-runner \
  --cloudflare-auth cf-login --cf-profile default --port 8795
```

Its saved project/environment identify the existing runner-secret scope; no
temporary script or hardcoded checkout path is needed. Add `--check` first to
inspect the selection without fetching credentials. Do not launch from
`pirate-community-wizard-c22-staging-pre-restore`: that is the reference copy.
Only one state copy may operate the resources. Keep independent mode, reconnect
Infisical in the browser, and review any source-changed plan before deploying.
The launcher itself neither changes settings nor presses Deploy.

### Cloudflare credential scope

The accepted c22 run used the operator's personal cf login with write access
across the Cloudflare account, including production resources. The owner
approved sharing that account for this disposable test. The community prefix
and Alchemy state do not constrain the credential's permissions.

For lasting installations, the default is an API token restricted to the
selected account and the permissions required for Workers, D1, R2 and Queues,
including any read permissions required by the pinned provider. Review its
actual scope when creating it; the launcher cannot infer permissions from the
token string. Account/product permissions may still reach other resources of
those types in that account. A community name prefix is not an authorization
boundary. See Cloudflare's [token guidance](https://developers.cloudflare.com/cf/ci/)
and [token creation documentation](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
No token creation or permission change was performed for this source update.

Independent moderation uses guided Infisical onboarding. Managed moderation
has no community provider keys and does not exercise this connection. The first
disposable provisioning test therefore selects independent mode before deployment.
The current workers.dev-only slice remains disposable staging, not a lasting
community installation.

Create an Infisical account and a Secrets Management project, or choose an
existing project. Select its environment in Infisical. Copy the project UUID
from Project Settings and the environment slug into Community. The wizard
suggests `/communities/<deployment-id>` as its dedicated folder. Check this
scope before connecting; existing secrets at the same names are updated on save.

Install the official [Infisical CLI](https://infisical.com/docs/cli/overview)
on the runner computer, then sign in through its normal browser login:

```sh
infisical login --domain https://app.infisical.com
```

CLI login is the default when machine credentials are absent. The implementation
was qualified against CLI 0.44.14's `login status --json` and `user get token
--plain` contracts, and SDK 5.0.2. In Services, use Connect & prepare folder.
The runner checks the selected user session and actual instance, pins that profile
for token retrieval, and uses the SDK to create missing path folders and verify
folder access. The token is captured privately by the runner; do not print it,
paste it into the wizard, or put it in an environment file. A prepared folder is
not proof of secret write access: saving keys verifies their exact readback.

The default instance is `https://app.infisical.com`. For EU or self-hosting, set
`INFISICAL_SITE_URL` to the trusted HTTPS origin on the runner and sign in to
that same instance. An optional `INFISICAL_PROFILE` selects an existing CLI
profile; sign in to that profile outside the wizard. The browser cannot choose
a token destination. Missing, expired, ambiguous or wrong-instance sessions fail
closed with a reconnect instruction. Authentication is checked for each operation;
a later CLI login is picked up without restarting the wizard. The first successful
connection binds the instance to `setup.json` and invalidates any previous plan.
Switching that instance after binding is a custom secret-store migration.

The local runner is trusted with the operator's existing account permissions.
Selecting a folder constrains this adapter's requests; it does not narrow the
login token's authority. The runner does not cache or persist the retrieved token,
return it to the browser, or forward it to Alchemy. The CLI retains its own
normal login state and may refresh it. Do not run this personal-login mode as
an unattended hosted service. The private CLI subprocess has bounded output and
time, no shell, and no provider or machine credentials in its environment.

For unattended use, configure `INFISICAL_AUTH_MODE=machine` with an existing
scoped `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET`. Providing either
machine credential also selects that mode for existing installations; both are
required, and failure never falls back to a personal login. Set
`INFISICAL_AUTH_MODE=cli` explicitly to select personal login instead. Machine
access needs secret read/create/update in an existing final folder. Prepare the
folder first with the operator login; machine mode checks its exact leaf scope
and does not list or create ancestors, preserving narrow existing permissions. Creating a new machine identity or changing its
permissions remains an explicit operator action; the wizard does neither.

Imports and reference expansion are disabled. The adapter reads/writes only
named OpenAI, ACRCloud and optional CloudConvert secrets in the exact scope.
Managed mode rejects intake and never requests a CLI session or those secrets.
Existing Alchemy ownership of Cloudflare bindings is unchanged: the runner reads
Infisical and supplies only the required provider values to Alchemy. No second
secret synchronizer or Alchemy Infisical plugin is introduced.

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

The first independent-mode live run at `f7e289d` verified CLI authentication,
folder creation and exact readback of three placeholder provider values. Alchemy
created D1, R2 and the queue, but Worker upload failed with
`ScriptStartupError: multipart: message too large`. With `bundle: false`, the
pinned provider collected dependency modules beside the generated entry.

The repaired layout puts the entry in `deployment/worker/worker.mjs`, away from
`node_modules`, migrations and `.alchemy`. Only that directory is collected for
upload. The stack, stage, resource names and encrypted-state location are unchanged.
A retry regenerates code without clearing state; an old root-level `worker.mjs`
is outside the upload directory and need not be removed to resume.

To retry that partial deployment, stop the previous runner and Alchemy child,
install the reviewed repair, and start with the same state directory, managed
password and settings. Reconnect Infisical and review a new plan because source
has changed. Preserve the saved resource state so Alchemy can reconcile the
existing D1, R2 and queue; do not start an empty state folder against their names.
Worker creation, health, live redeployment and cross-folder recovery still need
acceptance when qualifying another deployment. On November 4, the independent
executor passed all four checks for c22 at `445576a`, including interruption
recovery and a restored-folder plan with no changes. Its runner is stopped and
the restored folder named above is the sole deployment copy. Placeholder
readback does not test moderation providers or storage/job round trips.

The runner is trusted. Loopback Host/Origin checks, CSRF, bounded bodies and CSP
protect its web interface, but a compromised local machine or extension can
still read runtime credentials. No HNS or registry-admin private key is collected.

The secret inventory includes Infisical's remote runner/provider folders,
in-memory process environments, the cf CLI's own OAuth profile when selected,
and the CLI's normal login/keyring state. In the qualified Infisical `0.44.14`
run, `infisical run` also retained an encrypted offline copy of its injected
runner secrets under `~/.infisical/secrets-backup/`, protected by the system
keyring. That includes the state password, and may include a Cloudflare API
token when the runner folder contains one. It is not plaintext and is not the
wizard's encrypted Alchemy state, but it is another local secret copy. Include
it and keyring custody in machine backup/retirement decisions. The wizard does
not delete or rotate CLI-owned backups, profiles or keys. A copied backup
directory alone is not a portable keyring or a replacement for access to the
managed secret store.

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
that a live provider has emitted no other sensitive files. Before the first real
run, inventory the runner account's home/cache/temp output locations, compare
them after both plan and deployment (including failures), and inspect newly
written files for supplied credential bytes through a private local check.
Record paths and redacted findings only. The deployment-folder scan does not
cover other locations or prove their absence of secrets.

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

For recovery on another machine, sign in to the same Infisical instance and
project with an authorized account, or configure the existing scoped machine
identity. Connect the saved folder again: connection readiness is memory-only
and is never trusted from a backup. Keep the bound instance and settings; only
session/credential access is refreshed. Deployment reads the current provider
values from Infisical rather than a saved browser form.

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
attempt; preserve the state when investigating errors. Do not discard or edit
state to bypass the unsupported-migration boundary.

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
journey, plus independent-mode guidance and refusal before an Infisical connection. Its launcher creates one random temporary directory per invocation and
removes only that directory after the child exits, including a failed test run.
It never sweeps directories from another session. Tests include actual pinned Alchemy state persistence and actual
Infisical SDK paths with fake credentials/HTTP, private CLI subprocess behavior,
folder retries, exact secret readback and reconnection after restart; no live
provider is implied. The CLI session is never a Cloudflare Worker binding.
Packaging tests run the pinned provider's real prebuilt collector against the
generated stack entry. Fresh and failed-layout retries must each collect exactly
the Worker, with byte-identical contents, while preserving existing state files.
Operator-launcher tests use fake CLIs and fixture credentials to start the real
loopback runner in both credential modes, verify argument/environment boundaries,
graceful shutdown and refusal of bad login/secret/state selections. They do not
refresh the actual operator login or retrieve the live state password. The
previous live deployment used the temporary launcher, so this supported launcher
still needs independent review and its first live startup qualification.
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


The review repair retains the last 1 MiB of combined Alchemy output, with a
truncation flag, so terminal failures remain in encrypted diagnostics. A
production-dependency smoke check follows the browser run in CI. These checks
do not prove live provider behavior or first-song readiness.
