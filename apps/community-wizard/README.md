# Community wizard v1

This is the first runnable setup slice: a Solid browser wizard backed by a
trusted local Node runner. It saves nonsecret settings, writes provider keys
to Infisical, reviews a fixed resource plan, and invokes Alchemy for an ordinary
HTTPS setup page, D1, private R2 and a job queue. HNS is optional follow-up.

It is not the completed first-song application. The deployed page is a setup
page, not a login or upload client. The queue has no moderation consumer yet.
Real moderation, creator activation, registration, media publication and
directory/post transactions remain integration work. The readiness screen
keeps them incomplete even after a successful deployment. Spaces, sponsored
name purchases, ElevenLabs, OpenRouter and Telegram are outside this slice.

## Run locally

Use Node 24 from this directory:

```sh
npm ci
npm run check
npm start
```

Open the printed `http://127.0.0.1:8789` URL. Without service credentials you
can save settings, review resources and inspect readiness. The browser keeps
no localStorage state. Restarting the runner restores nonsecret progress from
`~/.local/state/pirate-community-wizard`. Set `PIRATE_WIZARD_STATE_DIR` to an
absolute private directory for a different community and `PIRATE_WIZARD_PORT`
to a different port if needed. Do not use a repository or shared directory.

## Service access and deployment

An operator prepares an existing Cloudflare account with workers.dev enabled
and access to Workers, D1, R2 and Queues. Supply `CLOUDFLARE_API_TOKEN` to the
runner through the operator's established secret injection workflow; the
account ID and workers.dev subdomain are entered in the wizard. Use `cf` for
login/account diagnostics. Alchemy alone manages the resources; there is no
Wrangler configuration, automatic adoption or destroy action here.

Prepare an existing Infisical project, environment and dedicated folder.
Inject `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` for a machine identity
scoped to that folder with read/create/update permissions. The runner defaults
to `https://app.infisical.com`; a trusted operator may set
`INFISICAL_SITE_URL` to their own HTTPS origin. The browser cannot change it.
Imports and secret-reference expansion are disabled. The runner creates or
updates only the named OpenAI, ACRCloud and optional CloudConvert secrets.
It creates no provider account, API key, Infisical identity or permission.

Saving keys performs Infisical operations, not provider moderation calls. A
partial failure can leave some keys saved; retrying updates the same names.
The saved indicator appears only after all required names can be read back.
No provider credential value is returned to the browser or included in setup
JSON, resource plans or status messages. Password fields clear on submission.

Review the account and resource names, then invoke deployment explicitly. The
review is a deterministic intended-resource plan, not a Cloudflare diff. Its
hash binds settings, revision, stack, migration, Worker source and lockfile.
Alchemy runs `plan` followed by `deploy --stage setup --no-input --yes` using
fixed arguments. It may incur charges in the reviewed account. This source
task did not execute either command against a live account.

The deployment runner passes only the required provider values to Alchemy,
which installs Worker secrets. Infisical remains the source of those values.
Alchemy success plus a matching HTTPS health receipt and installed D1 schema
marks infrastructure provisioned. It does not test provider access, media
storage round trips, job execution, authentication or first-song playback.

## Contracts are a separate lane

The contracts agent owns implementation, tests and deployment artifacts. This
wizard implements no blockchain ABI, contract or transaction. Its integration
must consume reviewed deployment manifests from that lane, including chain,
addresses, ABI versions, code provenance and start blocks.

| Component                               | Intended responsibility                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry factory/implementation         | Shared Pirate deployment, already developed in pirate-registry.                                                                                               |
| Per-TLD registry                        | Operator creates it through the factory, controls sale policy and signs the HNS delegation.                                                                   |
| Community directory and song-post index | Shared Pirate deployments; the operator registers and controls the community's config/publisher. Pirate verification and listing govern discovery separately. |
| OperatorPayments                        | Shared-contract direction with separate community accounts; the contracts/payment lane must confirm deployment profile and spending controls.                 |
| Learning/rewards                        | Later work, not a provisioning gate.                                                                                                                          |

The directory/post handoff is currently specification and interfaces in
[PR 12](https://github.com/pirate-social-club/pirate-operators/pull/12), not a
deployment. The directory can require a real registry even while app access
uses ordinary HTTPS. Optional HNS access does not imply verified namespace
ownership or discovery. This wizard does not mark either as complete.

## Trust, persistence and recovery

Run this on the operator's trusted computer. The runner binds only loopback,
checks the exact Host and Origin, uses a session CSRF token, rejects cross-site
requests, limits request bodies and exposes no CORS. The UI serves local
assets with a restrictive CSP. Local administrators, malicious extensions or
compromise of this machine can still read credentials in memory; loopback
is not protection from them. No registry-admin or HNS private key is collected.

Setup JSON is mode 0600 in a 0700 state directory. Alchemy's working directory
and state live under its private `deployment` child with umask 077. Alchemy
state may contain secret values: treat the whole directory as sensitive and
back it up only through the operator's approved encrypted backup workflow.
Provider raw output and error bodies are not streamed or saved in logs. This
limits diagnostics; use scoped account/credential diagnostics without exporting
Alchemy state or provider errors into a bug report.

Keep this directory for retries. Once a deployment has been attempted its
settings are locked; a new community uses a different state directory. The
runner serializes operations and holds `runner.lock` across the deployment.
Normal shutdown waits for the child operation. After a crash, confirm both the
old runner and any Alchemy child have stopped before manually removing that
lock. Never remove it just because the browser disconnected. A resumed
in-progress record is interrupted, not successful. Review and retry the same
resource identities; no automatic rollback deletes existing resources.

## Verification and provenance

`npm run check` runs TypeScript (including the Alchemy stack), boundary and
recovery tests, then builds the Solid UI. `npm run test:browser` runs a real
Chromium journey from settings to review and mobile readiness, including
reload/resume. Tests use explicitly fake provider/provisioner ports and do not
prove live Infisical, Cloudflare, chain or moderation behavior. The repository
root's `npm run check` remains required. CI runs both suites separately.

The Alchemy stack pattern follows the independently owned creator-spike
source at `a9810cc`; no sibling checkout is a build or runtime dependency.
Provider APIs were checked against pinned package types and the official
[Alchemy Worker](https://alchemy.run/cloudflare/compute/workers/),
[R2](https://alchemy.run/cloudflare/data/r2/) and
[Queues](https://alchemy.run/cloudflare/messaging/queues/) documentation.
Infisical CRUD uses the pinned official `@infisical/sdk` rather than guessed
HTTP endpoints. No frontend build or managed credential was copied from another
community.

The SDK's transitive Zod dependency is overridden to 4.6.7 for its collection
validation security fix. The actual SDK authentication, scoped list/get and
create/update paths used here are exercised against simulated HTTP responses,
including retry after a partial write. Other SDK surfaces are not used or
qualified by this override. The full dependency audit, including deployment
tooling, must remain clean before publication.
