# Pirate operators CI and test audit

This audit covers pirate-operators at a88ae60e6c5b85df8799d0ad0c52333ab4f43784.
The owner explicitly excluded other repositories. Three parallel read-only
reviews examined root tests, web tests and the CI/release pipeline. Each deleted
candidate and its production owner were read. This is not a claim that every
remaining test received a line-by-line review.

The main problem is repeated expensive integration work. Remove 39 low-signal
cases, preserve meaningful failure coverage, and stop paying twice for the same
commit and suite. Do not force the requested 20 percent quota: the evidence does
not justify deleting hundreds more unique database, Worker, authorization,
WebSocket, chain and recovery cases.

## Measured CI duration

The latest 100 workflows span November 10 at 21:17:16 UTC through November 12
at 16:54:09 UTC. The table uses successful latest-attempt runs. Wall time starts
at workflow creation and ends at the last job completion; p90 is nearest rank.
It includes queue time. The run and job timestamps are in ci-runs.json.

| Workflow         | Successful runs | Median wall | P90 wall |
| ---------------- | --------------: | ----------: | -------: |
| Local acceptance |              14 |      25m52s |   30m51s |
| Karaoke client   |              16 |    12m14.5s |   14m29s |
| Web client       |              19 |       3m55s |    4m40s |
| Study client     |              17 |       1m45s |    2m05s |
| Community wizard |              16 |       1m40s |    2m00s |

Typical initial queue time was about three seconds. One Local run queued for
33m46s and took 59m39s overall. The latest main revision used 50.7 runner minutes
across five workflows and took 30m51s wall time. Its root Node suite ran 1,680
cases in 28m21s, with 1,679 passing and one optional artifact check skipped.
Forge ran 248 tests in about one second.

There were 33 same-workflow, same-SHA push/PR pairs in the sample, accounting for
at least 253.5 redundant runner minutes out of 840.5 observed runner minutes.
This is measured wasted execution, not a prediction of wall-time savings.

