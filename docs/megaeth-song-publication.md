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

Not yet implemented: owner authorization under the new policy, the
submission and job sequence without registration, release-service and runtime
dependency removal, removing creator connection and Royalties from the web
client, and acceptance with registration services unreachable.
