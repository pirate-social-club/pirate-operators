# Pirate v1 cloud reviewer handoff

## Status and trust anchor

PR #100 remains draft. Final acceptance remains open. Do not merge it and do not begin either live visit from this packet.

The authoritative copies of this handoff and both audits are committed under `docs/ci-review/` on PR #100. The reviewer receives the candidate/documentation SHA and the r18 `ASSET-SHA256SUMS` digest out of band. Verify the documents at that exact Git commit. Do not trust release copies of these documents or hashes read from the release itself.

The reviewed fixture pin is `.github/ci/vm-fixtures-r18.json`. Both VM workflows read it from Git, verify the downloaded manifest against its pinned digest, and only then verify assets, extract the host runner, or execute guest content.

## Git and fixture identity

- Repository: `pirate-social-club/pirate-operators`
- PR: https://github.com/pirate-social-club/pirate-operators/pull/100
- Branch: `ci/vm-runner-probe-20261124`
- Close-timeout run head: `96e95edf38d6add084aea1ebcc4329f68af4e2b3`
- Close-timeout executed merge: `4fb494e106cc7f036d6b7a2ca33233c490b2bb26`
- Newer run head: `a5d7bd5b586cdd084b2245c3fdf6c2cc76628bd9`
- Newer executed merge: `ada9563e54539fadae278e1080e228f73f443036`
- Both executed against base: `cf03e0b57fbf4321cdbf896fdf8364683209ea01`
- Current-main merge on #100: `fc8f6ae92a18300e326e5309b78ea6d74707df79`
- r15 decisive-run head: `020a45fe700ddea7204dae0a7c8914565f155d6d`
- r15 executed checkout merge: `21ee3ddcad3f118b0284971021d6d08950cb08a2`
- r16 diagnostic-run head: `e849b78d250454cc84a3caba4543182738832323`
- r16 executed checkout merge: `f603e3d27735d364de8efb38d64ebbb0f890a675`
- r17 diagnostic-run head: `854beefaa59da838f24a9d5dfe04838f189dfaba`
- r17 executed checkout merge: `1ca76ab78382216ffefe1301a9cbc70c99078e4b`
- Shared `.github/ci` tree across those heads and merges: `4ba47b4c8b20acc04a3b73ffd81fccdc376df994`
- Shared final workflow blob: `3604c60f04ac90ad5f5d0b674ba5a268fb5e1afd`
- Shared install-only workflow blob: `cf434ef813ca1f6fccbc76fe0e5890db89fcaa29`
- Product source: `34f73d22f794e499a9bf86b22311629dcd2e000a`
- Product tree: `94e58bd43806e484d5a85cf3ad144194c3d9f724`
- Fixture image: `sha256:eadd63a378767e660337c2f3b2b594ad0c869ebeebada873a7a06bc9b6194a23`
- Successor release: `pirate-v1-staging-vm-fixtures-20261125-r18`
- Unchanged asset release: `pirate-v1-staging-vm-fixtures-20261125-r13`
- r18 manifest SHA-256: `eefbb446bded4d3b6f426672bddcdf3aac465ed751a0fdce0f0e163054200733`

PR #100 changes CI adapters, VM workflows, fixture tooling, and reviewer documentation only. It does not change product source or rebuild the product image. The fixture is synthetic and has no live credentials, private backend source, or live effects.

Every new VM run writes `RUN-IDENTITY.json` before downloading fixtures. It records `headSha`, `executedMergeSha`, `baseSha`, `checkoutSha`, checkout and head object IDs for `.github/ci` and both workflows, the fixture release and manifest digest, the fixture-pin digest, and the product head/tree/image. The artifact upload includes that file.

## Fixture successor and evidence repair

r13 remains unchanged at manifest SHA-256 `a386ef81cef55c105338e5617c3293c3f9f1dc134613a6b08c77dadcc46253e3`. The r18 successor is a repair-overlay release: it carries the repaired final host runner, the complete asset manifest, `FIXTURE-REPAIR.json`, and reviewer documents. Every fixture and image byte remains unchanged. After verifying the pinned r18 manifest digest, both workflows fill missing unchanged assets from r13 with `--skip-existing` and then verify the complete manifest before extraction or execution.