The baseline [Local job](https://github.com/pirate-social-club/pirate-operators/actions/runs/43263682150/job/131341404668)
and [Karaoke job](https://github.com/pirate-social-club/pirate-operators/actions/runs/43263681897/job/131341404695)
provide the step logs behind the bottleneck findings.

## Pipeline changes

All six workflows now run automatically on PRs and pushes to main. Manual
branch checks remain available. A PR update cancels its obsolete run of the
same workflow. Main and manual runs use unique concurrency groups so newer
accepted revisions do not discard pending release evidence.

Local acceptance partitions the complete root test glob across four isolated
runners with native Node sharding. Each keeps two test processes, its own chain
ports, the existing dependencies, Foundry and media tools, and disabled external
networking. A separate job retains typecheck, Solidity, Worker packaging and two
acceptance runs whose traces must compare equal. The final local job requires
both the complete matrix and offline acceptance to succeed. No root test is
removed by the shard partition.

Karaoke no longer repeats 255 root cases owned by Local and thirteen app cases
owned by Web. The actual tests remain. The Web path filter also includes their
shared root test helper. Karaoke still runs its actual browser journeys.
Local acceptance no longer executes a third copy of the acceptance harness.
The ordinary local npm run check command retains its existing semantics.

The last green Local run logged: "No files were found with the provided path:
.local/trace-\*.jsonl." Its artifact list was empty. Exact trace uploads now opt
in to hidden-directory files and fail when absent on a successful job. Every
root shard retains JUnit output. Study retains a machine-readable success
report, and Web retains the clean-build reproducibility report. Uploads name
only their intended evidence files, not arbitrary hidden runtime state.

The Creator spike now watches its imported shared community package and root
package/lock files. Previously those changes could skip its tests entirely.

Sharding and removing duplicate executions should materially reduce turnaround.
The exact saving requires a hosted run of this change. Extra runners repeat
setup, so four shards do not imply a fourfold runner-cost saving.

## Tests removed and retained

Counts below are expanded cases, including matrix rows. deletions.json records
the candidate, production owner and retained evidence for every removal.

| Removed cases                                         | Count | Retained protection                                                                                          |
| ----------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------ |
| CSS source declaration greps                          |     5 | Real 320px browser token-row and overflow checks                                                             |
| Presentation source hashes                            |     2 | Study/Karaoke browser journeys; provenance comments and documents remain                                     |
| Test-local identity function and test-helper behavior |     2 | Actual manifest adapter and MOSS adapter contracts                                                           |
| Duplicate lower media recovery matrix                 |    14 | All fourteen real flow/remount variants, exact File and CSRF assertions                                      |
| Repeated profile status/body matrices                 |    13 | Header-before-body contract, immediate pending-load mask, mounted recovery and all distinct receipt failures |
| Solidity statement grep and helper backdate duplicate |     2 | Deployed getter/rendered vectors and DB-backed login/session timing                                          |
| Unused bootstrap job-state test                       |     1 | No product consumer exists; its 17 production lines are removed                                              |
| Total                                                 |    39 |                                                                                                              |

The baseline covered 117 candidate and adjacent cases, all passing. After pruning,
78 cases pass. No failing test was deleted to make a gate green. Review preserved
one profile case that uniquely checks immediate private-data masking, and moved
the lower media test's unique File/CSRF assertions into the retained stronger flow.

Retain cryptographic edge vectors, EIP-170 compiler-size limits and exact external
artifact integrity checks. These protect public or release contracts rather than
source formatting. Retain malformed-input and timing/race cases, real D1/Worker/
Anvil flows, the independent two-clean-build CAR/CID check, and the wizard's
production-only dependency smoke test. Their credible failure modes are not
replaced by ordinary successful browser journeys.

The root suite has 293 test files before removal and 292 afterward. Static
inventory found approximately 1,401 root test declarations, with parameterized
cases expanding at runtime. The web inventory has 84 test/spec files before
removal, including 17 browser specs. A 20 percent cut would require deleting
hundreds of additional cases without demonstrated stronger replacement. Coverage
numbers would not make that a defensible change. AGENTS.md now records the
owner's behavior-first testing rules.

## Coverage and verification

There was no configured whole-suite coverage baseline. Node 24.14.0 built-in V8
coverage was measured before and after using the same production include globs,
packages/** and apps/web/src/**, on the audited Node suites and retained adjacent
media cases. Only forty imported production files enter this measurement. Test
files are excluded; dynamically evaluated hook bodies are not attributed to their
original source. This is scoped coverage, not whole-product coverage.

| Measure                  |  Before |   After |                   Change |
| ------------------------ | ------: | ------: | -----------------------: |
| Passing focused tests    |     117 |      78 |                      -39 |
| Production line coverage | 70.259% | 70.122% | -0.137 percentage points |
| Branch coverage          | 71.758% | 71.634% | -0.125 percentage points |
| Function coverage        | 55.385% | 55.106% | -0.279 percentage points |
| Measured source lines    |   8,063 |   8,046 |           -17 dead lines |

coverage.json and the relative-path baseline.lcov.gz/after.lcov.gz files retain the
counts. The focused run took 6.14s before and 6.63s after on the workstation;
that single pair does not demonstrate a local test-speed improvement. The CI
savings are expected from duplicate execution removal and isolated sharding.

Root and web typechecks pass. All 447 remaining web Node cases, 192 component
cases and 248 Solidity cases pass. The retained DB-backed backdate integration
case passes separately. Actionlint checks the changed workflows. Full integration,
browser, packaging and acceptance qualification belongs to exact-head hosted CI;
the full root suite is not represented by the focused local run. The PR and task
record track that hosted result.

## Release and open risks

The read-only GitHub inspection returned an empty ruleset list and
"Branch not protected" for main. Repository prose requires PRs, but remote
protection presently does not enforce that policy. No remote setting was
changed. Before relying on automatic release eligibility, enforce PRs and the
applicable Local, Web, Study, Karaoke, Wizard and Creator results on main.
Path-filtered checks need a required always-running aggregate or conditional
required-workflow design rather than requirements that remain pending when
intentionally skipped.

No workflow deploys production, provisions credentials or makes public-chain
writes. Release remains explicit operator tooling with exact source/artifact
binding and live readback. A fixture browser pass cannot establish actual
provider, funded-wallet or physical-device acceptance. No release or provider
operation was performed by this audit.

Repeated Solidity compilation remains an optimization opportunity: twenty root
files start chains through a helper that recompiles eleven source files. One
read-only compile took 7.23s. A future exact-input cache must bind compiler version,
settings and every source, isolate concurrent writes and corruption, and avoid
silently trusting a test cache in the same helper's manual deployment callers.
This change does not introduce that deployment-path risk.

The workflow changes follow [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[upload-artifact behavior](https://github.com/actions/upload-artifact), and
[Node 24 test sharding](https://nodejs.org/download/release/v24.22.1/docs/api/cli.html#--test-shard).

## Evidence verification

CHECKSUMS.txt binds the retained measurement files. From this directory, run
`sha256sum -c CHECKSUMS.txt`. Decode the relative-path coverage records with
`gzip -dc baseline.lcov.gz` and `gzip -dc after.lcov.gz`. The coverage command
uses Node's `--experimental-test-coverage`, `--test-concurrency=1`, spec and lcov
reporters, and the two production include globs described above. The before
selection is the ten candidate/adjacent Node test files listed in deletions.json,
including the retained media-source-repair.test.ts neighbor. The after selection
omits the three deleted files. Coverage timing is a single paired sample, not a
benchmark. Historical CI timings retain every run SHA and canonical URL.
