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
