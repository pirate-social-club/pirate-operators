# Bounded V3 contract preparation

This command prepares the five operations needed before the retained operator and
application can use LearningResultsV3. It does not activate a directory revision,
change a Worker, create credentials or authorize a funded run. The coordinator
must review a fresh exact profile and retain exclusive controller custody before
explicit execution. Mainnet is refused.

## Public plan

From the repository root, run:

```sh
node harness/megaeth/study-deployment.ts --profile /absolute/reviewed-public-profile.json
```

The default reads public local source and the supplied profile, compiles V3 in
memory, and prints a deterministic plan. It creates no RPC client, reads no
private inventory or key, writes no execution journal and allocates no nonce.
The nonce numbers are supplied review inputs, not reservations or observations.
Unknown fields, changed source/artifacts/disclosure, an invalid CREATE address,
changed policy bytes, nonpositive bounds and windows longer than fifteen minutes
are refused. The exact UTC timestamps must use ISO format.

The artifact binds compiler/settings, creation bytecode, runtime template and
immutable-reference positions. It also binds the executable's complete static
local source graph and package/lockfiles. Regenerate the reviewed profile after
combined source or disclosure changes. An old profile cannot silently select a
new execution tool. The compiler writes no `.local/artifacts` output.

The profile type and validator are in study-deployment-plan.ts. It fixes the
community, controller, directory/registry/revision and retained V2 code identity,
the expected CREATE address, current V3 disclosure, one grader, five gas bounds,
per-operation data-fee reserve, gas-price ceiling, aggregate maximum, finite UTC
window, and reviewed legacy inventory/custody records. It selects prospective
periods and the exact public policy CIDs and SHA-256 digests for each activity.
The public plan includes the policy documents for a separately reviewed pinning
operation. This command does not create pins or load pinning credentials.

The only possible operations, at five fixed consecutive nonces, are V3 CREATE,
enabling the Karaoke grader, enabling the Study grader, activating the Karaoke
policy and activating the Study policy. Both policy documents are locally derived
from the accepted scoring/qualification rules. No arbitrary call, token transfer,
controller change or directory write can be inserted into the sequence.

## Explicit observation and execution

`--observe` explicitly permits public testnet/IPFS reads and read-only inspection
of the reviewed private inventory and catalog. It creates no journal or key read.
`--status` checks recorded raw bytes and canonical receipts without sending or
requiring an open signing window. These modes do not claim exclusive custody.

Execution additionally requires `--execute`, `--expect-profile` matching the
printed profile hash, and `--key-file` naming the existing approved private
controller file. Its value is read only after all public/custody bounds and the
durable unsigned intent and registry marker have passed. The file must have
chainId 6343, a nonfixture private key and private regular-file custody. The signer
must equal the reviewed controller. Key values are never printed.

All participating commands use the original fixed signer directory
`~/.local/state/pirate-controller/6343/<controller>/`. The existing
`dispatch-custody.sqlite` OS lease and `controller:profiles` catalog serialize
corrections and deployment operations together. Typed deployment records use the
`deployment` record key in per-operation SQLite files; legacy correction entries
retain the `correction` key and missing-key default. No second signer namespace
is introduced. The reviewed finite legacy inventory remains necessary because
older commands do not participate in this lock.

The order is register profile, persist the unsigned nonce/maximum charge, mark
preparation durably in the shared registry, load/sign, persist exact raw bytes and
hash, repeat current public/custody/window checks, then broadcast. A timeout keeps
the original raw bytes and conservative charge. A matching pending transaction
is observed without another signature. Only the same bytes may be retransmitted
when canonical nonce/state checks prove that path is still valid. There are no
fee bumps, replacement nonce allocations or automatic refunds. An unknown,
confirming or reverted operation stops the sequence before the next operation.

Resume first checks canonical status for the completed prefix and audits shared
custody at the current unsettled operation, rather than treating a later pending
operation in the same plan as an unrelated blocker. Status and completed runs
also audit the current or final boundary. Unrelated unresolved profiles, missing
prepared journals, orphaned files and noncanonical prior receipts still refuse.

Receipts need twelve-block depth and canonical block rechecks. A canonical revert
consumes its nonce and remains in the catalog, but never counts as successful
setup. A lost or incomplete catalog cannot hide a surviving journal or lock.
Prepared unsigned operations are retained and fail closed; this tool does not
automatically retire them or reuse their nonces after a window expires. Preserve
the reviewed source checkout and original journals while any outcome is unknown.
A changed tool or recovery disposition requires a separate exact review.

## Local qualification and release boundary

Focused tests use simulated public RPC/IPFS with real codecs, signatures and
private SQLite. The local Anvil case executes actual V3 constructor, both grader
calls and both policy activations. Only predecessor-directory/V2 identity, IPFS
transport and the data-fee oracle are simulated in that case. These proofs do not
establish public deployment, managed credential access or full provider liveness.
All tests run in a loopback-only network namespace.

After accepted execution, preserve the exact contract and code hash and refresh
the Study release selection. The coordinator still owns the retained operator
upgrade, app/migrations/history-reader deployment, V2 recovery verification and
only then directory activation. Native spending, provider usage, namespaces,
existing grants and journals must remain preserved. No directory or service
activation follows merely from a successful contract setup.
