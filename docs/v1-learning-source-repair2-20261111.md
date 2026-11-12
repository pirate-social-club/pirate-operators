# Learning source repair 2

Base: `1ff2d5ea26d6e91190b300d5484c9725122490cc`. The exact independent
account-fence review closes the previous three findings and identifies the two
issues addressed here. All new source and proposed regressions are **unrun**.
The earlier 101 Node, 71 component and two D1 cases remain dated evidence.

## Ticket producer boundary

The trace follows the actual `karaokeTicket`, `openTicket`, `D1Store.update`,
`ensureTicket`, application error serialization and authentication guards.
`D1Store.update` writes the wallet reservation, usage and sequence before reading
the write acknowledgement. `karaokeTicket` converts any exception from that call
into a structured409. A committed write whose acknowledgement fails therefore
looks like a client conflict. Even a familiar guard message is not proof:
the same untyped Error channel carries storage failures. Authorization errors
can also occur in `ensureTicket` after reservation.

The owned HTTP adapter now recognizes only the current producer's demonstrated
pre-handler401/session-required and403/host-Origin-site-CSRF refusals for a
ticket POST. Generic structured409,429 and other endpoint errors remain
uncertain. The ticket adapter independently checks this producer boundary, so
an incorrectly labeled endpoint-refusal409 at its injected transport seam
cannot release the hold. A real preflight that did not dispatch can still be
retried deliberately. No refusal triggers an automatic replacement create.

Empty or finished observations cannot erase an unknown create. Positive
authoritative recovery returns the existing reservation/ticket identity. There
is no audio replay, new request identity, inferred success, provider call,
reservation refund or change to sponsorship, credit or budget logic here.

Current recovery can require backend reconciliation: a CAS may have stored the
reservation before any signed ticket row existed. The packet supplies exact
protected proposals to classify ambiguous storage failures as503 and to rebuild
only an authenticated, unexpired existing reservation during read recovery.
Neither proposal is applied. A typed synchronous precommit guard/wire protocol
would require separate producer review; no new marker is implemented or trusted.

## Captured V3 enrollment intent

The protected legacy Study caller currently omits its expected-account header
on both V3 enrollment calls. Its new exact proposal imports the owned
`enrollStudyForAccount` helper. The helper captures the account once, sends that
same header through both actual `post()` calls, and checks the account/lifetime
before and after the MOSS signing prompt. It keeps the existing enrollment
controller, disclosure validation and signature port.

CSRF remains read at each request exactly as the existing caller did. The
transport still uses same-origin credentials and the browser's ordinary Origin
behavior. The expected-account header only compares identity; it cannot replace
the cookie, CSRF, Origin or learner signature. The legacy proposal preserves its
existing onCleanup/null history-action clearing. The legacy file, mandatory
server account fence and current authentication regression witnesses are not
edited by this lane. Default source page mounts remain coordinator-held.

## Prepared witnesses and exact proposals

New frontend cases cover delayed structured409 after a simulated reservation
commit, empty/finished observations, original-identity recovery, familiar409
messages, a false endpoint-refusal stage, and the producer's actual pre-handler
401/403 vocabulary. The existing delayed body and post-session cases remain.
Enrollment cases use the actual owned helper, existing `post()` and enrollment
controller to inspect both requests and account/disposal changes during signing.

The protected actual-handler proposals go further. One appends a real-D1 case
to the existing authorization fixture: it commits the real wallet CAS, delays
and rejects its acknowledgement, invokes the real ticket producer, and checks
that the frontend never repeats the POST through none/finished observations.
Explicit backend reconciliation must recover the original reservation with
unchanged sequence/usage. This is a current409 producer witness and must run
before considering the optional503 response proposal. Adopting that backend
proposal requires a separately reviewed expectation update while retaining
every reservation/identity/POST assertion.

The other proposal appends calls through the actual `communityFetch` and D1
session fence. Both enrollment requests must carry the captured account and
reach their actual handler. Removing the second header must fail before operator
work. Actual ticket pre-handler cookie/CSRF/Origin refusals are also exercised.
The existing two authentication cases and their assertions remain intact.
Operator enrollment/signature behavior is an explicit fixture boundary; these
cases do not qualify a provider or MOSS device.

Two earlier artificial refusal fixtures required explicit clarification. A raw
HTTP429 with a budget code now expects uncertainty, retaining its status/code
assertions and making the stage assertion stricter. The injected budget denial
fixture is explicitly pre-dispatch, retaining its original code/status/call
assertions; it no longer pretends to be a real ticket-endpoint refusal. Exact
original files are retained in the new packet's `original-witnesses` directory,
in addition to the immutable Git base and earlier sealed evidence. No original
controller, graph, capture or playback case is removed or relaxed.

The packet pins protected paths by exact1ff Git blob and SHA256. Proposed
patches, original witnesses, owned source, queued commands and earlier evidence
digests have a new manifest. No historical packet, dependency, lock, workflow,
vendor or harness is changed. Only pinned formatting and `git diff --check` are
permitted here; no test, typecheck, build, install, Storybook, browser or Forge
command was run.

The coordinator retains every gate, protected edit, source review, merge and
release decision. Actual default mounts and reactive URL/history/account/post/
lesson behavior, private history, media Range GET, signed socket proof,
desktop/mobile rendering and native microphone/provider qualification remain
open. Translation/configuration/availability and reward/day/streak/leaderboard/
grant sources remain denied. Graders, private publication, sponsorship, credit,
Telegram fencing and prospective activation remain protected and held.
