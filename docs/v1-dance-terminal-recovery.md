# Bounded terminal recovery successor

The source base is `e64ffb4cfca90314e21eba88b13b3cf1d589cd60`.
The original exclusive source identity and worktree remain. This successor
repairs the two independent P2 traces in the exact six-finding successor
review. Existing tests, stories, prior packets, capture lease, original machine,
capture binding, private preview and header-time denial surfaces are unchanged.

The source interface is `pirate.dance-command-outcome/1`. A real authenticated
HTTP `410 dance_capture_expired` stores an outcome on the exact immutable
command entry. Its UUID, account/community, path, body, request bytes and target
remain unchanged. The journal atomically records the outcome/history/latest
and clears only that active command. It preserves accepted capture pointers.
No local clock, malformed response, other 410 code, transport failure or auth
refusal may produce that fact. No chain evidence or accepted submission receipt
is fabricated from an expiry response.

Both direct submission and recovery reconcile that durable fact to the exact
matching capture/media/digest journey. A stored outcome can be replayed locally
as the same typed error, without another POST. If the outcome transaction rolls
back, the original remains active and uncertain: only a deliberate retry of
the same UUID/bytes can obtain an authoritative outcome again. If the outcome
commits but its acknowledgement or subsequent journey write is lost, reload
recovers the outcome by original UUID and repeats the journey projection
without dispatch. The same principle prevents a rejected capture reservation
from becoming a new permanent uncertainty. Missing legacy preimages remain held.
An existing legacy submission keeps its original pre-metadata shape: its outcome
stays in the command journal while the exact matching journey becomes terminal.
No target or serialized-request field is manufactured to fit the newer codec.

Known terminal expiry is distinct from an unknown command when preparation
checks terminal cleanup. The outcome and original preimage survive cleanup in
history/archive. The next attempt remains a deliberate existing source gesture;
observing, preparing or loading a page never creates a replacement or POST.

Local cleanup now asks the journal to clean the requested capture identity
while preserving a different accepted capture. It does not combine B's command
UUID with A's capture ID. The atomic transaction rejects any active original
and malformed/cross-account pointer, archives only A's related facts and leaves
B's accepted/latest pointer untouched. The existing strict command-ID plus
capture-ID retirement guard is retained for `releaseCompletedCapture`.

Thus, after safely completing A, completing B and returning to A, the existing
Record again flow can close A locally. Its later deliberate Start must still
read B freshly, verify its exact safe canonical DTO through the held producer
contract, and pass the atomic no-active/expected-pointer retirement guard.
Neither A cleanup nor read-only preparation implicitly retires or replays B.
Current canonical/source/ABI trust remains a coordinator integration gate.

All cases are prepared and UNRUN. The new Node cases use the real client,
journal operations, codec and controllers over named simulated transaction,
HTTP and authority boundaries. The new native harness function uses actual
IndexedDB/Web Locks, with explicit before/after real outcome and journey write
interruptions and intercepted HTTP; it has not been imported or executed here.
Existing assertions and test globs were not changed.

The coordinator must select only this exact frontend delta. In particular,
`capture-lease.ts` is absent from the delta; W1's separately qualified type
completion refinement at `241b577c3b71e09c0cf988e6db58a2498fc75d4d`
(SHA256 `9ded89233a7cf62ace009f58238aae0175a8d31883cb6f37f3992274a68ba9ed`)
must survive. No whole held backend join is allowed.

Page qualification must exercise Resume after an unaccepted submission's
authoritative expiry, Back, the existing terminal Record again, and a fresh
deliberate Start. Existing review loading may report the typed expiry through
its error path; any additional expiry-specific page copy must be a separately
pinned coordinator proposal, never a fabricated receipt or permission bypass.
Native harness composition, actual owner account/capture-context/private bytes,
canonical authority, rendered source parity, full gates, CI and release remain
held. No provider, device, public posting, funds or live activation occurred.
