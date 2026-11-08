# MegaETH song publication, Release 1: owner-only and unregistered

This is the active launch contract for song publication. It implements the
workspace_owner's ruling of 2026-11-08, recorded in the staging-root package
`handoffs/launch-song-publishing-ruling-2026-11-08/README.md` (SHA-256
b75b7d4db9b1ce298f9da7cae2d050d67275004f04694942c2c4d0b4c986fd39), and the
workspace task record `pirate-megaeth-song-publication-20261108`.

For launch, the workspace owner is the only song publisher. A song post is
published without DATA registration or Ika activation. This supersedes, for
launch, the November 5 requirement that publishing a song means DATA
registration and the November 6 decision to keep Royalties. Those decisions
still describe the deferred registered-IP product and return when it is
revisited. Revisit when a creator needs paid licensing or revenue sharing.

General-user publishing with a Palm posting gate, per-account limits and
hidden-revision removal is Release 2, a separate later task. Nothing here
depends on it, and nothing here implements it.

## Policy

The new owner policy is `pirate-owner-curated/2026-11-08/1`. Its normative JSON
is [owner-unregistered-policy.json](owner-unregistered-policy.json), and
`packages/community/owner-policy.ts` exports it as `UNREGISTERED_OWNER_POLICY`
with SHA-256
0xf5031f548749edfd332eec686923681ded1247a69703788a4f0fb0b25d8532d8. The hash is
the canonical JSON hash of that object. Changing any byte is a new policy
version, never an edit.

The November 5 policy `pirate-owner-curated/2026-11-05/1`, its JSON and its
hash 0xeac6c5663b1942264851404e8a713b43eb222335338a8f68a2d09ad083b26d97 are
unchanged, and a test pins them. So is `pirate-release/2026-08-29`. Neither
is reinterpreted by the new policy.

The new policy keeps the November 5 content rules: ACRCloud recognition is
required, receipts keep their original acquisition time for at most 24 hours,
identified audio blocks, inconclusive audio holds, automated content
moderation stays deferred, and rating and language are operator declarations.
It keeps the immutable master, lyric manifest and both private MP3 stems. It
removes the creator wallet, the captured external recipient and the ROOT
registration, and it has no registration operation or fee.

## Post format

New songs use `pirate.community-post/3`. Its fields match `/2`, except
`registration`, which is exactly
`{ "status": "absent", "reason": "deferred_for_launch" }`. Any other value,
any extra field, a pending status or a copied receipt is rejected. A `/3`
admission summary must name the new policy and hash.

`/1` and `/2` keep strict confirmed-receipt validation and cannot declare
absence. Readers accept all three. A post must match the admission policy of
the configuration revision it was published under: `/2` only with the
November 5 owner policy, `/3` only with the new one, `/1` only with the
release policy. Existing posts, receipts, song IDs, authors, lyric occurrence
identities and learning history keep their meaning.

The post identity `(chainId, postsContract, communityId, postId)` stays the
song identity and streak key. A later supported registration attaches as a new
revision of the same post under its own reviewed policy and adapter. It is
never a launch-time placeholder, invented receipt or pending job.

## Write path

Release 1 adds an owner-only submission path under the new policy. Only the
operator-authorized owner account may reserve, seal or publish, enforced in the
server handlers. A signed-in learner, another wallet or a forged owner claim is
refused before any paid work. The submission needs no creator binding. It
captures the account, wallet, accepted policy, declared rating and language,
and content hashes. The job then runs admission, public media and lyric
pinning, post-manifest pinning and the MegaETH post. It creates no
registration operation, no registration-only metadata pins and no
registration fee.

The release service and runtime must pin, publish and report readiness with no
registration signer, creator service, Aeneid, Sui or Ika client, or their
health checks. Old registered jobs keep their captured policy and journals.
They are reconciled and given an explicit disposition, never rewritten into
unregistered jobs.

## Owner authority and spending

Two reviewed artifacts authorize Release 1 publishing. Neither is selected by a
request body, and neither is recreated per song.

The owner authorization, `pirate.owner-publishing-authorization/1`, is signed
by the community controller from the directory configuration. It names the
community, the owner wallet, the admission policy (version and hash) and a
validity window `validFrom`..`expiresAt`. The community worker verifies the
signature against `config.controller` and accepts upload, seal and job
requests only when the session wallet equals `ownerWallet`, the configuration
policy is the unregistered owner policy and the request time is inside the
window. The controller, the publisher and the signed-in owner are separate
roles; equality between them is never assumed.

The owner budget grant, `pirate.owner-publishing-grant/1`, is reviewed operator
configuration of the paying service. It binds the community and its origin,
the owner wallet, the admission policy, the MegaETH destination (chain 6343 or
local 31337, posts contract, publisher), and the same validity window. Its
limits are the song count, pin additions, pinned bytes, recognition requests
and the MegaETH post fee ceiling in wei. It has no registration section.

