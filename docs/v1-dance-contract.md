# Decentralized Dance review v1

This specification precedes implementation in lane 4. It independently adopts
categorical, no-pose moderator review from api-next `origin/main`, including
`packages/domain/src/dance/moderator-review.ts`, its application service and
repository, and accepted no-pose decision `v1-dance-no-pose-policy-20261029`.
The inspected centralized local checkout is older than that remote-tracking
source (`f017e8014001a31d07b9e2de891e0907ad194b50`). The coordinator fetched authoritative sources; this confined lane
cannot fetch into common Git. No centralized runtime or imports are adopted.

## Frozen capture and media

`pirate.dance/1` admits only `moderator-review-policy-v2`, with no opening pose,
zero body offset and categorical `passed` / `not_passed`. There is no score,
automatic detector, fabricated pose attestation or Safe/pool runtime.

Before recording, the trusted server reserves a capture with immutable community,
learner account and resolved economic identity, wallet, exact song key/revision,
audio SHA-256, selected reference revision and segment (or explicit null), rubric,
rules/terms hashes, account authorization fence and optional reward offer selection.
The selected offer includes its immutable input hash, categorical source identity,
opening/cutoff and admitted policy. Selection is made before capture, never added
to a historical recording. Capture lifetime is finite and cannot exceed the
selected cutoff. Recording SHA-256 and lane 3 media ID are sealed once at submit.

Lane 3 owns uploading, processing, safety, storage, playback and erasure.
`MediaBinding` is consumed structurally, not replaced by another pipeline.
Only ready `private-review` media with all exact bindings, unexpired retention,
accepted safety and current revision may be submitted, inspected or decided.
The lane 3 SQL media fence is mandatory inside the decision transaction.
Dance's frozen reference admits 6–30 second full performances (central parity);
the public clip default remains 3–15 seconds. `DANCE_PRIVATE_MEDIA_POLICY` supplies
the version and bounds for lane 3's `privateReviewPolicy`. Capture and media bind
that exact policy version; no silent truncation or default-policy substitution
is permitted. The coordinator must install this private profile before mounting.

## Authority and immutable decisions

Authentication uses the existing community account session and Origin/CSRF write
guard. A request body cannot select its actor, role, clock or community.
The authority adapter supplies current owner assignment, account identity and
authorization revision, plus mandatory SQL commit fences in the SAME D1 database.
It must resolve alternate credentials to the same identity. Unknown identity,
inactive/revoked accounts, stale directory ownership or missing fences fail closed.
Chain ownership readback and synchronization remain a coordinator integration gate.

Only the current owner grants/revokes a scoped `dance:review` delegation. Grants
are bound to the exact owner assignment, community, moderator account and identity,
expiry and generation. Revoke is irreversible for that generation; regrant needs a
new ID. Ownership change invalidates prior grants. Immutable grant/revoke audit
events accompany the mutation. Review permissions never confer public posting.
Current owner or active delegated moderator may decide. Both account equality and
resolved identity equality forbid self-review, including alternate accounts and
ownership transfer. Authority is checked again for queue, detail, private playback,
decision and receipt recovery. Revocation never erases the immutable verdict.
The immutable verdict retains reviewer account, resolved reviewer identity and
owner assignment/delegation reference. The categorical reader refuses a
same-identity reviewer even when its account identifier differs.

Submit creates a pending review. One conditional D1 transition wins among verdict,
withdrawal and expiry. Revision checks and uniquely scoped command hashes prevent
conflicting retries. A successful verdict, its immutable event, qualification
candidate and original receipt commit in one transactional batch. Failed batches
roll back. Uncertain responses recover by replaying the same key and body after
current read authorization; a new key never retries an unknown verdict.

Review expires exactly seven days after media's first stored/upload time, matching
central parity, independent of submission delay. At the deadline it is expired:
`commitTime < uploadedAt + 604800000`. Media expiry may close access sooner.
Private receipts are immutable; media erasure is handled by lane 3 and does not
delete verdict audit. No public-feed route or URL is emitted by this module.
Current result reads project an overdue pending row as expired without rewriting
its original receipt. The explicit expiry command persists that terminal state.

## Qualification and integration hold

The authoritative time is the database clock evaluated INSIDE the successful
verdict transaction. Millisecond Unix time is retained; existing reward readers
use integer seconds and must preserve `[opensAt, cutoffAt)` by exact conversion.
An admitted pass satisfies `opensAtMs <= committedAtMs < cutoffAtMs`. Neither
capture, upload nor submission time is reward time. At cutoff, a pass is a visible
approved performance without eligibility. Closed/settled offers never reopen.

The frozen offer/source/rules/song/account fences must still match at commit.
Ordinary practice and approval do not require posting membership or palm checks.
A pass can legitimately have no reward: practice capture, unadmitted categorical
source, closed/outside-window offer, revoked reward authorization or an existing
share. Pending/rejected/expired/withdrawn/failed media cannot create a candidate.
Submission-day streaks are not implemented by this lane; they cannot substitute
for verdict time. Settlement, palm claim and approved payout remain subsequent.

`pirate.dance-categorical/1` is a proposed separate source, not V4 numeric learning.
Its reader projects only committed passes with frozen offer ID/hash, song/rules,
source identity and time. Coordinator owns the on-chain categorical contract,
final canonical block timestamp policy, public evidence minimization, reader and
prospective offer admission. Existing V4 cannot be claimed to support Dance.
Local candidates have `chainAdmission: held`; they are NOT payable entries.
The combined reward reader must combine all activity sources before the existing
account/offer collapse, retain one earliest entry and reject wallet conflicts.
Never settle a separate Dance pool or award an additional share.

## Acceptance and evidence

Focused tests must exercise real local D1 transactions: owner/delegate pass and
reject, private access isolation, self-review by alternate identity, wrong
community, revoked/expired/old-owner delegation, current media and song/rules
fences, verdict races/retry/unknown responses/withdrawal, seven-day and offer
boundaries, late pass without reward, and source-held candidate projection.
Local adapters model external authority/media facts explicitly. They cannot prove
phone capture/playback, deployed account revocation, chain publication or actual
economic uniqueness until coordinator integration passes its gates.

D1 batches are transactional; failed statements roll back the batch, per
[Cloudflare D1 database documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## Mount contract

Lane 1 mounts `DancePanel` and `DanceReviewQueue` using explicit API props.
The coordinator mounts `danceCommunityApi`, applies `packages/dance/schema.sql`
under the next actual migration ordinal, supplies current authority/media/offer
fences and routes private playback through lane 3. Public posting policy stays
an owner decision. No provider binding, deployment or activation is made here.
