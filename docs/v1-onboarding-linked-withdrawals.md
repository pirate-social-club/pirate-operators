# Linked withdrawal repair4 — credential witness ordering

Exact source base is `484ae13187cfc3bbb5ef511ed3c2261b6516a630`.
Its runtime/migration source equals the reviewed32958cb tree. Coordinator root
and web types plus66 cases belong to32958cb; root types and four actual pinned
Alchemy/workerd D1 migration cases passed at484ae131. Those are dated predecessor
receipts, not repair4 verification. The coordinator's actual migration tests and
fixtures remain byte-for-byte unchanged. All repair4 tests/types are UNRUN.

Policy2 captures the account credential revision BEFORE the captured-wallet
lookup. The atomic validation upsert takes that exact captured number as a
value and requires the current revision still match; it cannot silently adopt
a newer revision after the lookup. The returned row must match the captured
policy/revision, the cursor CAS includes it, and both cached-completion and
empty/full scan paths retain it through readiness checks. ABA mutation changes
the monotonic counter even if all credential row bytes return to their old value.

Managed delivery carries this private witness to its final post-sign/pre-fetch
validation. A concurrent retry completing a newer valid certificate cannot
rescue an older caller: that caller still requires its own captured revision.
Existing public validation/recovery signatures remain intact. Policy1 cursor
and completion provenance is never grandfathered; a safe retry resets and
revalidates using policy2, preserving retained requests, queued children and
historical ACKs. The existing50-member keyset bound and durable generation/
progress remain. No original signed proof/raw transaction or target is rewritten.

The only protected proposal updates authority-recovery's hardcoded policy1 SQL
reference to the exported policy constant so settings/completion CAS use the
same repaired policy. It is pinned to exact484ae131, is not applied here, and
must compose before the queued completion tests. No schema/SQL18 edit, ordinal,
installed/live SQL execution, factory or runtime selection is introduced.

New deterministic cases use the actual DB validator and real managed bridge
with a captured grant and zero frozen members. They pause exactly after wallet
lookup and before upsert, after upsert, and after a completed readiness read;
mutate the real fixture credential binding/counters; and require no denial fetch
or permanent ACK on stale calls. Stable binding, ABA/retry, newer completed
provenance, old completion/retained ACK, and persisted cursor restart cases are
prepared. Existing witness/assertion files and coordinator Alchemy cases are
read-only and retained. No always-allow validation stub is added.

The local four-case migration result does not establish installed/live SQL,
selected producer/factory/startup/alarm, original-target source/issuer assembly,
connected capability or full/provider/device/fresh-account/second-community
acceptance. Those remain held. No UI work or transfer/Send was performed.
New source/evidence/proposal hashes and queued gates are sealed only in
`.local/onboarding-linked-withdrawals-repair4` and its new root handback.

---

# Linked withdrawal repair3 — retained credential-validation provenance

Exact source base is `fe385519aef10fe4d2cf5ce1e73f4486fdbafff4`.
The coordinator's repair2 composition and root/web types plus56 focused passes
are dated predecessor evidence. The remaining held P1 concerns old frozen
membership and queued denials, including sealed or already-advanced operations.
All older sealed evidence remains byte-for-byte unchanged. Repair3 artifacts
live only in `.local/onboarding-linked-withdrawals-repair3`.

A new durable validation journal records a source-versioned policy, original,
credential and membership revisions, generation, keyset cursor and completion.
Every pending operation, sealed or not, validates ALL retained members, including
already-ACKed and earlier pages, before a delivery/finish callback. Each pass
reads at most50 members plus one indexed continuation probe, validates complete
retained canonical originals and exact account credentials, and advances its
cursor only by a generation/revision CAS. Missing provenance never inherits an
old authorization decision. Failed or stale passes retain their obligations.
Partial passes keep the operation pending with an armed recovery wake; they do
not become a permanent refusal. No frozen request, original, proof or denial is
rewritten to repair bad legacy data.

Credential revisions advance atomically on canonical binding identity changes;
membership revisions advance on inserts/deletes or identity changes, not ACKs.
Changed snapshots restart the bounded pass. Completion and both settings effects
also compare this provenance inside their existing SQL CAS. A new valid page may
require additional bounded passes over retained members; tests drain to the
actual completed state with a finite bound rather than assuming a call count.
The canonical lowercase/unique MOSS6343 credential constraints remain intact.
The existing corrupt-import ambiguity lookup regression is retained; sealed
recovery additionally covers missing and changed canonical bindings.