Consumption is keyed by the stable scope
`owner:<communityId>:<ownerWallet>:<policyVersion>` and the period
`<validFrom>-<expiresAt>`, not by the grant hash or configuration revision.
Replacing the grant, publishing a configuration revision or redeploying
within the same window therefore reuses the same buckets. Each paying service
claims the window in its own database with one batch on `owner_budget_windows`
(community migration 0012, managed migration 0004). The claim creates the
scope's window, keeps the identical window, or advances to a later
non-overlapping one, so two concurrent overlapping grants cannot both be
admitted and a superseded window cannot open new spending. The same batch
records the digest of the grant's limits on the window and configures all
five owner buckets from them, including buckets not yet used. A replacement
grant whose limits differ is refused with `owner_budget_limits_changed`, so no
ceiling can be raised inside a window. Every new reservation claims the window
first and commits only while the window, with the same limits digest, is still
current. Deployment
packages add these migrations only when owner publishing is selected
(`harness/package-migrations.ts`); default builds keep the deployed lists.

Each song reserves one `songs` unit at release establishment, keyed by the job
identity, before any pin or post spend. Pins reserve `pin_adds` and
`pin_bytes` per operation identity before upload, and the grant's expiry is
checked again at the upload itself. Recognition reserves one
`recognition_requests` unit per provider request identity before sending; the
grant's validity is checked when each new call is authorized and again after
its reservation, before dispatch. The MegaETH post reserves the fee ceiling
and settles the receipt's actual fee. Retries reuse the same reservation
identity and request hash, so they cannot double charge. Unknown outcomes keep
their reservation until reconciled.

New spending and reconciliation are separate. An existing reservation, a
retained provider receipt and a possibly broadcast post replay or settle
without a currently valid grant, so they reconcile after expiry, replacement
or exhaustion. A refusal of new spending (exhausted cap, expired grant,
superseded window or changed limits) happens before any provider request or
broadcast, so the job is held with that code rather than parked as uncertain.
A refused post has no fee reservation, and no transaction is broadcast
without one; the held receipt is accepted only while that remains true.

A budget hold is final for that job. Only admission holds resume, so a
pre-signed post transaction or its nonce is never broadcast from a held job.
Publishing the song after a new grant or window needs a new submission and
job. A recognition call refused at dispatch, after its reservation, releases
the reservation (settled with actual 0) and stays planned; a released call is
never sent, even if the clock reads valid again.

Concrete live limits are not part of this source change. They go in the
reviewed execution profile before any live execution; a missing grant or
bucket disables paid execution.

Today the managed release service keys spending by grant hash
(`release:grant:<sha256>`, `release:pins:<sha256>`) and allows one release per
grant, and the community posting budget allows one post per period. Those
single-song shapes stay in force for the November 5 policy and are replaced
only for the new policy.

## Source and schema order

This branch is stacked on the deployed rewards tip
`f08ab4a9d5d759f5a2e2c7abfc475a0769213194` (`feat/manual-rewards-testnet`),
which already contains Study `f0d0530`. The community schema order is Study
0009 and 0010, rewards 0011, then owner publishing 0012, all already applied
except 0012. The upgrade tests apply the complete 0001-0011 chain with Study
and rewards rows, then 0012, and require those rows unchanged and the setup
ledger to gain exactly version 12. The managed chain upgrades from 0001-0003
to 0004 the same way. Implementing owner publishing does not depend on
rewards payments or learner acceptance being complete; shared staging
deployment still needs the current runtime custodian.

## Runtime configuration

Owner mode is selected by the directory configuration's admission policy,
never by a request or an environment flag. When the configuration names the
unregistered owner policy, the community worker
(`services/first-song-runtime.ts`, `ownerSongRuntime`) requires two reviewed
values besides the publisher key: `OWNER_GRANT_JSON`, the owner budget grant,
and `OWNER_AUTHORIZATION_JSON`, the controller-signed owner publishing
authorization. A missing or invalid value fails closed with
`owner_runtime_unconfigured`; a grant for another community, origin, policy or
destination fails with `owner_grant_scope_mismatch`. Owner values never turn a
registered-policy configuration into owner mode. Readiness checks only that the
managed service reports the same unexpired owner grant; the creator service is
not contacted for readiness, status or capabilities, which report
`creatorConnection: false`. `CREATOR_PROFILE_HASH`, `RELEASE_GRANT_HASH`,
`REGISTRATION_OPERATOR_ADDRESS` and `POSTING_EXPIRES_AT` belong to the
registered policy only; owner posting expires with the grant.

