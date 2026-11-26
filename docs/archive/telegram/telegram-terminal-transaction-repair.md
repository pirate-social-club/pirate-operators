# Community transaction termination

This bounded repair starts at
`5204ba10d22d92035ceb2125c3ffcad60e740763` and targets the existing combined
composition at `1fe7d771e6c03e8de7b8d9a78a960459ff0493ba`. The retained review
has SHA256 `613fb5604a8e210aa9a3e71d50ba65aa15fb103ca07f0cfd740e2124e876b7b6`.
The earlier broker403 retention and actual D1 pagination fixture remain intact.

On the existing start route, `TelegramLinking.bound` reports
`410/telegram_connection_expired` or `404/telegram_connection_not_found`
before broker dispatch. The community handler echoes the submitted original
transaction ID. A matching validated ID, exact status/code pair and unchanged
captured client context therefore establish termination of that operation.

The client computes `TelegramRequestError.transactionTerminated` from that
correlation; it does not accept a flag from response JSON. A terminal error
exposes no resumable ID and leaves `pendingStart()` invalid with a null ID.
Explicit Retry and another Start send nothing until the local intent is
explicitly cancelled. The client never automatically creates a replacement,
replays the consumed reference or dispatches another request.

The existing community identity/binding invalidation remains. Broker403
`telegram_broker_client_required`, transient errors and terminal-looking codes
with an unproven status retain the same original ID. For transaction termination,
missing, malformed or foreign reply IDs cannot replace or retire a captured operation.
Account, generation, cancellation, delayed-body, CSRF and Origin fences remain.
The proof is limited to this trusted start producer; other API errors cannot
manufacture a terminal start result.

All new cases are unrun. Client cases cover authoritative expiry/missing,
ambiguous status or ID, broker403 retention, ignored response flags and a delayed
terminal body across a replacement account intent. Actual-handler cases reserve
a transaction through real community routes/session/CSRF/cookie handling, then
reach its exact recorded expiry or remove its task-owned test journal entry.
They check the authoritative echoed error, no broker call after termination,
no automatic request, retained consumed-reference identity and no replacement.
An explicit direct reference replay is also rejected by the real handler.

The actual-handler cases use the coordinator's clock-aligned combined fixture
at the pinned W1 commit or its admitted successor, on ports20353/20354. They
neither change production expiry nor supply fake authentication. Their initial
unavailable broker is an explicit test transport. The retained actual broker403
and guarded pagination cases are queued unchanged with the new cases.

Only pinned Prettier3.6.2 and `git diff --check` run in W8. The reported58
predecessor client passes do not qualify this successor. All types, tests,
builds, native/runtime/provider/device gates remain coordinator work. No shared
production service, broker, auth, guard, native fixture, endpoint, origin,
credential, resource or account setup is changed. No protected-file proposal is
needed. The new packet supplies exact source and W1 integration images, producer
pins, regular-file archives, hashes and unchanged historical witnesses.

There is no source publication, connected marker, activation, financial action
or runtime/native-phone acceptance claim. Earlier sealed packets and assertions
remain byte identical.
