# Required CI and compiler reuse

This continuation of PR53 closes the main-branch enforcement gap and removes
repeated identical Solidity work. The earlier audit, 39 test removals, 17 dead
production lines and 100-run timing sample remain under
../ci-test-audit-20261113/. No additional existing test is removed or weakened.

## One required gate

CI is the sole automatic PR/main caller. It invokes Local, Web, Study, Karaoke,
Wizard and Creator through local reusable workflow paths at the same revision.
Each suite remains manually dispatchable for diagnostics. Only the caller owns
concurrency, so reusable suites cannot cancel one another. Feature pushes do
not duplicate PR verification.

All six suites run for every PR. This intentionally avoids a second dependency
classifier or asynchronous joins between path-filtered workflows. The fixed
release-ready job always runs after the six boundaries and accepts only six
success results. Failure, cancellation, skipping or missing results fail the
gate. Contents permission remains read-only, and no secrets are inherited.

The actual gate shell was executed against 37 result vectors: all-success and
six unsuccessful states substituted at each of six boundaries. Only the
all-success vector exited zero. gate-proof.json retains the outcomes. Actionlint
also validates the caller and all reusable workflows. The root shard explicitly
requires a nonempty JUnit XML before upload; its optional compiler receipt
cannot substitute for the mandatory test report.

.github/main-ruleset.json is the reviewed desired settings payload, not an
activation receipt. It targets main only, requires a PR and current-base
release-ready from observed GitHub Actions integration 15368, permits no bypass
actors, and blocks deletion and force pushes. Zero human approvals preserve the
workspace's independently reviewed coordinator merge flow. Ordinary merge,
squash and rebase methods remain permitted; this task uses an ordinary PR merge.

The transition order is exact-head PR verification, settings snapshot, ruleset
activation/readback, fresh base/head eligibility check and expected-head GitHub
merge. Do not require a nonexistent gate before its first PR run. Manual runs
do not replace that PR qualification. The task record and PR retain activation,
merge and hosted outcomes, which cannot be established by a checked-in payload.

## Compiler behavior and timing

compile() retains one process-local successful artifact serialization. Every
invocation rereads all eleven sources and builds the complete standard-JSON
compiler input before matching it together with solc.version(). A caller receives
a new parsed artifact map each time, so nested ABI or bytecode edits cannot
poison later calls. Compiler/read errors propagate. The normal artifact directory
and JSON file are still written on every invocation.

No persistent cache is read. Each manual deployment and each independent
acceptance process still compiles fresh. There is no test-only switch, reset
export or alternate compiler entrypoint. The existing shared artifact write race
is not changed; current consumers use the returned objects, not that file as a
cache. This change does not introduce a disk-cache trust path.

compiler-plan.md recorded failure modes and real probes before implementation.
The new single integration case uses actual solc, the filesystem and Anvil. It
mutates returned ABI/bytecode, recreates missing output, changes the fixture
contract from six to seven decimals while preserving byte length and an exact
fixed mtime, and deploys/readbacks both results. It also rejects syntactically
invalid and missing inputs and recovers the valid input. It has no compiler mock,
cache-hit assertion or production test seam. Its repeatable receipt is uploaded
with the owning shard's JUnit report.

| Workstation measurement                         |            Before |          After |
| ----------------------------------------------- | ----------------: | -------------: |
| Seven identical compilations in one new process |           46.698s |         7.276s |
| Cold compile in that process                    |            6.812s |         7.267s |
| Later identical calls                           | 6.436–6.876s each | 1.0–3.0ms each |

The complete artifact digest is identical in both runs:
a40eb781897d97018f51f2ce5e499d1007c41bc340e2bf9842e1fa6b060c1632.
The measurement is one paired workstation sample on Node24.14.0, not a CI
forecast. compiler-before.json and compiler-after.json retain every duration
and helper digest. The initial real deployment probe passed before implementation
in 38.5s and after implementation in 15.2s; the later timestamp/cleanup review
improvements are covered by the final full gate.

The new integration case protects credible stale-bytecode, caller-poisoning,
error-suppression and missing-artifact regressions that a static ABI check or
ordinary successful browser journey would miss. Its failure modes are public
compiler/harness contracts; it does not protect a private cache layout.

## Further measurement

The previous four shard jobs took 7m30s, 6m03s, 8m07s and 11m24s. Repeated
compilation is concentrated in the slower Study/Karaoke fixture files. Keep native
sharding while measuring this change; a custom scheduler would add discovery,
port-overlap and failure-propagation obligations before its benefit is known.
Per-case JUnit sums are not full file-process wall times.

Required protection, source acceptance, actual provider/device qualification
and deployment remain separate outcomes. This task changes no production
runtime, provider configuration, managed credential or funded state. No public
chain operation is performed.

The workflow structure follows [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
The settings payload follows [GitHub's ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset).
