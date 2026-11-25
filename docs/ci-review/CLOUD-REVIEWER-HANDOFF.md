# Pirate v1 cloud reviewer handoff

## Trust anchor

The authoritative copies of this handoff and both audits are committed under `docs/ci-review/` on PR #100. The reviewer receives the documentation commit SHA out-of-band and verifies the files at that exact commit.

Do not trust hashes read from release assets or from this document. Release assets are mutable. The independently supplied trust values are the documentation commit SHA and `ASSET-SHA256SUMS` SHA-256 `a386ef81cef55c105338e5617c3293c3f9f1dc134613a6b08c77dadcc46253e3`.

## Identity and scope

- Repository: `pirate-social-club/pirate-operators`
- PR: https://github.com/pirate-social-club/pirate-operators/pull/100
- Branch: `ci/vm-runner-probe-20261124`
- Acceptance-evidence head: `96e95edf38d6add084aea1ebcc4329f68af4e2b3`
- Documentation commit: supplied separately; it must not change `.github/ci/` or either VM workflow.
- PR state: draft and behind `main`; do not merge yet.
- Product hotfix: `34f73d22f794e499a9bf86b22311629dcd2e000a`
- Product tree: `94e58bd43806e484d5a85cf3ad144194c3d9f724`
- Product fix on main: `b18e2764b63d56f065ca0fb7d40b8a92bb889796` through PR #99
- Disposable fixture image: `sha256:eadd63a378767e660337c2f3b2b594ad0c869ebeebada873a7a06bc9b6194a23`

PR #100 changes CI adapters, VM workflows, and reviewer documentation only. It does not change product source or rebuild the product image. The fixture is synthetic and has no live credentials, private backend source, or live effects.

## Public evidence

Fixture release: https://github.com/pirate-social-club/pirate-operators/releases/tag/pirate-v1-staging-vm-fixtures-20261125-r13

| Asset | SHA-256 |
|---|---|
| `ASSET-SHA256SUMS` | `a386ef81cef55c105338e5617c3293c3f9f1dc134613a6b08c77dadcc46253e3` |
| `final-notes-entry.iso` | `d74f98d17ff107d040f7d47b07d4cce7f3a75dee9366a57cf6ab3f02e12b2934` |
| `install-diagnostic.iso` | `a018a6f7648b2b65275f4d1b342a6adc6b9202f5813caf0384af5ea29f1f9885` |
| `final-media-host.tar` | `dddc0270b47491cfe79c8b237cb9bfffc8cc70307d71f69cf3a8d63b3344deaf` |
| `install-only-host.tar` | `d648cf2ff59abeedd3ca60c6cbf2022de6be21681abdf38a36ec2567f88e412e` |

Release copies of the audits are convenience copies only. The git commit is authoritative.

## PR scope and fix commits

Run:

```bash
gh pr diff 100 -R pirate-social-club/pirate-operators --name-only
```

Expected files after the documentation commit:

```text
.github/ci/adapt-final-notes-runner.py
.github/ci/adapt-install-only-runner.py
.github/workflows/pirate-vm-final-acceptance.yml
.github/workflows/pirate-vm-install-only.yml
docs/ci-review/CLOUD-REVIEWER-HANDOFF.md
docs/ci-review/OLD-WORKFLOW-AUDIT.json
docs/ci-review/WORKFLOW-EXIT-AUDIT.md
```

Relevant commits:

- `0458b343e7f3eae30bc66e2b1fd75c78091a1eef` — install-only workflow uses fixture release r13.
- `0240c7c99b090d2dde2edc7dbd49c57af8a215d1` — both CI fixes: accept existing zero-byte install-only evidence files while retaining existence/hash checks, and propagate the install-only verifier exit with `exit "$rc"`.
- `96e95edf38d6add084aea1ebcc4329f68af4e2b3` — final-acceptance workflow uses fixture release r13; this is the head used by run `45541957126`.
- Documentation commit — supplied separately after commit.

Inspect the exact CI fix:

```bash
gh api repos/pirate-social-club/pirate-operators/commits/0240c7c99b090d2dde2edc7dbd49c57af8a215d1 \
  --jq '.sha, .commit.message, (.files[].filename)'
```

## Checksum verification

Download the release, verify the checksum list against the independently supplied hash first, and only then verify the fixture assets:

```bash
gh release download pirate-v1-staging-vm-fixtures-20261125-r13 \
  -R pirate-social-club/pirate-operators \
  --dir /tmp/pirate-fixtures

cd /tmp/pirate-fixtures

printf '%s  %s\n' \
  'a386ef81cef55c105338e5617c3293c3f9f1dc134613a6b08c77dadcc46253e3' \
  'ASSET-SHA256SUMS' | sha256sum -c -

sha256sum -c --strict ASSET-SHA256SUMS
```

