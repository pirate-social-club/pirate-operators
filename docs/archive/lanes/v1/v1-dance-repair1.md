# Dance repair1 implementation contract

The preserved predecessor is f362f68e0a1612b80f63cd42bee43e6f89fada3a.
All eight exact-source findings, the complete interface review, V4 protocol
review and V5 packet were read. dance-admission-contract-v5.json is the LOCAL
semantic contract. Final Solidity/ABI/keccak agreement, verified reader/source
admission, shared mounts and any live activation remain coordinator gates.

D1 decisions are immutable decision intents plus outbox records, never final
verdicts or reward times. The family is pirate.dance-verdict/1 with pass or
not_passed and no score. One submission owns one intent. Unknown dispatch,
withdrawal and reorg preserve the same command/body; HTTP recovery still checks
current private access. Canonical transaction order decides already-broadcast
verdict/control races. D1 grants and revokes project pending canonical acceptance.

The server persists the prospective capture IDs, original authorization,
account/wallet/known-alias epochs, community, exact song/manifest/audio, rules,
rubric/media policy, selected reference/interval, optional offer/source and
reservedAtMs FIRST. It then stores separate immutable consent for the exact
captureHash. reservedAtMs <= consent.acceptedAtMs <= trustedSubmittedAtMs;
camera/file acceptance starts only after that authenticated receipt returns.
Ordinary sign-in can leave the original authorization valid. Revoke/reauthorize
cannot substitute a new authorization into an old capture.

The media binding is acyclic: mediaBindingHash includes source domain,
captureHash, mediaId commitment, expected ready revision+1 and recording digest.
It excludes final submission hash, receipt, submission time and deadline.
Source3's prepareMediaSubmission before/after halves surround the actual Dance
submission row and command receipt in ONE D1 batch. Dance selects the original
trustedSubmittedAtMs, deadline and post-retention revision from that receipt.
A lost response recovers the same receipt, then constructs one held submission
outbox from immutable facts. It never extends retention or changes identity.

The exact exclusive deadline is trustedSubmittedAtMs + 604800000. Neither
reservation nor upload/readiness starts review. Private media must remain
access-controlled through that deadline unless explicitly withdrawn/failed.
Private access refuses at the deadline. Pending withdrawal sets local denial
with its intent and stops unsent dispatch, without claiming canonical success.

Wire absence is field-specific: no offer zeros every other Offer field, including
times. No reference zeros identifiers/revision/epoch while retaining interval.
startSample=0 is valid; duration is 6–30s at 48kHz with checked song coverage.
offerIdCommitment hashes the exact original validated ASCII offer ID through
the root ABI adapter. inputHash remains the existing frozen offerInput SHA-256;
it is never replaced with a new Dance ABI hash.

Complete V5 tuple order and field types are exported in wire-proposal.ts and
wire-types.ts. Owner/configuration/reviewer-role/rules/media/identity/group
expectations are sealed before dispatch; a publisher cannot refresh stale
epochs while dispatching. D1 media generation and chain media epoch are distinct.
The coordinator owns final operation encoding, nonces and chain execution.

One typed DecisionIntentPreimage is serialized and integrity-hashed identically
by helper, store and outbox. This local JSON SHA-256 is expressly NOT the proposed
ABI/keccak commitment. Canonical event evidence is separate, with transaction,
block, transaction/log indices and latest/safe/orphan status. The application
receives no chain proof until the root supplies its actual receipt/log/block/code
verifier. A typed fixture marker does not constitute that evidence.

The proposed reward reader converts validated canonical block timestamp seconds
ONCE, with safe-integer checks, then compares opening-inclusive/cutoff-exclusive
millisecond boundaries directly. Safe head must reach cutoff before closure.
Pre-cutoff events confirmed later stay eligible; late passes remain visible
without a reward. Historical acceptance uses transaction position, not current
end-of-block roles. Later private withdrawal does not rewrite accepted history.

All activities join before the one earliest account/offer reducer, retaining
wallet-conflict refusal and deterministic evidence-hash ties. Closure snapshots
must persist cutoff block/hash, exact source/policy context and captured account/
wallet commitments atomically with entries. Root must replace current-credential
lookup for historical Dance bindings and revalidate before unpaid settlement.
A mismatch holds settlement without replacing entries or replaying paid
obligations. closure-contract.ts specifies this boundary, not a live mount.

Reviewer exclusion compares account, normalized wallet, known-group and alias
labels. Singleton labels identify known accounts, not unique humans; unknown
cross-wallet human equivalence remains unproven. Current owner plus stored grant
can stage revocation even if the target is inactive. Access and fresh dispatch
recheck authority. Canonical operations remain pending until verified.

Queue scanning skips/reports individually inaccessible, revoked, expired or
failed-media rows and advances from the last scanned row. A bounded empty page
retains continuation, so invalid rows cannot permanently starve valid rows.

The browser atomically journals exact command/body before dispatch in IndexedDB.
Reload recovers the original command before different/opposite mutation, and
accepted-subject receipts prevent retargeting. Definite canceled/expired capture
may reset; uncertain accepted submission remains pinned. No session/CSRF token,
media bytes or playback URL is written to that journal. Learner 401/403 clears
private capture, take, result and media state while preserving command recovery.

Capture and take preview consume source3's actual pure Solid surfaces through
pirate.dance-surfaces/1. Recording does not auto-submit. Submit for review is an
explicit action after a playable take preview. Moderator render branches are
independently adopted from pinned centralized pure Solid owner review, including
reference playback, frozen rubric/interval and inspection copy. Exact source
and adapter mapping is in v1-dance-ui-provenance.json. No centralized session,
persona, API or runtime dependency is imported.

The stable producer is 7949d9cf80a63c7e3a4e2c4220c1c1fb2b171ac7, preserved in
packet preserved-handbacks/lane3-repair3. The consumer injects its actual
projectDanceMedia/projectDanceSubmission and repository-bound submission plan.
Root MUST call Dance.inspect for EVERY private GET/HEAD/range, uploader too,
before serving existing media bytes. That final local batch rechecks current
revision, denial and deadline. Direct media routing remains held until mounted.

Both existing capture/review surfaces show the proposed versioned disclosure:
permanent submission metadata, authorization references, selections and known
alias linkage can remain public even without a verdict or after withdrawal.
Reviewer action sends the displayed consent version and stores the publicity
policy in its immutable intent. Final terms admission is held; there is no new
full-screen ceremony or per-verdict wallet signature.

This repair runs only pure memory/unit tests, formatting and typechecks.
D1/Worker/browser/chain execution, actual combined media-plan tests and full
repository gates are deferred through .local/check-request-dance-repair1.json.
No final canonical support or runtime acceptance is claimed.
