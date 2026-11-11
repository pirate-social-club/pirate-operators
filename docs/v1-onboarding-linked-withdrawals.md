# Linked withdrawal repair1 — source-only successor

This repair starts at preserved `8cc15b31d48f704389df90105c3ff77fc76d85df`
and addresses only the six findings in the operator and community ledger source
reviews. The historical implementation notes below describe the earlier
handback. Its sealed `.local/onboarding-linked-withdrawals/**` artifacts remain
byte-for-byte unchanged. New proposals/evidence live exclusively in
`.local/onboarding-linked-withdrawals-repair1`.

Proof must cover the immutable signal that staged each operation, including
its cutoff and consumed nonce where observed. A canonical safe anchor at500
cannot acknowledge a retained signal at800, even if it is otherwise valid.
Direct chain markers retain cutoff and consumed-nextNonce separately from a
signed revoke nonce. Unknown/older proof keeps openProofs, work and marker ACK
pending. Exact original canonical revert still records its distinct recovery
floor and reverted outcome; it does not fabricate a successful withdrawal.

The full replacement operator proposal puts withdrawal recovery before the
public `/recover` general transaction sender, as well as before tick's
publication/retention and in startup/alarm continuation. Final synchronous
pre-send gating and original attempted receipt/commitment reconciliation remain.
The required SQL fixture now executes statements eagerly, returning captured
rows. Constructor DDL and writes no longer depend on calling `toArray()`.

Community turn-on compares its captured dirty version inside BOTH the settings
mutation and operation completion CAS. A newer Off arriving during its awaited
chain read preserves the Off, the old pending operation and its predecessor;
it is not consumed merely because a dirty repair row remains. Epoch/source
original-version fences remain in the same completion transaction.

Before freezing a <=50-row page, discovery reuses the canonical V4 SIWE parser
and EIP-191 ID, matching retained compact learner/nonce/issuance, row issuance,
community/origin, original target, policy and subject. This validates the exact
identity of an already admitted signature; it never substitutes EOA-only
verification for MOSS or calls a live provider. Cross-wired canonical IDs,
issuance or target/context holds cannot issue exact authorization tombstones.
Prepared fixtures now contain legitimate signed V4 messages/IDs using only the
existing public fixture account, including a consistent original Study binding.

The old per-page malformed full-history scan is replaced by a partial invalid
index lookup and bounded full-identity validation on the existing keyset pages.
An account original-revision ledger advances on inserts, deletions or immutable
identity-column changes, while routine state/receipt/retry updates leave it
unchanged. Staging captures that revision atomically. A late identity mutation
behind a frozen cursor holds the operation, callbacks and completion across
restart; it cannot silently reuse cached page validation. Such unexpected
identity mutation remains an unresolved obligation for coordinator repair,
not permission to reset an acknowledged page or rewrite an original.

The NEW full replacement migration adds the partial index, revision table,
triggers and captured revision column. No migration was applied or ordinal
reserved. Replace the previous unapplied proposal set; never stack both sets
or rewrite earlier evidence. Each protected patch has its exact source base
and hash in the new repair directory. The community/Telegram call-site proposal
signatures are unchanged. Protected source files were not edited.

Prepared regressions cover delayed safe-head/nonce coverage, marker ACK holds,
original revert, eager SQL, both `/recover` ordering failures, delayed turn-on,
cross-wired originals without tombstones, actual query plans, multipage restart
and syntactic/semantic changes behind a cursor. ALL tests/typechecks remain
UNRUN by this actor. Only the mandatory scope probe, pinned formatter and
`git diff --check` run. Dependency/hosted CI reports and A6 install repairs
supply no source clearance for this successor. Authenticated actions,
target-specific bridges, managed runtime/marker assembly, provider/device and
new-account/second-community acceptance remain held. No connected marker or
runtime/provider readiness is claimed.

---

# Linked withdrawal journal and community authority ledger

This uncommitted successor starts at
`f26f08225a66fc14246fbf261834d0c68af39891` in the original confined lane6
worktree. It implements corrected contract
`next-operator-linked-withdrawal-contract-v2.json`. Contract v1 remains held.
No connected capability or runtime activation is established by this source.

## Operator state and ordering

