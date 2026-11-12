# Canonical controls and prospective regrant

This source successor starts at f26f08225a66fc14246fbf261834d0c68af39891 in the
same admitted Dance worktree. The mandatory launch probe denied all four outside
write opens and passed the assigned local write. The rejected E+1-only draft is
not an input to this implementation. The design review's stale-E counterexample
is a required queued regression, not an accepted clearance rule.

One matching unresolved revoke is an unconditional local veto. Prospective
delegated access needs verified canonical acceptance of that exact frozen revoke
at E+1, plus an active current canonical role R>E+1 in the same wallet/source
resource. The current owner/configuration and exclusive owner/role expiries must
also match. Every matching revoke must meet the rule. Account-only matching with
a different wallet retains the veto; independent counters are never compared.
Malformed JSON, unknown operations, missing or noninteger epochs, NULL and
unsupported counters fail closed. E=0 is supported. Owner authority remains a
separate branch because its epoch is not the delegated wallet counter.

New local controls may receive an original immutable binding through the optional
controlBinding port. The binding seals the selected admitted source, original
owner account caller, local intent hash, exact V5 operation tuple, command ID,
command hash, encoded payload and calldata in the same D1 batch as the intent.
The existing ABI/wire modules are reused unchanged. Grant expiry must be exactly
representable in seconds; there is no implicit rounding. An identical retry
recovers the old intent before querying mutable context and never backfills its
mapping from current roles. Legacy unbound controls remain unresolved.

The new control reader recomputes the complete binding and uses the existing
CommandApplied ABI. It checks the exact caller, command, operation, wallet
resource and resulting epoch; canonical block/transaction/log position;
receipt-owned raw event bytes; original retained transaction hash/bytes; event
time; source/runtime pins; and final historical/safe anchor rereads. Historical
code/state reads use the existing hash-pinned RPC adapter. There is no ABI
fallback, new source, live source selection or role-state substitute for proof.
An account-contract caller is verified by the pinned runtime's msg.sender-bound
command event, rather than an invented EOA-only top-level transaction rule.

Canonical control evidence is append-only. Its separate projection can be
canonical, uncertain or orphaned. A missing receipt is uncertainty, not reorg
proof. Orphaning needs a stable canonical replacement of the original block.
Earlier raw evidence, command bytes and attempt hashes survive demotion.

The composite reconciler reuses the independently reviewed role observer without
editing it. Matching controls and the role are verified at the same safe anchor.
The role projection uses revision CAS, nondecreasing block height and a retained
role-counter watermark; inconsistent same-height observations refuse. HTTP
authority carries the exact durable revision/head stamp. SQL clearing requires
the exact control projection and active role projection at that same anchor.
Current role booleans, epoch arithmetic and replay of an old grant do not clear
anything on their own. New local revokes accepted during observation still veto
the final SQL admission even when absent from the earlier scan.

Decision staging and final attempt admission read the immutable decision's
captured role, owner, configuration and source fields. They compare them with the
durable current projection and every revoke floor. They never substitute the
new role R into an old decision. Existing status, withdrawal, deadline,
canonical-final and payload guards remain. HTTP recovery can return an old
receipt after current private access is restored, while keeping the original
decision/reviewer/epochs and bytes unchanged.

The eventual executor must record a guarded attempt BEFORE broadcasting. New
control attempts also record their exact binding admission. Canonical control
clearance requires that guarded original admission; a recovered-only legacy
attempt can establish historical evidence but cannot invent this causality.
This ordering is an obligation of the trusted local executor, not a cryptographic
wall-clock proof manufactured by the admission marker. Its actual mount remains
held for independent integration review.
The separate retainAttemptEvidence method preserves already-broadcast bytes and
hashes after revocation/withdrawal without requiring send admission, changing
dispatch state, creating guarded admission or sending again. Verdict receipt
discovery reads both retained-attempt tables. Root must not interpret successful
evidence retention as authorization to broadcast.

The implemented clearance path requires an exact accepted revoke. A stale revoke
that never executed, a legacy control lacking original source/caller preimages,
and an evidence-only imported attempt remain vetoes. Fully verified explicit
supersession is not invented here. Likewise, replacement of a durable role
anchor holds authorization; counter rewind or rebootstrap requires separately
reviewed coordinator policy. Both limits preserve safety rather than silently
reviving an old decision. The bounded matching-control scan holds at more than
256 rows instead of skipping rows. Historical compaction is a separate gate.
As before, a fresh local grant uses a fresh delegation ID; replay of the old
primary-keyed delegation is recovery, never a new grant.

The additive local SQL is packages/dance/canonical-controls.sql. Fresh schema
includes those exact bytes; the coordinator must apply the migration once to an
existing database and assign its ordinal. No shared migration/configuration,
renderer, provider, publisher or actual Worker composition is edited. The
canonical role and exact V4 readers, existing chain ABI/wire/RPC/selection,
contracts and established Solid UI/provenance remain unchanged.

No test, typecheck, build, package check, browser, Forge, install or network check
is run in this turn. Tests are prepared for actual memory SQLite plus named
simulated chain/role ports; raw ABI/receipt/runtime verifier cases are separate.
The pinned formatter and git diff --check are the only source checks. All exact
source/type/SQL/runtime tests and independent review are queued to the
coordinator's serial gate. No physical/UI/provider acceptance, activation or
complete protocol conformance is claimed.
