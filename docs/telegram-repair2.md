# Telegram repair 2

This delta addresses the three findings in `telegram-repair1-source-review.final.txt`
at `3f99b3e74320c7a8443bae2dd4625e37dae4156e`. The previous seven repairs and
their frozen evidence remain in place.

An account index is a pointer, never authority. Lookup requires a live grant for
the requested account, community and bot, at its canonical sender row and current
incarnation. Invalid pointers are removed without modifying the row they point
at. Unlink and sender-row reuse retire the previous pointer only if it still
points to that row. The durable unlink counters and generation fences remain.
The HTTP regressions use separate simulated sessions and CSRF proofs, actual
connection/preference handlers, the real linking/broker controllers and in-memory
SQLite. After A unlinks and the sender connects to B, A cannot see B's status or
preferences, change them, or unlink B, including with a legacy pointer present.

Fresh authority is checked again after awaited admission for both a new grant of
capacity and proven-unsent reuse of already-dispatched admission. Immediately
before the write-ahead submission boundary, the same transaction checks worker
ownership and synchronous local bot, lesson/prompt and grant authority. The
boundary and actual port invocation have no intervening await. Linked work uses
the same local boundary before calling the shared Study port. Unknown outcomes
remain status-only; absent receipts do not prove non-submission. Recovery from
a genuinely reserved admission still proceeds once when authority remains valid.

The client checks its account after response headers and after JSON body delivery,
including parse/read failures. A stale private status, server error or body error
cannot escape after an account switch. A delayed completion cannot acknowledge the
wrong account or consume the callback. This changes no UI, login proof or route.

The composition factory wires the synchronous local gate. A standalone speech
fixture must also bind the actual local check when updated for this delta. The
shared publisher still must persist and enforce its grant fence at queue acceptance
and every unsent actual dispatch or recovery, including restart. A marker alone
supplies no enforcement. No shared mount, schema, provider, origin, credential,
Paper, widget or coach change is part of this repair.

Only single-worker memory/SQLite/mock tests and scoped typechecks are run here.
The earlier broad check remains interrupted and non-green. Preservation,
independent review, integrated exact-candidate gates, runtime/broker and real
phone acceptance remain coordinator-owned and held. See
`.local/handback-telegram-repair2.json` for the exact delta and results.