The new `study-linked-withdrawal*` modules separate immutable signed operation
identity from a normalized community/original-target/learner head. A signed
revoke is simulated first. Its durable write then rereads the retained job,
compares original target, subject, nonce, signature, calldata and digest, and
commits the job, linked hold, work record and earliest existing wake together.
Exact retries never restage a completed identity. Recovery passes the stored
target instead of selecting the current configured contract. Original signed
transaction bytes, hash, sender and nonce are recovered from the retained
native row and pinned; this path never signs a replacement.

Heads retain revision, successful cutoff, separate recovery issuance floor,
revocation nonce, open proofs and bounded discovery cursor. Safe proof merges
are monotonic. A larger cutoff/floor or nonce starts another selection revision;
old pages cannot seal that revision. A canonical revert remains `reverted` and
sets only the separate recovery floor. Authority coverage never claims that
the original transaction succeeded. Unknown proof remains pending.

Discovery requires the coordinator's SQL index. Pages contain at most50 actual
accepted linked bindings, including bindings whose D1 reply/publication insert
was lost. Every binding's offer/exercise hashes, original target, learner,
authorization ID/issuance and Telegram fence are validated before an original
authorization denial is recorded. Page denial and cursor writes are atomic.
Malformed rows retain their cursor and unresolved diagnostic. Unclassified
rows, including explicit JSON-null hints, prevent readiness. There is no
production `entries()` discovery fallback.

Only captured originals at/below the verified issuance floor get the existing
authorization-kind tombstone. A later valid original stays recoverable.
Already-erased binding markers remain closed; discovery never reconstructs
their erased learner/authorization identifiers. Native uncertain/attempted
transaction evidence remains untouched. A later original receipt is reconciled
before send gating, with no rebroadcast after established invalidation.

Bootstrap has two bounded durable passes, over old withdrawal markers and
existing bindings. It stores a migration revision/cursor/error. Direct
marker-exists-but-unprocessed guards hold immediately. Accepted binding writes
register observation in their durable transaction. The proposed old-marker
writer hook advances bootstrap revision and wake atomically, including writes
behind completed cursors. Independent watches continue after bootstrap and do
not stop merely because a later sign-in made `authorizedSince` nonzero.

Recovery persists fair cursors and a wake before remote proof, bounds proof
reads with cancellation, and retains work when the last binding disappears.
The required original-transaction port performs local journal/cryptographic
work only. The required proof transport must honor cancellation through its
retries. Startup/alarm predicates and recovery-before-publication/retention
are supplied as unapplied coordinator patches.

## Temporary holds and bind capture

`LinkedWithdrawalPending` and `CommunityAuthorityPending` are retryable503
errors. They must never become boolean permanent denial, `keepPrivate`,
`markWithheld`, replacement receipt or refund. The shared gate proposal checks
pending both before and after resolver awaits, before interpreting even a
false result. Existing synchronous recorded gating covers allocation and the
final broadcast-attempt boundary without adding an await there. Receipt-first
attempted-original reconciliation is retained.

The shared Study caller must capture head/bootstrap/source revisions before
its resolver await and pass that capture to `bindAuthorizedLesson`. Missing
capture holds linked admission. Inside its durable binding write, the owned
code compares those captured revisions, readiness, original issuance floor and
existing tombstones. It writes binding membership and recovery observation in
the same transaction. A bind spanning staging and completed discovery fails
its old capture. Capturing only before the later chain read is insufficient.

The existing `pendingWithdrawal` branch remains unchanged for ordinary website
practice. Connected selection throws a distinct retryable error for that
state and for the separate operator `linkedWithdrawalPending` observation.
The latter is readiness information, not a capability marker or safe-proof
fallback. Ordinary website operation makes no new safe-proof request.

## Community action and epoch ledger

`packages/community-setup/authority-*` provides persisted account race revision,
pending operation, permission revision, immutable action/predecessor, bounded
original pages/membership and per-page acknowledgment. The proposed unnumbered
D1 migration is not executed here. It captures challenge/authorization epochs,
prevents insertion while pending/dirty, and refuses an old challenge whose
signature verification resumes after off/on—even with an ahead-clock issuedAt.
Actual session login can still complete without inserting that authorization.

