# Managed Telegram publication transitions

The source composition takes the existing signed `StudyOperatorPorts` and a durable earliest-deadline scheduler. `TelegramManagedPublication` owns the pinned operator target, validated scope staging, exact denial acknowledgements and restart recovery. The community entry points call its readiness gate. Recovery runs before ordinary readiness is evaluated. Disabled registration still permits authenticated settings and unlink access.

Each transition has a stable request identity, expected predecessor, monotonic local revision and captured target. Denials occupy separately indexed child rows. A pending account or sender fence is installed in the same transaction as retirement and the transition record. Remote failure keeps that local fence and the original denial. Completion clears only fences belonging to that operation after every denial acknowledgement has been persisted. A malformed operation or child holds recovery for review.

Link creation checks both the sender fence and the destination account before and after awaited identity reads. Final grant commit checks the sender fence with the captured counters. A different transition cannot overwrite an existing sender operation.

Unlink uses the existing account session, Origin and CSRF checks. The connection projection includes `grantId` and the retained `unlinkOperation`. DELETE takes `operationId` and `expectedGrantId`. The client keeps these values through uncertain responses and resumes the server operation after reload. Repeating a completed operation returns its retained result, including after a replacement grant is created. A new request with a stale expected predecessor fails.

An HTTP 409 carrying `telegram_unlink_predecessor_changed` ends the client's unstaged cached operation. A subsequent explicit action fetches fresh status and creates a new intent. Other failures retain the original operation and predecessor for retry.

Before a native delivery starts, the outbox captures the original grant and its local revision and pre-arms durable recovery. A blocking response atomically retires that captured grant, advances the existing link fences and stages its denial. A delayed response compares the capture with the current association. `/start` restores chat reachability while the old grant remains retired. A fresh link becomes available after denial recovery completes.

The internal shared-writer port consists of `beginAuthorityTransition`, bounded `appendAuthorizations` pages and `finishAuthorityTransition`. Page receipts bind the exact expected cursor and contents. An unsealed operation retains its fence while its admitted shared writer discovers every original authorization. `telegramAccountPort` requires a durable revision/pending-state reader and rechecks it after the awaited enabled check and binding reread.

The coordinator owns the backing account revision, public-results/off and withdrawal mutations, discovery ledger/index and in-flight operator-binding revision. The two trusted composition modules remain in coordinator custody. The factory's connected capability and runtime activation remain held through final composition, exact serial checks and independent review. Login origin, registration, provider resources and physical-device acceptance retain their separate gates.

The regression source in this handback covers the signed denial transport, lost acknowledgements, persisted restarts, replacement grants, late delivery callbacks, stable HTTP/client retries, paged discovery and readiness recovery. Execution is queued for the coordinator. This handback contains no test, typecheck, build, browser or live-provider result.