| Asset | SHA-256 |
|---|---|
| r18 `ASSET-SHA256SUMS` | `eefbb446bded4d3b6f426672bddcdf3aac465ed751a0fdce0f0e163054200733` |
| r18 `final-media-host.tar` | `590f8fbca075f865bb625b36d7ae63741f20d30f74459c4993f1860cb7230f15` |
| r18 `FIXTURE-REPAIR.json` | `172fbb712e65c60be73b5eeefb663cb0a7765cee06d33b45208b65e7d9349fd9` |
| `final-notes-entry.iso` | `d74f98d17ff107d040f7d47b07d4cce7f3a75dee9366a57cf6ab3f02e12b2934` |
| `install-diagnostic.iso` | `a018a6f7648b2b65275f4d1b342a6adc6b9202f5813caf0384af5ea29f1f9885` |
| `install-only-host.tar` | `d648cf2ff59abeedd3ca60c6cbf2022de6be21681abdf38a36ec2567f88e412e` |

The r13 HOLD exporter returned logs, text files, and a private controller receipt outside the verifier's HOLD allowlist. The verifier stopped at the allowlist assertion before reaching its nonempty-size assertion, and its final JSON parse would also have tried to parse admitted text logs. The success exporter already returned 23 JSON receipts plus the manifest and no logs.

r18 makes the HOLD exporter return `hold-terminal.json` plus allowlisted JSON receipts only. The verifier hash-checks every archive member before grading, names unexpected members, includes the controller phase/status/child exit in that held reason, requires nonempty JSON receipts, reports `verifyMessage`, and retains the same nonempty hash-checked success boundary. A failed worker also exports sanitized `worker-diagnostic.json` with systemd result, cgroup memory, kernel OOM victim identity, journal PID/executable mapping, and top UID-1000 process RSS. Collection decodes subprocess output with replacement and writes an explicit `collectionError` receipt if it fails, so diagnostic loss cannot be silent. Twelve focused receipt-boundary checks pass.

The fixed verifier was run against the original `45541957126` guest archive, SHA-256 `e93ca81d9712e3dfad973c810e6e65d614845508a4c12e87014fe2a24d691e21`. The archive was not modified. Only omitted host metadata was reconstructed for the local verifier exercise. The verifier exited 1 and returned `held` with this intelligible reason:

```text
unexpected evidence member(s): logs/installed-service.stderr.log, logs/installed-service.stdout.log, logs/native-notes-control.mjs.publish.stderr.log, logs/native-notes-control.mjs.publish.stdout.log, logs/native-notes-control.mjs.replay.stderr.log, logs/native-notes-control.mjs.replay.stdout.log, logs/native-runner.private.log, logs/wizard-notes-control.mjs.fund-original.stderr.log, logs/wizard-notes-control.mjs.fund-original.stdout.log, logs/wizard-notes-control.mjs.hold-registration.stderr.log, logs/wizard-notes-control.mjs.hold-registration.stdout.log, logs/wizard-notes-control.mjs.install-original.stderr.log, logs/wizard-notes-control.mjs.install-original.stdout.log, logs/wizard-notes-control.mjs.retained-repair.stderr.log, logs/wizard-notes-control.mjs.retained-repair.stdout.log, notes-controller-terminal.json, worker-private.txt; controller phase=close status=FAIL childExit=143 error=unclassified-private-error
```

The fixed result is SHA-256 `2ef12d4d3b093a45ef47a45735e6954267340d23928fecc8190edfc878141580`.

## Checksum verification

Download r18, supply the expected digest separately, and stop on a mismatch before checking or executing any asset:

```bash
release=pirate-v1-staging-vm-fixtures-20261125-r18
unchanged=pirate-v1-staging-vm-fixtures-20261125-r13
EXPECTED_MANIFEST_SHA256='<supplied separately>'

gh release download "$release" -R pirate-social-club/pirate-operators --dir /tmp/pirate-fixtures

python3 .github/ci/verify-vm-fixtures.py /tmp/pirate-fixtures/ASSET-SHA256SUMS "$EXPECTED_MANIFEST_SHA256"

gh release download "$unchanged" -R pirate-social-club/pirate-operators --dir /tmp/pirate-fixtures --pattern '*' --skip-existing

(cd /tmp/pirate-fixtures && sha256sum -c --strict ASSET-SHA256SUMS)
```