Original discovery uses every retained authorization state in the captured
predecessor epoch, rather than the newest sign-in or publication rows. Bad rows
are checked independently of the cursor. Original pages are frozen before the
bridge call; a lost reply retries the same IDs and cursor. A transition cannot
finish before discovery is sealed and all required bridge acknowledgments
complete. Final head/settings writes compare the same operation/epoch.
Acknowledged nonce maxima and valid later sign-ins survive historical
observations. Versioned dirty rows retain later off writes behind a completed
cursor; an older finish cannot consume their new repair obligation.

An explicit authenticated application action is distinct from the EIP-712
revocation digest. A fresh off after on can retire newly affected permissions
even if an earlier exact revoke reverted with the same nonce. The ledger never
replaces or resends that terminal transaction. The server-installed action
producer must enforce existing session/Origin/CSRF checks, reconstruct trusted
account/wallet/scope/target/nonce/cutoff, validate the exact predecessor and
retain the same action ID on uncertain retries. An arbitrary caller-supplied
ID or body is not authority. There are no disable/reassociation endpoints.

Every action retains its original V4 target. Recovery uses a required target
registry; mismatched current-default ports fail instead of redirecting work.
Canonical local lesson/attempt/private-publication cleanup runs before any
bridge callback. The selected-profile relay guard keeps holds pending and
uses completed original membership to prevent resurrection. The shared route
proposal preserves the existing API paths and leaves ordinary website consent
and account behavior outside connected selection intact.

The Telegram actor's proposed begin/append/finish authority interface is a
dependency. Its managed transition retires a grant, which is appropriate for
explicit account off. Historical observations instead use the owned
`authorityDenialTransition`: only affected original authorization IDs go through
the required issuer-signed denial bridge, with exact denial-hash acknowledgments.
It never writes a broad grant denial. The shared account-reader proposal uses
race revision for before/after pending checks and permission revision for stable
grant identity. Thus a temporary selective observation does not permanently
discard an unaffected grant. A changed race revision after an await is503,
not a false authority observation.

## Coordinator integration and gates

The exact unapplied patches, their bases and migration SQL are in
`.local/onboarding-linked-withdrawals`. The coordinator owns Store/index,
runtime/scheduler, shared Study/publication/sender composition, account-reader
and community route mounts, all config/manifests/migration ordinals and final
source admission. No protected source is edited here.

Foundations at `d608c743cce23147620d2694dae02284d1be42ac` have the unchanged
public index/proof interfaces and corrected null-hint/index/proof handling.
The coordinator reports root/web types,25 focused passes and independent repair
clearance. Those are dependency reports, not tests of this successor. The
original Telegram repair at `fc9b` plus account-row normalization `ee6a820`
has reported64 focused passes, with independent review still active at this
handback. Its shared composition remains unapplied. No dependency module is
copied into runtime here; planned imports and structural ports are explicit.

Required integration includes actual admitted runtime code hashes (constructor
immutables included), old-target registry entries, the additional indexed
unclassified-legacy guard, durable wake/continuation, bounded cancellation-aware
bridge/resolver calls, authenticated action producer and exact target-specific
signed bridge. These adapters and their startup composition remain coordinator
acceptance work. They cannot be inferred from a binding name or port type.

Prepared regressions use actual SQLite Store/index and D1 SQL/atomic batches,
with explicit proof, RPC, signature and bridge fixtures. They cover delayed
resolver approval, allocation/signing/final-send holds, attempted receipt-only
reconciliation, several pages/originals, late valid authority, revert floor,
same-second nonce/cutoff merges, stale completion, bind spanning completed
discovery, malformed/behind-cursor records, last-binding erasure, lost responses,
rollback, off/on/reverted intent and challenge epochs. The gate request also
queues existing actual Worker/website/trial/privacy/retention regressions.
Old permissive Map/partial-binding fixtures need faithful SQL/port adaptation;
production guards must not be relaxed to make those fixtures pass.

All these regressions and typechecks are UNRUN. This actor ran only its
mandatory scope probe, pinned formatter on owned files and `git diff --check`.
The coordinator's frozen W10 full run is separate and cannot validate this
delta. Its earlier f26 full run had two failures, with coordinator repairs
reported clear; it is not relabeled as a pass here.

No UI work is included. Earlier pure Solid/Storybook provenance, MOSS and the
decentralized backend remain unchanged. Alchemy/Infisical custody, native bot
plus optional widget, website Claim/Send, no retroactive trial credit and all
provider/deployment/credential/funds holds remain. Actual new-account,
second-community, device/provider and connected-runtime acceptance stay held.
