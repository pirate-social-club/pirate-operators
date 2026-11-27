# Pirate v1 cloud reviewer handoff

## What passed

The offline pilot is qualified on PR #100 head `f0feb0783d25797ecbd38a9cfa61602fbc6febb0`. Final acceptance attempt 2 passed at 4096 MiB with no virtual NIC. The guest installed, published, decoded HTTPS audio before and after an ordinary restart on the same Store, replayed with zero new effects, returned an empty hold list and closed cleanly. QEMU exited 0 and its process was absent. [Final acceptance, attempt 2](https://github.com/pirate-social-club/pirate-operators/actions/runs/45950111683/attempts/2)

Standalone installation and general CI passed on the same head. The install-only guest reached `install-only-complete` with both refusal fields null and clean independent closure. General CI passed, including `release-ready`; its four root reports contain 2,798 direct test cases, zero failures, zero errors and one disclosed conditional skip. [Standalone installation](https://github.com/pirate-social-club/pirate-operators/actions/runs/45950111918/attempts/1) · [General CI](https://github.com/pirate-social-club/pirate-operators/actions/runs/45950111809/attempts/1)

| Measurement | Attempt-2 value | Limit |
|---|---:|---:|
| Initial service pairing | 18.036 s | 120 s |
| Restart service pairing | 134.297 s | 300 s |
| Lowest sampled guest MemAvailable | 74.65 MiB over 276 samples | no fixed floor |

Pair times are elapsed between guest `service-pair-wait` enter and return markers. They measure the service handshake, not operator foreground time. The five-minute Fluence foreground-to-Pair gate still requires its own measurement from the operator-facing starting point.

## Source, checkout and fixture

| Identity | Accepted value |
|---|---|
| Evidence head (PR #100) | `f0feb0783d25797ecbd38a9cfa61602fbc6febb0` |
| Evidence-head tree | `29ef23a322ac29af20ea8e427b1bffc843893d2c` |
| Executed pull-request checkout | `b43b90ca5f73fd49f96d54857ef92d91707321d6` |
| Base at run time | `afff5da0a6059d3a6ddf212233f60532a10d2220` |
| Pilot product head / tree | `c99644d870e92f465a396f42497d203913a55e58` / `11e0616e371d31ddfb4e3635a1bcc370a9fb0586` |
| Guest image | `sha256:84810e0f0024474e2fc8a9aa6065a3494808f391d62855d5aaaeeb00c0b6eeae` |
| Fixture release / unchanged assets | `pirate-v1-staging-vm-fixtures-20261127-r24` / `pirate-v1-staging-vm-fixtures-20261125-r13` |
| Fixture manifest SHA-256 | `eb73942465cb2ad94757a3ff26bf22c8afa6c8081b03e560428fe05cdb32bdd2` |
| Fixture pin file SHA-256 | `4751b2b010fda5d4793492107cb4f146ab6d584ce719be8a0eebfdbe86d0ba88` |
| Git pin path | `.github/ci/vm-fixtures-r20.json` |

The evidence-head tree is byte-identical to the tree exercised by the earlier same-tree r24 pass. The current-head attempt-2 pass is the qualifying evidence for this review. The final and install run identities record the same checkout CI tree `e31a952eb2e674de2d4f72015b9827fbe12ef74f`, final workflow blob `ae078b84885f8453149c742baad1b287553a438e`, install workflow blob `d97220b24ca956ecffdb9eaf985f53c5d14d9c03`, product, image, fixture release and manifest.

The r24 release intentionally carries only one copy of the byte-identical smoke payload as `smoke-inputs.iso`. The manifest pins `final-smoke-inputs.iso` to the same digest, and both workflows materialize that logical copy as a local hard link before strict whole-manifest verification. This does not bypass verification: every manifest entry is still checked with `sha256sum -c --strict` before adaptation.

## Trust and reproduction

Obtain the documentation commit SHA and the r24 `ASSET-SHA256SUMS` SHA-256 directly from the owner, outside the release. Retrieve all three documents from `docs/ci-review/` at that commit. Release assets can be replaced. Never take an expected hash from the release or from the document being verified. The JSON configuration file has its own SHA-256. The checksum-list hash is the value recorded in its `manifestSha256` field.

Run in Bash with `DOCS_SHA` and `EXPECTED_MANIFEST_SHA256` set from the independent message. This needs GitHub CLI, jq and GNU sha256sum. The directory is fresh so a previous download cannot mask a missing file.

```bash
set -euo pipefail
: "${DOCS_SHA:?set the independently supplied documentation commit}"
: "${EXPECTED_MANIFEST_SHA256:?set the independently supplied checksum-list digest}"
[[ "$DOCS_SHA" =~ ^[0-9a-f]{40}$ && "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]
tmp=$(mktemp -d)
repo=pirate-social-club/pirate-operators
for file in CLOUD-REVIEWER-HANDOFF.md OLD-WORKFLOW-AUDIT.json WORKFLOW-EXIT-AUDIT.md; do
  gh api "repos/$repo/contents/docs/ci-review/$file?ref=$DOCS_SHA" \
    -H 'Accept: application/vnd.github.raw+json' > "$tmp/$file"
done
gh api "repos/$repo/contents/.github/ci/vm-fixtures-r20.json?ref=$DOCS_SHA" \
  -H 'Accept: application/vnd.github.raw+json' > "$tmp/pin.json"
jq -e --arg expected "$EXPECTED_MANIFEST_SHA256" '.manifestSha256 == $expected' "$tmp/pin.json"
release=$(jq -r .release "$tmp/pin.json")
fallback=$(jq -r .unchangedAssetRelease "$tmp/pin.json")
mkdir "$tmp/assets"
gh release download "$release" -R pirate-social-club/pirate-operators \
  --dir "$tmp/assets" --pattern ASSET-SHA256SUMS
(cd "$tmp/assets" && printf '%s  ASSET-SHA256SUMS\n' "$EXPECTED_MANIFEST_SHA256" | sha256sum -c --strict -)
gh release download "$release" -R pirate-social-club/pirate-operators \
  --dir "$tmp/assets" --pattern '*' --skip-existing
gh release download "$fallback" -R pirate-social-club/pirate-operators \
  --dir "$tmp/assets" --pattern '*' --skip-existing
(
  cd "$tmp/assets"
  smoke_pin=$(awk '$2 == "smoke-inputs.iso" {print $1}' ASSET-SHA256SUMS)
  final_smoke_pin=$(awk '$2 == "final-smoke-inputs.iso" {print $1}' ASSET-SHA256SUMS)
  if [[ -n "$smoke_pin" && "$smoke_pin" == "$final_smoke_pin" ]]; then
    ln -f smoke-inputs.iso final-smoke-inputs.iso
  fi
  sha256sum -c --strict ASSET-SHA256SUMS
)
```

Review the PR scope and exact run. Compare `headSha` with the evidence head above, `event` with `pull_request` and `workflowName` with `Pirate VM final acceptance`. Verify the executed checkout and fixture against the artifact. Hash the returned guest tar and compare it to `RESULT.json.guestEvidenceArchiveSha256`. Then inspect `release-image.json` inside that archive for the product and image used by the guest.

```bash
gh pr diff 100 -R pirate-social-club/pirate-operators --name-only
gh run view 45950111683 -R pirate-social-club/pirate-operators --attempt 2 \
  --json headSha,workflowName,event,status,conclusion,url
gh run download 45950111683 -R pirate-social-club/pirate-operators \
  -n pirate-final-acceptance -D "$tmp/final"
```

## Guest evidence

GitHub artifact `15177229965` has ZIP SHA-256 `c3b2c3f35b3c0712c546fa15069c119ec460972be1955e6429c929cf35f0eba6`. The 286,720-byte guest tar hashes to `d63b504ec48ff699e5509b1d92e1f45ad7ea5612041e8be8075de56737dec3e0`, matching the host verdict and guest serial export. Each of the 25 manifest-listed files matched its digest in the independent review.

| Check | Verified fields |
|---|---|
| Overall result | `RESULT.json.result == "pass"`, `holdCodes == []`. The guest controller records `status == "PASS"` and `childExit == 0`. |
| Installation, publication and playback | `wizard-installed.json` and `wizard-reopened.json` exist. In both `notes-before.json` and `notes-after.json`, `playback.wire.range == 206` and `playback.analysis.ok == true`. The original publication proof is consistent across the receipts. |
| Restart and replay | `sameStore == true`, `oldAndNewBrowserDecoded == true` and `newEffectsOnReplay == 0`. The restart, reopened-original and replay receipts are present. |
| Guest terminal | `guestTerminal` is the five-element `evidence-sent, 0, 0` row with the matching cutoff and UTC terminal timestamp. |
| Host closure and isolation | `independentClosure == true`, `qemuExit == "0"` and `qemuProcessAfterWait == "absent"`. QEMU identity records `-m 4096` and `-nic none`. |
| Identity | `RESULT.json.imageId` and `release-image.json` match the pinned image. Installation `rehearsal-manual-7c35d469a654`, grant `0x2225de301a48537b7a412dc158cd8fa918a2d157aaf6df465e3b5a0db31e9985`, attachment `0x58c67144eff97a7c17b785018e22fa4dd1e7fa9f2febe3f1ec89798313fb3e49` and post `0xd00596cd4b13ff544c1c3d986019e2cfa2db049b64f767337e0d3843bcfe6e14` are the attempt-2 values. |

## Standalone install-only evidence

Run `45950111918` attempt 1 passed on the same head and executed checkout. Its artifact `15176905501` has ZIP SHA-256 `7b9f54e69a64f81b2d820814cb9a120fb48b9ffabfd886067eebbc8c308bbd92`. The guest evidence archive SHA-256 is `800f28d59dcf48c6bdee21cc7796f9dd7182a8066059da3578764c811fdb3cc3`; its manifest SHA-256 is `5e6b8cb7a12fafa9faae819ec612a23ddcc16bb33b02dfc7ba7ae8eecab1350a`. The result is `pass`, `installStatus == "PASS"`, `installPhase == "install-only-complete"`, both refusal fields null, `independentClosure == true`, `noVirtualNic == true`, and `qemuProcessAfterWait == "absent"`.

## Current-head attempt-1 boot failure

Final acceptance attempt 1 on the current head did not reach installation. Package checks and Docker daemon binding completed. `prepare-guest-smoke.sh` returned 1 after the smoke manifest checksum marker and before the entry media checksum marker. QEMU exited after about 38 seconds with an empty guest archive. The exact inner command remains unknown, and the failure is recorded as an intermittent media-preparation/boot failure. Attempt 2 reused the same Git inputs and completed the full journey. [Attempt 1](https://github.com/pirate-social-club/pirate-operators/actions/runs/45950111683/attempts/1)

## Historical false-green and earlier failures

The six historical green install-only workflows returned a held verifier verdict. Those runs were `45491608403`, `45497221664`, `45500341785`, `45500768688`, `45525879298` and `45539180872`. Their guest controllers passed. The verifier rejected ordinary zero-byte logs and the workflow lost its exit status. The repair retained existence and digest checks for every required file and propagated the verifier's exit. The audit preserves all six run IDs, the original receipts and the negative test for a missing file. [Historical audit](./OLD-WORKFLOW-AUDIT.json)

Earlier r13 through r21 final guests hit controller timeout, restart OOM, close-stall and verifier-archive failures. Those records remain relevant to the workflow repair history but are superseded for pilot qualification by the current r24 head evidence. A local r24 install diagnostic reproduced an `ingress-wait` 502 after container start with the container running and no OOM; repeated 36,292-file verification scans consumed substantial time in that sample. A causal performance claim still requires controlled comparison, and no timeout or verification rule was weakened.

## PR #99 correction

PR #99 head `8deb8593face31e90dd98031d60c631c7b06fa2f` contained neither VM workflow. CI run `45471920123` had four JUnit files with 680, 758, 695 and 663 direct `<testcase>` elements: 2,796 total, zero failures, zero errors and one skip. Summing `<testsuite>` attributes gave 97 and missed 2,699 direct testcase children.

The skip was intentional and conditional: `test/learning-sign-in-moss.test.ts` skips the hosted-bundle source/hash assertion when `MOSS_BUNDLE_PATH` is unset. No other CI check supplies that bundle or covers that assertion. The normal transcription/pattern tests still run, and `docs/learning-v4-rollout.md` explicitly leaves normal-UI MOSS and real-account ERC-1271 acceptance unqualified. The skip is therefore disclosed environment-gated coverage, not a hidden failure and not a claim of hosted-wallet acceptance.

The two acceptance traces in the r21 review were byte-identical, nine lines each, SHA-256 `eddc4308c3ef483c256e438c00d0dd99e95c2191baac971f39e777cf63e2ebf0`. The current r24 CI review likewise found the two nine-line acceptance traces byte-identical.

## Decision and subsequent work

At the reviewed head, GitHub reported 15 successful checks and one skipped Proof check. Main's strict required status is `release-ready`, and that check passed in general CI. PR #100 remains draft; disposition and merge ownership stay with the owner. [Workflow exit audit](./WORKFLOW-EXIT-AUDIT.md)

Reconcile this measured pilot with the release cold-placed on Fluence, run the disposable integrated rehearsal, measure foreground-to-Pair against five minutes and prepare both visit packets. Live arm, invite, registration and publication each require a separate Lane 6 GO.