`verify-vm-fixtures.py` accepts the digest as its second argument, validates its shape, computes the downloaded manifest digest, and exits nonzero with both expected and actual values on mismatch.

## Terminal evidence

Run `45541957126` reached `notes-replay`, then the controller's bounded close wait timed out and sent stop. The controller recorded child exit 143; the guest reported cleanup 1. QEMU subsequently exited 0 and was absent. The evidence still does not identify which shutdown operation stalled. Do not raise the timeout or label this fixture-only.

Run `45544464948` did not repeat the close stall. It reached `ordinary_native_restart`; the guest kernel OOM-killed UID-1000 process 3440 after the restart command. The controller held with `outer_guest_termination`, cleanup 1, and no child exit. QEMU exited 0 and was absent. This is a restart-path resource failure, not evidence of a shutdown hang and not yet proof of fixture-only causality.

Run `45560410081` on head `020a45fe700ddea7204dae0a7c8914565f155d6d` and executed checkout merge `21ee3ddcad3f118b0284971021d6d08950cb08a2` again held at `ordinary_native_restart`. The repaired evidence path returned `holdTerminal` and `controllerEvidence` without an assertion crash. The guest kernel OOM-killed UID-1000 process 3442 (`MainThread`, about 1.6 GiB anonymous RSS); cleanup was 1 and QEMU exited 0 and was absent. The event payload's `merge_commit_sha` was stale, so the recorder now uses the validated checkout SHA as `executedMergeSha`.

Run `45564123575` on head `e849b78d250454cc84a3caba4543182738832323` and executed checkout merge `f603e3d27735d364de8efb38d64ebbb0f890a675` again held at `ordinary_native_restart`. The guest kernel OOM-killed UID-1000 process 3496 (`MainThread`, about 1.7 GiB anonymous RSS); the controller recorded child exit -9, cleanup was 1, and QEMU exited 0 and was absent. The first worker-diagnostic collector failed silently, so `workerDiagnostic` was null.

Run `45567884207` on head `854beefaa59da838f24a9d5dfe04838f189dfaba` and executed checkout merge `1ca76ab78382216ffefe1301a9cbc70c99078e4b` again held at `ordinary_native_restart`. The guest kernel OOM-killed UID-1000 process 3440 (`MainThread`, about 1.46 GiB anonymous RSS); cleanup was 1 and QEMU exited 0 and was absent. The hardened collector wrote its receipt beside the session, but the HOLD exporter packed only `hold-evidence`, so `workerDiagnostic` was still null. r18 copies the diagnostic into `hold-evidence` before packing.

If a later run stalls at close, first capture each shutdown operation's start and finish around the controller's bounded wait. Identify the operation before changing the timeout or assigning cause.

## Reviewer evidence and no-NIC check

The no-NIC assertion already exists in the packaged verifier's `assess()` function: it requires `-nic none`, rejects `-netdev` and `-virtfs`, and requires the expected QEMU device. The gap was artifact access. The final workflow now uploads `QEMU-IDENTITY.json` and `WORKER-CUTOFF-MS.txt`, along with `RUN-IDENTITY.json`, memory samples, QEMU log, overlay identity, dispatch expiry, execution pin, and seed hashes.

`guestTerminal` positions are `[stage, rc, cleanup, cutoffMs, utc]`. The five positions and the workflow shell/pipeline citations were independently checked.

