# Broker status and guarded fixture repair

The source base is `35028729436f90e9137003f4e5c89c96bcec1ed1`. Protected fixture
proposals target exact current combined
`241b577c3b71e09c0cf988e6db58a2498fc75d4d`. The earlier production D1 guard
wiring is retained; this delta supplies no new runtime or connected marker.

`TelegramLinking.create` reserves a transaction and consumes its navigation
reference before the broker opens. The actual broker can reject its configured
server client with `403 telegram_broker_client_required`. The broker client
forwards that status and code; the community start handler returns the same
reserved transaction ID. That failure does not prove the learner's community
session, browser binding or reservation invalid.

The client now terminates pending start identity only for proven community
session/CSRF/account/browser/authority error codes or a lost client context.
HTTP status alone cannot terminate it. A validated same-original transaction
ID remains resumable through a broker error or lost acknowledgement. A new
reference, foreign/malformed/ambiguous ID, automatic retry or new reservation
is never substituted. Existing account/generation/cancellation fences around
headers, delayed body, errors and acknowledgement remain. The retained definite
failure cases using `telegram_session_required` at every status are unchanged.

New unrun client cases distinguish broker 403 from community-session 403 and
cover initial/retry IDs, lost acknowledgements, malformed/foreign/ambiguous
metadata and changed accounts/generation/logout/cancellation. The HTTP cases
construct the actual broker routes, broker adapter, linking service, community
handler and real account/session fixture. Only failed transport and test-only
broker configuration are simulated. No OIDC provider is contacted. These cases
require the coordinator's clock-aligned successor of the pinned connected
fixture; they never bypass production expiry or invent an authenticated session.

The protected positive pagination test previously called a fixture with no
required D1 validator. Its guard correctly refused authority delivery. The
new exact proposals make that fixture derive the real shared validator from
an explicitly supplied D1. Scope/unlink-only fixtures without that DB remain
unable to authorize authority delivery. No allow callback is supplied.

The positive case now uses the existing shared revalidation fixture, canonical
migration18, actual account reader, signed retained V4 originals, current grant
and matching authority operation. Its explicit page persistence records retained
fixture state; it implements no authority policy or validator. The actual shared
validator checks signatures, membership, credential revisions and original
operation at dispatch and completion, including recreation. Canonical local
closure still runs through `beginAuthorityAction` before transition staging.

All duplicate-page, conflicting-page, unsealed completion, bounded recovery and
66 unique receipt assertions are retained. Controlled fixture clock advancement
allows retry deadlines and bounded validation pagination to progress. New cases
also prove that an absent guard or changed credential cannot deliver and that
the same operation completes through the real validator after valid binding
recovery. Signed operator request verification remains actual; only transport
receipts use the retained fixture.

Every new case is unrun. Only pinned Prettier 3.6.2 and `git diff --check` run in
this source turn. Current W1's reported root/web passes and 95 Dance plus 42
Telegram client passes are predecessor evidence. Its eleven factory/native cases
failed setup under the frozen chain clock versus actual cookie expiry. Clock
alignment, explicit `node:*` external/nodejs_compat and actual alarm500 diagnosis
remain coordinator work. The four connected factory/DO/alarm/Study fixture files
are unchanged here, as are all earlier sealed packets and core guards.

The coordinator must apply the exact fixture proposals, run the queued pure
client and memory/SQL cases, then qualify real-handler cases against the fixed
combined fixture in its serial slot. Source checks do not need live broker
registration. Runtime/origin/bindings/provider/device/phone acceptance remains
held; no broker selection, endpoint, account action, credential, resource,
deployment or financial action is supplied. The old centralized phone bot
establishes no decentralized acceptance.

Provenance is the pinned broker/client/HTTP/linking producers, shared
revalidation and managed fixtures, canonical authority validation/schema and
the retained positive pagination case. Shared files were read from immutable
Git objects. Protected changes exist only as before/after-pinned proposals.