The NEW protected successor proposal makes managed authority transitions require
`authorityValidation: request => validateManagedAuthorityDelivery(db, request)`.
The port binds the exact retained transition ID, immutable action/request hash,
account, community scope/generation, original target and queued denial to D1
membership and current credentials. It runs after issuer signing and immediately
before each irreversible denial fetch, and before transition completion, through
both explicit finish and independent recover/alarm. A missing port holds legacy
work. A denial not in retained membership holds. Other Telegram lifecycle kinds
retain their existing authority rules. The selective historical bridge retains
its narrow authorization-only scope and requires its transport to invoke the
supplied `beforeSend` guard after signing; the exact client proposal supplies
that hook. This adds no runtime mount, action endpoint or connected marker.

The unpublished numbered18 proposal adds the validation journal, membership
counter/triggers, credential revision heads/triggers and transition lookup index.
It is a delta against exactfe385519 plus a full resulting SQL text. No protected
file or migration was edited and no SQL was executed by this actor. New tests
read the actual coordinator-composed numbered18 file as one native SQLite script;
that does not qualify a D1 migration/upgrade runner. Existing semicolon-splitting
migration helpers cannot parse trigger bodies and remain an explicit gate. Do
not replace this gate with hand-executed exported source DDL or call a local
replacement an executed upgrade.

Prepared regressions use actual recovery, native SQLite/D1 modeling, actual
Telegram journal/bridge, issuer signing and request verification with explicit
mocked operator receipts. They reconstruct the legacy59908a wrong-learner-under-
account state at a sealed boundary and after a full advanced page; prove no
new wrong selection, denial or ACK; cover independent recovery, positive sealed
multipage recovery, credential removal/change and repair retry, deferred stale
validation, lost-CAS-response restart and missing required composition. These
repair3 tests and all type/build/package/Worker/browser/Forge gates are UNRUN.
Only the isolation probe, pinned formatter and git diff --check run. Actual
numbered18, trigger-aware D1 migration, authenticated action/original-target
issuer bridge, runtime/source/alarm/connected selection and full/provider/device/
fresh-account/second-community acceptance remain held. UI and release source
are outside this repair, and no transfer/Send was repeated.

---

# Linked withdrawal repair2 — four finding successor

This delta starts at coordinator candidate
`59908a5469702266e48a147c73fb68cf2de09f22`. The coordinator applied the former
protected proposals and numbered migration18 locally, preserved dependency and
narrow type/import/fixture repairs, and recorded root/web types plus41 focused
passes before this delta. Those dated receipts do not qualify these repairs.
All earlier sealed `.local` artifacts remain unchanged. The new handback lives
in `.local/onboarding-linked-withdrawals-repair2`.

The Study successor proposal rechecks linked pending after the later permission
read. Private closure preserves the exact unallocated intent and its reserved
or charged sponsorship while the cleanup proof awaits. Only that still-unallocated
first intent/reservation is excluded from the absence observation; any allocated,
signed, orphan or other charged work remains evidence. After the proof, linked
pending is checked again before one synchronous transaction retires that intent,
refunds/releases sponsorship and writes the private receipt. Private receipt and
history-erasure boundaries also guard after their cleanup awaits. Existing
canonical commitment and attempted transaction reconciliation remain intact.

Accepted withdrawal identities are persisted independently of timestamp changes.
The owned settings writers batch settings acceptance and an insert-only journal
of the existing submitted revoke nonce or observed consumed nextNonce. A new
identity atomically increments the dirty version; retries of the same identity
retain the original evidence. Thus a delayed On cannot clear a same-second or
lower-chain-time fresh Off. Neither a new transaction nor an application action
identity is invented. Existing explicit action/predecessor identities remain.
The ordinary website schema keeps its existing path; once the authority schema
exists the journal is required, and a partial migration holds. This schema
selection changes no proof/source authority and chooses no mutable default.

Full original validation now also requires exactly one MOSS credential binding
for the retained subject in the community account namespace/network, belonging
to that original's account. A bounded indexed lookup checks this before page
freeze and immediately before selective permanent denial. Consistent signed
other-wallet originals crosswired under another account, missing bindings and
ambiguous imported bindings hold instead of selecting an authorization. No
EOA-only replacement of admitted MOSS signature verification is introduced.

The Telegram HTTP successor proposal authenticates the existing community
session first, then preserves temporary authority503 errors. Invalid sessions
and account refusals remain closed; pending is never changed to allowed or a
permanent denial. An actual public-route/session-SQL regression is prepared.

Protected proposals are NEW deltas against exact59908a file objects, including
a delta and full resulting text for existing migration18. They do not replay
former hybrid-base replacement patches. Migration18 is not executed here, and
the coordinator must decide the actual schema application/upgrade sequence.
All tests/types for this repair are UNRUN. Only the isolation probe, pinned
formatter and git diff --check are admitted. Authenticated action production,
original-target issuer bridge, managed runtime/alarm/source pins and connected
capability remain unassembled; provider/device, fresh-account and second-community
acceptance remain held. Hosted/release evidence supplies no candidate admission.

---

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