| Requirement | Exact field/evidence and expected value |
|---|---|
| Overall full journey | `RESULT.json.result == "pass"`; `guestTerminal == [["evidence-sent", "0", "0", "<exact WORKER-CUTOFF-MS>", "<UTC>"]]`. Required success receipts include install, reopen, playback, restart and replay. |
| HTTPS, publication and playback | `wizard-installed.json` and `wizard-reopened.json`; both `notes-before.json` and `notes-after.json` have `playback.wire.range == 206` and `playback.analysis.ok == true`. |
| Ordinary restart and same Store | `RESULT.json.sameStore == true`; `RESULT.json.oldAndNewBrowserDecoded == true`; restart and reopened receipts are present. |
| Replay with zero duplicate effects | `RESULT.json.newEffectsOnReplay == 0`; `resources.json.newEffectsOnReplay == 0`; `notes-after.json.counts.seal == 0`; before/after proof and playback wire values match. |
| Cleanup 0 | `guestTerminal[0][2] == "0"` and `independentClosure == true`. |
| QEMU absent and clean exit | `qemuProcessAfterWait == "absent"` and `qemuExit == "0"`. |
| No virtual NIC | `QEMU-IDENTITY.json.argv` contains `-nic none` and no `-netdev`; guest `isolation.json.guestUplink == "no-virtual-nic"` and `hostAndBrowserEgress == "denied"`. |
| Exact image and retained identity | `RESULT.json.imageId == "sha256:eadd63a378767e660337c2f3b2b594ad0c869ebeebada873a7a06bc9b6194a23"`; installation, grant, attachment and post identities are present. |

## PR #99 correction

PR #99 head `8deb8593face31e90dd98031d60c631c7b06fa2f` contained neither VM workflow. CI run `45471920123` has four JUnit files with 680, 758, 695 and 663 direct `<testcase>` elements: 2,796 total, zero failures, zero errors and one skip. Summing `<testsuite>` attributes gives 97 and misses 2,699 direct testcase children.

The skip is intentional and conditional: `test/learning-sign-in-moss.test.ts` skips the hosted-bundle source/hash assertion when `MOSS_BUNDLE_PATH` is unset. No other CI check supplies that bundle or covers that assertion. The normal transcription/pattern tests still run, and `docs/learning-v4-rollout.md` explicitly leaves normal-UI MOSS and real-account ERC-1271 acceptance unqualified. The skip is therefore disclosed environment-gated coverage, not a hidden failure and not a claim of hosted-wallet acceptance.

The two acceptance traces are byte-identical, nine lines each, SHA-256 `eddc4308c3ef483c256e438c00d0dd99e95c2191baac971f39e777cf63e2ebf0`.

## Workflow exit audit

No workflow or job sets `shell:` or `defaults.run.shell`; ordinary Linux steps use default `bash -e` without implicit `pipefail`. Every relevant pipeline has explicit `pipefail`:

- `pirate-vm-final-acceptance.yml:60` sets `set -uo pipefail`; the runner/`tee` pipeline is at `:64`, captures `rc`, and exits with it at `:70`.
- `pirate-vm-install-only.yml:57` sets `set -euo pipefail`; the runner/`tee` pipeline is at `:61`, captures `rc`, and exits with it at `:67`.
- Nested test shells retain `set -euo pipefail`; the full citations are in `WORKFLOW-EXIT-AUDIT.md`.

No `|| true` or `|| :` swallows a test, verifier, build, or acceptance exit. `continue-on-error: true` remains limited to first-attempt Foundry installation with a retry. Aggregate jobs using `if: always()` explicitly require success. Artifact uploads remain the only other `if: always()` steps, now at final line 72 and install-only line 69.

## Acceptance and next action

There is no passing baseline yet. Current main is merged into #100 at `fc8f6ae92a18300e326e5309b78ea6d74707df79`. Keep the PR draft, run focused checks and required CI, then run decisive final acceptance on r18. Require a terminal pass, cleanup 0, QEMU absent with exit 0, and the restart, playback and zero-duplicate replay receipts on that exact candidate. Record its head, executed merge, fixture digest and product identity from `RUN-IDENTITY.json`.

That first passing run becomes the byte-identity baseline for later comparisons. Compare the recorded `.github/ci` tree and both workflow blob IDs; do not compare only a documentation head. Repost the corrected handoff only after the pass, with the new documentation SHA and manifest digest supplied separately.

Live Visits 1 and 2 retain their separate Lane 6 approvals. This packet authorizes no live arm, invite, registration or publication.
