# Dance V2 publication admission

The reader checks a selected Dance V2 source, Directory configuration, runtime
code and original purpose-specific grants at one canonical block. Capture uses
the learner's original grant and start time. Review additionally uses the
reviewer's separate attribution grant and owner or delegated-reviewer authority.
These grants supply no media permission.

Finite owner, reviewer and grant windows are checked against trusted current
time after awaited work. The returned predicates also check the actual D1 clock
in the accepting transaction. Callers must reuse every predicate alongside their
original capture, account, media and authority guards. A read result alone
cannot authorize an accepting write.

When a safe block predates the actual start, the reader reports temporary
unavailability. Retry retains the same capture, grant and bound time until a
canonical observation covers it. It never backdates the start. Starts later
than trusted current time remain invalid.

Original-command recovery runs before current permission checks. It compares
an independent immutable snapshot with both the callback input and returned
receipt, preserving historical outcomes after withdrawal, expiry or source
replacement. The production journal must independently verify that original
receipt; this adapter does not replace its transaction reconciliation.

The qualification uses actual D1 acceptance and rollback, production ABI
encoding/decoding and explicitly scripted RPC observations. Its TAP diagnostics
retain source, capture, original grant and accepted identities. The journal
tables in the test fixture exercise the port contract; they are not the real
application journal or deployed-chain evidence.

This slice adds read and predicate construction only. Application mounts,
private producers, the concrete publication journal, selected deployment and
sender integration remain separate work. The first-song profile stays as
configured. HNS is optional.