Do not use release copies of this handoff or the audits as trust anchors. Verify them at the separately supplied git commit.

## Run binding and evidence

First confirm that the final run is bound to the acceptance-evidence head and expected workflow:

```bash
gh run view 45541957126 \
  -R pirate-social-club/pirate-operators \
  --json headSha,workflowName,event,status,conclusion,url
```

Expected identity fields:

```text
headSha="96e95edf38d6add084aea1ebcc4329f68af4e2b3"
workflowName="Pirate VM final acceptance"
event="pull_request"
```

Confirm that this head pins fixture r13:

```bash
gh api \
  'repos/pirate-social-club/pirate-operators/contents/.github/workflows/pirate-vm-final-acceptance.yml?ref=96e95edf38d6add084aea1ebcc4329f68af4e2b3' \
  -H 'Accept: application/vnd.github.raw+json' \
  | grep -F 'pirate-v1-staging-vm-fixtures-20261125-r13'
```

| Run | Workflow conclusion | Verifier/controller result |
|---|---|---|
| `45525879313` | failure | Final acceptance held; Caddy port `42819` was already in use |
| `45539180872` | success | Guest controller PASS; verifier `held/AssertionError` on normal zero-byte logs |
| `45540542223` | success | Verifier `pass`, `installStatus=PASS`, cleanup 0, QEMU absent, no virtual NIC |
| `45541957126` | failure | Reached `notes-replay`, then close controller timed out; cleanup 1; verifier `held/AssertionError` |

Strict install-only evidence:

```bash
gh run view 45540542223 \
  -R pirate-social-club/pirate-operators \
  --json status,conclusion,jobs

gh run download 45540542223 \
  -R pirate-social-club/pirate-operators \
  -n pirate-install-only-diagnostic \
  -D /tmp/pirate-install-evidence
```

Expected `RESULT.json` fields include `result="pass"`, `installStatus="PASS"`, `installPhase="install-only-complete"`, `independentClosure=true`, `qemuProcessAfterWait="absent"`, and `noVirtualNic=true`.

Failed final-acceptance evidence:

```bash
gh run view 45541957126 \
  -R pirate-social-club/pirate-operators \
  --json status,conclusion,jobs

gh run download 45541957126 \
  -R pirate-social-club/pirate-operators \
  -n pirate-final-acceptance \
  -D /tmp/pirate-final-evidence
```

The current failure is not the zero-byte verifier issue. `notes-controller-terminal.json` reached `notes-replay`, then failed at `close` with `TimeoutExpired` and child exit 143; the serial terminal reports cleanup 1.

## Sealed final-verifier issue confirmed

The sealed `verify-notes-run.py` also assumes non-empty evidence members. At line 220, `receipt_set()` asserts:

```python
all(member.isfile() and 0 < member.size <= 1024 * 1024 for member in members)
```

The failed final archive contains normal zero-byte logs, so a future close-success archive can be falsely held for the same harmless reason. This must be repaired before the next final-acceptance run. It did not cause run `45541957126`, which failed earlier at close with cleanup 1.

Inspect the sealed verifier:

```bash
tar -xOf /tmp/pirate-fixtures/final-media-host.tar verify-notes-run.py \
  | nl -ba | sed -n '214,222p'
```

## Exact final-acceptance field map

`RESULT.json` is emitted by the sealed `verify-notes-run.py`. A held verdict exits nonzero and the workflow propagates it.

`guestTerminal` positions are `[stage, rc, cleanup, cutoffMs, utc]`.

