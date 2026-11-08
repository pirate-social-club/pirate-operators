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
within the same window therefore reuses the same buckets. `configureBudget`
already refuses a changed ceiling for an existing bucket, so limits cannot be
raised by replacement inside a period. Each paying service claims the
window in its own database with one conditional upsert on
`owner_budget_windows` (community migration 0009, managed migration 0004).
The claim creates the scope's window, keeps the identical window, or advances
to a later non-overlapping one, so two concurrent overlapping grants cannot
both be admitted and a superseded window cannot open new spending. Deployment
packages must add these migrations before the new policy is activated.

Each song reserves one `songs` unit at release establishment, keyed by the job
identity, before any pin or post spend. Pins reserve `pin_adds` and
`pin_bytes` per operation identity before upload. Recognition reserves one
`recognition_requests` unit per provider request identity before sending. The
MegaETH post reserves the fee ceiling and settles the receipt's actual fee.
Retries reuse the same reservation identity and request hash, so they cannot
double charge. Unknown outcomes keep their reservation until reconciled.

Concrete live limits are not part of this source change. They go in the
reviewed execution profile before any live execution; a missing grant or
bucket disables paid execution.

Today the managed release service keys spending by grant hash
(`release:grant:<sha256>`, `release:pins:<sha256>`) and allows one release per
grant, and the community posting budget allows one post per period. Those
single-song shapes stay in force for the November 5 policy and are replaced
only for the new policy.

## Rollout

Deploy readers that accept all three formats and both owner policies first.
Verify existing songs and history. Only then publish the new directory
configuration revision naming the new policy, and enable submissions. If a
problem appears, disable new publishing and keep the readers. Reverting to a
binary that rejects `/3` is not a rollback.

Learners use MegaETH. Megapot remains an external provider on Base, with
manual collection and conversion as operator work. Learner participation and
cash-out verification are unchanged.

## Status

Implemented so far: the new policy and its JSON, `/3` validation, readers that
pair formats with their configuration policy, public projections, and tests.
The release API refuses submissions under the new policy with
`unregistered_owner_publishing_not_enabled` until the write path lands, so
publishing a configuration that names the new policy cannot start a job that
half-applies the old registered sequence.

An HTTP-level test proves that a configuration naming the new policy refuses
upload and seal requests before any submission row or job exists.

Not yet implemented: owner authorization and the bounded budget grant under
the new policy, the
submission and job sequence without registration, release-service and runtime
dependency removal, removing creator connection and Royalties from the web
client, and acceptance with registration services unreachable.
