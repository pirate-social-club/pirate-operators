# Bounded factory and link-start repair

This source delta starts at `936688a0640c8ae4c0f318c2d21ad766d404c7f6` and
targets the reviewed shared composition at
`7ea65581928507a585e80555f096ec9f547251c2`. The shared authority ledger,
validation, schema, migration and guarded lifecycle are available in W1. Source
composition and qualification do not depend on visual parity. This work runs
no tests, types, builds, browser, provider or device checks.

The factory now derives `validateManagedAuthorityDelivery(db, request)` from
its actual D1 and excludes an authority-validation override from its input.
The exact protected constructor proposal forwards this callback into the
existing guarded lifecycle. That reviewed class still validates immediately
before signed remote dispatch and before transition completion, including
independent recovery. The proposal ports only the missing full-target assertion
into that class; it never replaces guarded 7ea with the older W8 class.

The client retains a validated server transaction ID returned with a resumable
start error. `retryStart()` submits that same ID explicitly. A lost retry
acknowledgement retains the original identity; starting again from the consumed
reference is blocked. Malformed IDs and mismatched retry IDs cannot replace it.
Definite authentication, missing-transaction and expiry errors invalidate the
local pending ID. Unknown initial transport without a delivered ID remains an
unknown intent; the client does not guess or automatically reserve another one.

`telegramConnectionClient` now requires the existing auth/route owner's
monotonic `generation()` as well as `account()` and `csrf()`. The generation
must change on logout, account and route changes, including an A-to-B-to-A
switch between awaits. The account/generation/cancellation fence is checked
before requests, after headers and after body delivery or failure. Completion
uses one captured context across inspection, POST and URL acknowledgement.
`pendingStart()` exposes memory-only retry state. `cancel()` clears local
pending operations and fences in-flight results; it adds no server endpoint or
remote rollback. Auth state is never stored in localStorage.

The phase packet contains exact before/after blob and SHA pins, protected core
and legacy adapter/call-site proposals, and a concrete mount proposal. The
retained linked/frozen proposals are unchanged and rebased against their actual
7ea blobs. Legacy fixtures acquire the actual lifecycle, same-reference context
and required frozen argument. Marker-only rejection becomes missing/foreign
lifecycle rejection; grading, privacy, original-request and channel assertions
remain. Existing client fixtures receive explicit unchanged generations, while
the new regressions exercise generation changes and delayed responses.

The optional mount proposal uses the existing same-origin community login,
session, CSRF and Telegram routes. Full-page connect/return requests stay in the
website shell; read-only JSON inspection precedes authenticated completion.
The shell mount must preserve callback state until acknowledgement and dispose
the controller on account/logout/cancel/route changes. The separately registered
login-origin broker keeps its own browser, nonce, state, PKCE and return binding.
No live origin is selected; `connect.pirate.sc` remains unselected.

The proposed mount retains `communityScheduled(env, dependencies)` with the
actual `linkedAuthority` ports and independently forwards native alarm work.
The pair has no ordinary readiness precondition. Shared dirty/outbox recovery
and canonical local closure are preserved before remote invalidation. The
returned publication-authority handler belongs only on the existing internal
operator binding. The native DO supplies its actual storage and forwards its
alarm event; the earliest-deadline scheduler remains unchanged.

Unrun regressions cover the actual factory, D1 account/session and authority
tables, canonical closure/recovery, SQLite journal, signed operator handlers,
unavailable guard, restart and delayed guard/epoch change. Actual HTTP start
tests reproduce server reservation followed by broker failure and a lost retry
acknowledgement. Client cases cover malformed/foreign IDs, authentication
errors, cancellation, delayed body and account/generation changes. Existing
native DO/alarm cases remain queued with all assertions retained. Fixture
provider transports are explicit; they supply no fake authority or replacement
private Study implementation. Automatic native alarm delivery and the final
combined mounted journey remain runtime qualifiers, not source claims.

The coordinator must compose the exact source/proposals, run root/web types and
the queued single-worker handler/SQL/DO/alarm suites, obtain independent exact
review, and then qualify the admitted runtime and bindings. Real enablement,
personal/catalog/broker/media/delivery/provider ports remain required inputs.
No connected marker, bot selection, activation, credentials, resource, domain,
funds or deployment action is supplied. The old centralized staging phone
trial is not acceptance of this backend.

Provenance is the exact W8 factory/client source, retained factory packet and
reviewed 7ea authority/constructor/schema producers. Tests extend the existing
Telegram SQL, V4 Study, native DO and account-switch fixtures. Shared code was
read through immutable Git objects, never imported from another worktree.