| Requirement | Exact field/evidence and expected value |
|---|---|
| Overall full journey | `RESULT.json.result == "pass"`; `guestTerminal == [["evidence-sent", "0", "0", "<exact WORKER-CUTOFF-MS>", "<UTC>"]]`. Pass is only set after all required success receipts exist, including `wizard-installed.json`, `wizard-reopened.json`, `notes-before.json`, `notes-after.json`, `restart-before.json`, `restart-terminal.json`, `restart-after.json`, `reopened-original.json`, and `replay.json`. |
| HTTPS, publication and playback | Required guest receipts `wizard-installed.json` and `wizard-reopened.json`; `notes-before.json.playback.wire.range == 206`; `notes-after.json.playback.wire.range == 206`; both `playback.analysis.ok == true`. |
| Ordinary restart and same Store | `RESULT.json.sameStore == true`; `RESULT.json.oldAndNewBrowserDecoded == true`; required `restart-before.json`, `restart-terminal.json`, `restart-after.json`, and `reopened-original.json`. |
| Replay with zero duplicate effects | `RESULT.json.newEffectsOnReplay == 0`; guest `resources.json.newEffectsOnReplay == 0`; `notes-after.json.counts.seal == 0`; `notes-before.json.proof == notes-after.json.proof`; playback wire values are equal. |
| Cleanup 0 | `RESULT.json.guestTerminal[0][2] == "0"` and `RESULT.json.independentClosure == true`. |
| QEMU absent and clean exit | `RESULT.json.qemuProcessAfterWait == "absent"` and `RESULT.json.qemuExit == "0"`. |
| No virtual NIC | Final `RESULT.json` has no `noVirtualNic` field. Verify `QEMU-IDENTITY.json.argv` contains `-nic none` and no `-netdev`; guest `isolation.json.guestUplink == "no-virtual-nic"` and `hostAndBrowserEgress == "denied"`. |
| Exact image and retained identity | `RESULT.json.imageId == "sha256:eadd63a378767e660337c2f3b2b594ad0c869ebeebada873a7a06bc9b6194a23"`; `installationId`, `grantId`, `attachmentDigest`, and `postId` are present. |

## Post-merge identity rule

The acceptance evidence belongs to `96e95edf38d6add084aea1ebcc4329f68af4e2b3`. After updating #100 from `main`, require all of the following or rerun final acceptance:

1. `.github/ci/` and both VM workflows are byte-identical to `96e95ed`.
2. The accepted release evidence still reports product source head `34f73d22f794e499a9bf86b22311629dcd2e000a` and source tree `94e58bd43806e484d5a85cf3ad144194c3d9f724`.
3. The final run remains bound to the reviewed workflow and fixture release.

Check the CI/workflow delta after updating the branch:

```bash
gh api repos/pirate-social-club/pirate-operators/compare/96e95edf38d6add084aea1ebcc4329f68af4e2b3...<new-head> \
  --jq '[.files[] | select((.filename|startswith(".github/ci/")) or .filename==".github/workflows/pirate-vm-final-acceptance.yml" or .filename==".github/workflows/pirate-vm-install-only.yml") | {filename,status}]'
```

Expected output is `[]`. Any entry requires review or a fresh acceptance run.

## Historical verifier audit

The six earlier green install-only workflows all returned verifier `held/AssertionError`, while their guest controllers passed installation:

- `45491608403`
- `45497221664`
- `45500341785`
- `45500768688`
- `45525879298`
- `45539180872`

Each archive contains six normal zero-byte Wizard stdout/stderr logs. The old install-only verifier required every evidence member to be non-empty, and the old workflow omitted `exit "$rc"`.

PR #99 was not affected: head `8deb8593face31e90dd98031d60c631c7b06fa2f` contained neither VM workflow. CI run `45471920123` produced 97 root tests with zero failures/errors/skips and two identical nine-line acceptance traces.

The corrected install-only verifier accepts an existing empty manifest-listed log, still hash-checks it, and rejects a manifest-listed missing log. The sealed final verifier still needs the equivalent repair.

## Other workflow exit audit

All nine workflows on acceptance head `96e95ed` and all seven workflows on `main` were checked. Full citations are in `docs/ci-review/WORKFLOW-EXIT-AUDIT.md`.

- No workflow or job sets `shell:` or `defaults.run.shell`; ordinary Linux steps use default `bash -e` without implicit `pipefail`.
- Every relevant pipeline has explicit `pipefail`: `local.yml:52` for pipelines at `:59`, `:60`, `:62`, `:64`; `web.yml:46` for `:48`; `pirate-vm-final-acceptance.yml:46` for `:50`; `pirate-vm-install-only.yml:45` for `:49`.
- Nested test shells use `set -euo pipefail` at `local.yml:74` and `:137`, `karaoke.yml:52`, and `study.yml:37`.
- No `|| true` or `|| :` swallows a test, verifier, build, or acceptance exit.
- `continue-on-error: true` is limited to first-attempt Foundry installation at `community-wizard.yml:25`, `karaoke.yml:23`, `local.yml:28`, and `local.yml:109`; each has a retry without `continue-on-error`.
- Aggregate jobs using `if: always()` explicitly require success at `ci.yml:74-77` and `local.yml:164-166`.
- No additional unpropagated test/verifier exit was found. No workflow behavior was changed by the audit.

## Reviewer decision

Do not merge PR #100 or begin live visits. First repair the close timeout and the sealed final verifier's zero-byte assumption, rerun final acceptance, and apply the post-merge identity rule.

No live Visit 1 or Visit 2 action is authorized by this packet. Those still require separate-session Lane 6 GOs.
