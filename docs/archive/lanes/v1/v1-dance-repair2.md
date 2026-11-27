# Dance repair2 local admission repair

This successor starts from coordinator-preserved a788e7269ae486b0d13dd322c87e355c69034c8d.
The complete dance-repair1-ui-source-review.final.txt was read. Its five concrete
findings are addressed within lane-owned source; every historical handback,
manifest, patch and recorded evidence file is preserved. V5 remains the local
semantic contract. No Solidity, source/ABI/hash acceptance or live activation is
implied by these changes.

The receipt INSERT now joins consent through r.review_id rather than an undefined
c alias. Every submission, decision and withdrawal receipt INSERT is followed by
a changes()=1 guard in the same batch. A zero-row receipt, uniqueness conflict or
receipt/producer assertion failure rolls back media retention, acceptance,
revision, intent, outbox and receipt together. Original submission receipt/time
and seven-day exclusive deadline survive lost-response recovery unchanged.

Local delegate revocation is a lane-owned SQL predicate over immutable control
intents. It travels with private result, playback, queue and receipt-recovery
fences. The store independently adds it to decision admission, so a caller cannot
omit it. Final checks occur after awaited clock/media/receipt observations. This
is local transaction admission, not a solution to the post-broadcast canonical
race. Direct owner authority remains distinct from delegated authority.

Dispatch preparation accepts only ready, unknown or orphaned outbox states and
decision_pending review state. Its last atomic guard rechecks current revision,
denial/deadline, immutable payload, local delegate denial and dispatch state after
the final outbox read. The actual attempt write repeats those native guards,
including stored canonical-final evidence, in the same batch that persists the
raw attempt and marks it unknown. It requires a nonempty fresh authority/rules/
media/authorization fence set from the eventual coordinator executor. A snapshot
returned by prepareDispatch is not a capability to bypass attempt admission.
Nothing in this lane broadcasts a transaction. Already broadcast transactions
remain governed by canonical ordering.

Delegation retries read the original retained control intent before resolving an
inactive target or looking up new chain epochs. Exact semantic request identity
must match. Current owner HTTP access is checked independently at recovery, while
original owner/config/reviewer epochs, wallet, payload and integrity hash remain
unchanged. Concurrent/lost-response acceptance uses the same retained-intent
recovery path. Existing revoke requests normalize expiry to zero; no previously
retained command encoding changes.

Client body decode failure preserves authoritative HTTP 401/403 status and a
definite private-access denial. Existing controller cleanup therefore clears the
loaded review/capture/take and invokes private media cleanup for plain-text
responses too. Uncertain successful/server-error responses remain uncertain, and
neither denial nor decoding failure discards or replaces an original journaled
command. No pure Solid surface, flow, copy or provenance file changes in repair2.

The new SQLite adapter runs the actual lane schema, receipt INSERT and generated
submission/decision/withdrawal/guard/attempt/control statements against
node:sqlite DatabaseSync(':memory:'). It uses a small D1-shaped adapter with real
SQLite transactions, JSON functions, changes(), constraints and triggers. Its
producer retention plan and external authority predicates are explicitly test
fixtures. They do not prove actual source3 processing, D1/Worker execution,
browser behavior or chain verification. The pre-fix no-such-column failure and
all intermediate check errors remain recorded under .local/repair2.

Boundary regressions accept revocation immediately before decision SQL, after
the last private clock/media/receipt observation and at final queue admission.
Withdrawal races before/after the final outbox read, within the final guard and
between preparation and attempt admission cannot return/broadcast-ready work or
persist a new attempt. No network or transaction is sent by these tests. Epoch-
advanced identical grant/revoke retries and plain-text denial after private
state loading are covered separately.

Repository port details and held control-projection proposals are in
.local/interface-proposal-dance-repair2.json. Canonical control evidence must be
actually verified and projected separately from immutable intents before a later
accepted regrant can supersede a historical local revoke. This repair keeps the
existing conservative denial latch; it does not invent a reconciliation result.
Root still owns source/ABI/hash/verifier/reader admission, every-private-byte
producer mounts, retained historical account bindings and atomic closure
snapshots with settlement revalidation. No shared mount or migration ordinal is
edited here.

Only one-worker memory/SQLite/mocks, formatting and scoped typechecks are admitted
in this round. Worker/browser/build/fixed-port/Forge/fork/provider/network and
full repository suites require a new explicit coordinator slot. The new handback
is .local/handback-dance-repair2.json; earlier handbacks remain historical.
