# Media source repair against 83209be

Base: `83209be8033599c0aad059c24815e0fa75d433dc`. The independent
`owner-ui-shell-media-source-review.final.txt` remains a held-source review,
not execution or rendered acceptance. This repair addresses media findings
1, 2, 4, 5, 6 and 7. Finding 3 belongs to the original shell actor and was not
changed here. No backend, shell, manifest, lockfile or prior evidence was edited.

## Withdrawal and uncertain authority

Withdrawal records `pending: withdraw` before recovery. A known reservation
goes directly to DELETE; withdrawal never resumes upload or processing. If its
reservation acknowledgement was lost, only the exact original reserve envelope
is replayed to recover the ID, followed by DELETE. The existing API has no
separate read-by-request-ID port. This identity-only replay may recover an empty
reservation under the same original identity; it never sends recording bytes or
creates a new request identity. No backend or API change is required/proposed.

An in-flight operation keeps its existing exclusive storage lock. Withdrawal
aborts its bytes, fences later effects, and serializes a durable delete marker
through that operation's write queue. Late canonical replies still persist, while
the marker survives until authoritative terminal state. A failed or ignored abort
does not trigger another PUT to withdraw. The queued DELETE waits for the older
operation to release its lock; if that operation never settles, the durable marker
remains available to the next owner/reload. No recording is discarded to bypass
an unresolved response.

`commandDispatched` is an additive optional witness on the existing version-1
attempt. `false` proves the current command has not crossed its first dispatch
fence; the controller persists `true` before sending it. Missing on an older
pending attempt is treated as uncertain. Only a definitive first-dispatch
refusal can clear pending and allow a no-reservation discard. A later refusal
cannot prove an earlier uncertain reservation did not commit. `rejection`, when
present alongside pending, names the latest refused wire attempt only.

401/403 persist an authentication hold and the original pending command, File,
request ID, intent bytes and digest. They do not prove the absence of an earlier
commit. Reauthentication uses the fresh CSRF getter and replays the same envelope.
An authentication hold disables automatic polling and keeps the established
explicit retry path. No new authentication provider or screen was added.

## Notification ownership and terminal recovery

Canonical replies persist even after pause/disposal/owner change. Each operation
captures a generation fence, checked after durable saves before both onChange
and onReady. Notifications also carry that generation predicate through the
VideoFlow microtask queue, so a pause between save and queued delivery fences
the old reactive write. `dispose()` invalidates the controller permanently. VideoFlow also
captures account/community identity and host callbacks; its lifetime gate fences
queued actor sends, ready delivery and asynchronous preview writes. Cleanup or
an identity change disposes that gate and the old controller/device owner. The
gate cannot revive after an observed identity switch back to the old identity.
These are callback lifetime guards, not another flow reducer or an auth bypass.

The existing copied video statechart and component composition remain in use.
A presentation projection exposes Start over for withdrawn/revoked/expired,
nonretryable failure, and pending withdrawal. A known terminal receipt permits
discard; exhausted processing requires remote withdrawal before discard. Unknown,
nonterminal or refused DELETE keeps the record, denies playback and blocks a new
attempt. Discard never replays upload bytes as a side effect. A retryable failure
retains the established resume/retry path. Media readiness is still not public
publication, and no Post ID or href is synthesized.

## Necessary text-machine safety departure

The exact original `.reference` witness is unchanged. The adopted machine's
conflict branch was unsafe for this transport contract: conflict explicitly
names a key bound to a different request hash. The machine now treats that
outcome as unconfirmed in its existing waiting/retry states. It never adopts
or reads the conflicting ID. The current read port supplies no proof binding
an arbitrary/legacy ID to the original envelope, so reconciliation dispatches
the original bytes/key exclusively, including when a legacy envelope contains
an ID. A normal successful dispatch remains the positive publication path.
Auth holds, pause/resume and original-envelope identity are retained.

This modifies the existing XState machine at its service outcome seam; it does
not replace its transitions with a handwritten reducer. The generic transport
read method remains compatible with existing consumers, but is not sufficient
proof for this machine. No proof-producing service was invented. A future
hash-bound read would require an explicit admitted producer contract and tests.

## Evidence and gates

`apps/web/test/media-source-repair.test.ts` prepares 24 bounded Node cases with
the actual media HTTP adapter, controller, callback lifetime helper and adopted
video/text machines. Explicit in-memory storage serializes the real controller's
exclusive work and records its persisted values; transport responses simulate
only the named local protocol subset. No provider or production success is
implied. Cases cover exact HTTP ordering, failed/late PUT, late GET, unknown and
auth-refused DELETE/reload, auth replay, current/obsolete host delivery, a save
crossing pause, foreign text publication and terminal recovery. Positive controls
exercise successful same-identity reconciliation and allowed recovery paths.

The unchanged strip-only `node --test` command imports `MediaHttpError`; its
constructor now has explicit readonly fields and assignments, with no parameter
properties. XState 5.33.2 and Mediabunny 1.55.5 remain coordinator-owned existing
dependencies; no dependency operation was performed.

These regressions have **not run**. No test, typecheck, build, browser, Storybook,
Forge, installation, network or provider action ran in this source turn. Only
pinned Prettier and `git diff --check` are permitted. Candidate mounting,
component rendering, responsive parity and all integration/runtime gates remain
with the coordinator. Prior passing nearby cases and original source copies do
not establish acceptance of these repairs.

Private Dance and its isolated authorization, retention and injected 6–30 second
profile are unchanged. Public clips remain independently 3–15 seconds; fresh
public posting remains denied. Canonical song/revision/audio digest/media binding
checks remain intact. Missing text/song/storage producers remain explicit ports;
none were replaced with no-op or fabricated runtime adapters.
