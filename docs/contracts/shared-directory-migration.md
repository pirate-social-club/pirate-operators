# Explicit directory/caller migration boundary

Nothing in this proposal migrates a live installation. Root owns admission, current
mounts, migration DDL and release profiles. No migration ordinal is reserved.

For a new installation, select shared-directory/2 explicitly only after the new
contract/interface/types/tests gates. Retain the random portable communityKey and
the separate installation identifier in the durable installation inventory. Deploy
and operate infrastructure through Pirate roles; operators use app authorization.

For an existing installation, do not feed its V1 community ID to a shared-ID helper
or replace it in posts, journals, sessions, content signatures or receipts. Produce
an inventory that maps old chain/directory/community/registry/posts/install IDs to
the selected portable key and new chain/directory/instance/install/namespace/source.
Existing Naming v5 string installation IDs require an explicit canonical mapping;
this proposal does not invent a conversion or mutate a saved identifier.

The mapping must include old and new source pins, configuration history and
publisher revocations, all original-operation journals (including uncertain sends),
external TLD authority evidence, every affected name holder/generation/expiry and
locked renewal right. Changing a registry/directory pointer must not strand holders
or reinterpret an old successful receipt. The directory itself cannot seize, burn,
transfer or mint naming assets. Registry migration remains separately governed by
its accepted holder carry-over/cutover specification.

Define an explicit cutover fence and canonical receipt reconciliation through it,
current-chain/reorg checks, inventory digest, old/new controller authorization,
read routing for both histories, pending-operation handling and rollback boundaries.
A new deployment is a distinct source even when communityId stays equal. Old
CommunityPostsV1 directory pointers are immutable; carry forward their references
and read paths rather than attempting an in-place pointer change. Preserve V1
manifests/deployment records and exact historical operational scripts.

Root's proposed cache migration is independently additive:
`docs/contracts/directory-checkpoint-cache.sql`. It creates two new cache tables,
requires the existing transaction_guards table, and does not touch old evidence.
Its profile-keyed head and immutable pages are derived public evidence; they are
not originals and may be rebuilt only from authenticated chain/document evidence.
Apply it before selecting the new directoryHistoryCache implementation at a current
mount. Old snapshots/orphans remain retained until an independently admitted
retention operation proves reachability and custody.

Existing community routes already instantiate this adapter; the prerequisite is
not limited to new shared installations. Root must assign the actual migration
ordinal in its current merge order. Require the expected existing guard-table
schema and the explicit expected absence (or independently verified exact already
applied version) of both cache tables. Unknown/partial schemas refuse. Execute the
admitted additive migration as one atomic batch, with rollback on any failure and
before/after checks retaining every existing configuration, cursor and original
journal row. Do not hide a schema mismatch with IF NOT EXISTS, memory fallback or
an alternate route. This document and the unnumbered SQL are unapplied proposals;
no runtime schema creation or database mutation is introduced by the source repair.

Unchanged revisions reuse their existing immutable pages and update only the fully
authenticated head through a complete-cursor compare-and-swap. Temporary RPC lag
does not delete or replace the saved head. These changes require no additional
table/column or alteration of historical rows. Replaced/orphaned snapshots remain
preserved; no retention or cleanup operation is authorized here.

No new mounting, domain/registry repointing, HNS write, operator-key transfer or
live release is authorized by a schema-valid plan or by this document. Existing
installation selection deliberately refuses with
`explicit_existing_installation_migration_required` until that distinct migration
protocol is reviewed and implemented by the responsible owners.