The managed worker (`services/managed-moderation.ts`) takes the same grant as
`OWNER_GRANT_JSON`. It enables owner recognition and the pins-only owner
release at `/v1/owner-releases/pin` and `/v1/owner-releases/pin/status`, which
need the pin credential but no registration key or registration client.
`/health` reports `ownerRelease` separately from the registered `release`.
Registered releases keep `/v1/releases/*` and their registration key, so old
registered jobs keep their reconciliation path.

## Rollout

Before the owner policy is activated, inventory every in-flight registered
job and record an explicit disposition for it (complete, hold or cancel,
reconciling any submitted effect). This is a hard prerequisite, not advice:
each job keeps its captured execution profile, so after activation a
registered job fails closed with `publication_execution_profile_changed`. It
is never converted, and it can also no longer progress or reconcile.

Community migration 0012 and managed migration 0004 were changed in place at
1b362b1 to add `limits_sha256`. They have not been deployed from this branch.
Before packaging, confirm that no database applied the earlier bytes; a
database that did must be recreated or given a successor migration rather than
re-applying 0012 or 0004.

Deploy readers that accept all three formats and both owner policies first.
Verify existing songs and history. Only then publish the new directory
configuration revision naming the new policy, and enable submissions. If a
problem appears, disable new publishing and keep the readers. Reverting to a
binary that rejects `/3` is not a rollback.

Learners use MegaETH. Megapot remains an external provider on Base, with
manual collection and conversion as operator work. Learner participation and
cash-out verification are unchanged.

## Status

Implemented and tested against the community and managed service code, with
ACRCloud, IPFS and the MegaETH chain as explicit simulations:

- The new policy, `/3` validation, readers that pair formats with their
  configuration policy, and public projections.
- The controller-signed owner authorization, checked in the release API
  before any reservation; another signed-in account, another wallet's
  authorization and a foreign signer are refused with no row created. This is
  tested over HTTP against the release API handler and through the community
  application routes.
- Owner submissions with no creator binding, sealed under the new policy.
- Recognition-only admission under the new policy, with owner recognition
  budgets and a grant check for each new provider reservation and dispatch.
- The managed owner release (`packages/release/owner-release.ts`): pins only,
  no registration route, signer, client or Aeneid dependency, one song
  reserved per job before any pin, owner pin and byte budgets, and `/3`
  manifests.
- Owner posting fees reserved and settled from the owner grant, with a
  refusal before broadcast held as a definite outcome.
- Owner windows that bind every ceiling at the first claim.
- Evidence age in admission recovery taken from the pinned policy: a retained
  owner receipt stays usable for 24 hours from its original acquisition; the
  registered policy keeps one hour.
- Runtime wiring for both workers as described under Runtime configuration.
- Execution profile `/2` bound to owner scope and window; registered jobs and
  curated amendments keep profile `/1`.
- Acceptance (`test/owner-publication.test.ts`): songs under one grant
  publish as `/3`; the song after the cap is held with
  `funding_cap_exhausted` and never pins or posts; a lost pin response and
  restarts retry without double charging; recognition is not purchased after
  the grant expires; post-fee exhaustion holds the job without broadcasting;
  a post whose broadcast response was lost still reconciles after the fee
  budget is exhausted; and no registration request is made.

Route and queue acceptance (`test/owner-route-acceptance.test.ts`) enters
through the community application: real SIWE sign-in, host cookie, CSRF and
Origin checks, the upload, audio, stem and seal routes, and the community
queue handler (`communityQueue`) running the job to a published `/3` post.
The creator health check and every registration route fail if contacted, and
neither is. A signed-in learner, a missing CSRF token and a foreign Origin are
refused before any submission row exists. In that test the release ports are
the fixture's, with simulated providers and chain; a separate test builds the
production runtime from reviewed values and shows it selects owner mode, the
same `/2` execution profile and a readiness check that contacts only the
managed service. The managed worker bundle is tested in workerd for owner
routing and health. The other acceptance cases still use the fixture's
`addSong`, which calls the community reservation, upload and sealing functions
directly.

Not yet implemented:

- Deployment bindings for the new owner values in the infrastructure
  definitions, together with the publishing deployment profiles below.
- Disposition of old registered jobs left uncertain when the configuration
  moves to the owner policy: the owner runtime does not carry registration
  ports, so such a job stays parked rather than being converted.
- Publishing deployment profiles: the release CLIs passing the publishing
  option, publishing-specific successor validation that preserves the
  deployed Study and rewards configuration, and removal of registration
  credential requirements and registration transaction bounds from those
  profiles.
- The web client: removing creator connection, registration progress and
  Royalties from the launch flow.
- Reconciling the active web-client, runtime and setup documents, which still
  describe creator activation and registration as required.
