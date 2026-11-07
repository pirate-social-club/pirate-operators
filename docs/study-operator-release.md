# Retained testnet operator upgrade

The operator release keeps the physical `pirate-learning-testnet-v2` stack,
testnet stage, `Operator` resource and its existing `STATE` and `SPEECH_BUDGET`
namespaces. Only the reviewed operator module, V3 profile and additional V3
contract binding change. V2 recovery, quote timestamps, thirty-day retention,
usage counting, zero speech quota, sponsor spending/reservations and the native
lifetime ceiling remain in their existing storage.

`node harness/study-operator-release.ts --profile PUBLIC_PROFILE.json` validates
public metadata and prints a plan. It reads no credentials or private journal,
creates no execution state and makes no request. The profile fixes source and
artifact hashes, both contract targets, physical identities, existing encrypted
state hashes, quote bytes, limits, custody and a window of at most fifteen
minutes. The source compiler hashes both runtime and release-control graphs.
No live profile or credential value is checked into the repository.

Explicit remote modes use `node --experimental-transform-types` with the same
entrypoint. `--preflight` performs read-only chain, cloud and private-state
qualification. It uses existing managed Cloudflare and Infisical access; there
is no credential creation or rotation. Current contract identity and graders
must pass before cloud credential access. The original encrypted Alchemy state
is authenticated, rather than adopting resources by name.

First prepare a reviewed profile with both plan-review fields set to null.
`--cloud-plan --expected-profile HASH` repeats source, contract, identity,
custody, runtime and window checks, preserves the predecessor, materializes the
exact package and loads the existing runtime secrets in memory. It invokes only
the pinned Alchemy `plan` command, with the original state directory, explicit
testnet stage, disabled dotenv discovery and no interactive input. It saves
private redacted output and a receipt binding command, package and scope.

An independent reviewer checks that actual plan for one Worker update and no
new Worker, namespace change, migration, deletion or transfer. The final profile
pins that review and its raw plan receipt. These review fields change the
profile hash while preserving the reviewed operation scope. The final profile
still needs fresh inventory and an open execution window.

`--execute --expected-profile HASH` requires the completed plan review. It
preserves original encrypted state, quote and source bytes before runtime
secrets, records dispatch durably before the single bounded Alchemy child, and
rechecks the exact package at the child boundary. Secrets are passed only in an
explicit environment and never printed. Diagnostics are bounded, redacted and
encrypted. The shared physical operator lock excludes concurrent executions.

A dispatched, unknown or completed result only reconciles the exact successor;
it cannot automatically repeat an apply. Keep the source, original package,
backup, journal and lock evidence after any interruption. A stale process lock
requires a separately reviewed disposition after confirming the former process
has ended. Do not remove a lock merely to make a retry pass.

Readiness checks classify actual D1 wallet pointers against operator terminal
records and canonical public commitments. Latest/pending signer counts must
agree with fresh inventory. Native journals include ordinary transaction rows
and controller deployment/correction records; raw signatures, chain, nonce and
canonical settled receipts are checked. Allocated intents without transactions,
unknown keys, unsigned/prepared records and unexplained current nonces refuse.
The retained scalar `op:nonce` and `run:profile` shapes remain readable.

Storage preservation may use authenticated before/after exports or an explicit
independent same-namespace retention proof bound to the exact source graph,
artifact and identities. The latter does not claim that opaque live row values
were exported or compared. It does not replace native inventory, custody,
active-take checks or actual post-update identity verification.

The contract, operator, application, migrations and history-aware readers must
be compatible before the directory changes. This command never switches the
directory, enrolls a learner, starts speech, funds rewards or permits mainnet.
Deployed V2 readability, real Study acceptance and measured costs remain release
gates after source qualification.

The operator's five reviewed public package files stay unchanged, with
`operator.mjs` in the package directory. The dependency link belongs in the
release directory above that package. The pinned Prebuilt reader recursively
selects modules beneath the entry's directory; a package-local dependency link
previously selected 8198 files rather than one. Before operator signing-key or
speech-credential loading and again at child dispatch, the maintained guard
rejects extra paths, directories and symlinks, qualifies ancestor import
resolution, and runs the actual pinned reader. Its result must be exactly one
`operator.mjs` with the reviewed bytes and digest. The raw plan receipt binds
that closure, and final plan review requires it.

The runtime compiler preserves symlinks so governed dependency-link layouts do
not change its module-path labels or generated factory names. Independent
root/tools builds with this option were byte-identical to the retained
991561-byte runtime. This accepts exact bytes, not an assumption that different
compiler output is semantically equivalent. The provider integration tests run
against the retained SDK, or the same project SDK when available in CI. A
root-only CI job without that SDK explicitly skips those nine provider cases;
the local release gate must run them without skips. Real cipher/state cases
remain ordinary CI coverage.

A fresh reviewed profile may authenticate an interrupted `updating` snapshot
only when its exact ciphertext is pinned, the top-level Worker identity is
owned, both current and old attributes identify the same physical account/tag/
name, and both desired names retain the fixed target. Optional old metadata
must agree when present; creating, replacing, deleting, foreign or local-mode
state is refused. Authentication never rewrites or rolls back state. Original
unknown execution records, packages and backups remain retained. An old unknown
attempt still follows reconcile-only handling; this state-reader repair does
not authorize its replay. A new exact source/profile, actual plan, independent
review, fresh inventory and finite custody are required for a separate bounded
reconciliation.

A repeated V3 repair must explicitly set predecessor.resultsVersion to3 and pin
its current module and encrypted state. Historical profiles without that field
continue to require the original V2 bindings. The cloud observer accepts only
the exact predecessor or successor module; a V3 predecessor must already expose
the selected V3 contract, while a V2 predecessor must have no V3 binding. This
field does not infer consent, migrate state or permit an unreviewed target.

The later live Study fetch repair changes that reviewed runtime by one literal
only, to991562bytes at6fa28d54. The earlier991561/EA checkpoint and its closed
release records remain historical. The current actual-reader regression pins
the successor's exact module bytes and still rejects the oversized default glob.
