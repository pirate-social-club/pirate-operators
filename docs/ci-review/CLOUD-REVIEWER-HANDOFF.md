# Pirate v1 cloud reviewer handoff

## What passed

Four independent 4 GiB runs completed the offline pilot journey. The fourth tested the approved timeout change on PR head `db1faa1cf0d2664a9d1cf9092816dd9a002174b2`. Initial pairing kept its 120-second limit. Only pairing after an ordinary restart had 300 seconds. The guest installed, published, verified HTTPS audio playback twice on the same Store and replayed with zero new effects. Each guest returned an empty hold list and clean closure. The audio evidence comes from browser decoding and analysis. [Exact-head final acceptance](https://github.com/pirate-social-club/pirate-operators/actions/runs/45761666797)

| Run and attempt | Head | Initial / restart limits (s) | Initial / restart measured (s) | Samples | Lowest guest MemAvailable (MiB) |
|---|---|---:|---:|---:|---:|
| [45725776096 · 1](https://github.com/pirate-social-club/pirate-operators/actions/runs/45725776096/attempts/1) | `e753451` | 300 / 300 | 17.031 / 137.948 | 269 | 69.9 |
| [45729825351 · 1](https://github.com/pirate-social-club/pirate-operators/actions/runs/45729825351/attempts/1) | `e753451` | 300 / 300 | 17.033 / 127.378 | 302 | 45.2 |
| [45732354057 · 2](https://github.com/pirate-social-club/pirate-operators/actions/runs/45732354057/attempts/2) | `c4ec3ff` | 300 / 300 | 17.026 / 128.318 | 293 | 96.2 |
| [45761666797 · 1](https://github.com/pirate-social-club/pirate-operators/actions/runs/45761666797/attempts/1) | `db1faa1` | 120 / 300 | 17.036 / 138.771 | 268 | 75.6 |

Pair times are elapsed between guest `service-pair-wait` enter and return markers. They measure the service handshake. The five-minute Fluence foreground-to-Pair gate requires its own measurement from the operator-facing starting point. Every measured restart exceeded 120 seconds. On the fourth run, launcher ArrayBuffers ranged from 22.0 to 36.2 MiB during the restart wait. The lowest sampled guest headroom across all four was 45.2 MiB. These measurements apply to this pilot product and image. Main shares the streaming verifier module. Its whole-system behavior requires its own run.

## Source, checkout and fixture

| Identity | Accepted value |
|---|---|
| Evidence head (PR #100) | `db1faa1cf0d2664a9d1cf9092816dd9a002174b2` |
| Executed synthetic merge | `039022b207779448520c3786e96878a9df78d674` |
| Base at run time | `a35d3c0fc89e21b0d19aea91d4edb6240301fca7` |
| Pilot product head / tree | `299ebfe5ccb0371f7b2b0c6e8ef3fe2cf5ffce21` / `3f13269b483f4ed3367c24de97138e0c532dc843` |
| Guest image | `sha256:3088dd47364de4878a76dc50047089612fcbec2b885124d9fa70bdd568428565` |
| Fixture release / unchanged assets | `pirate-v1-staging-vm-fixtures-20261125-r21` / `pirate-v1-staging-vm-fixtures-20261125-r13` |
| Git pin path | `.github/ci/vm-fixtures-r20.json` |

The first two runs checked out the dispatched head directly. The third and fourth used GitHub pull-request merge checkouts. For the fourth, the head-object fields in `RUN-IDENTITY.json` are null. Its checkout-object fields are present and match the three Git objects at the PR head. Full run, attempt, checkout, artifact and archive identities are in `currentReview.passingFinalRuns`. [Machine-readable audit](./OLD-WORKFLOW-AUDIT.json)

## Trust and reproduction

Obtain the **documentation commit SHA** and the **r21 `ASSET-SHA256SUMS` SHA-256** directly from the owner, outside the release. Retrieve all three documents from `docs/ci-review/` at that commit. Release assets can be replaced. Never take an expected hash from the release or from the document being verified. The JSON configuration file has its own SHA-256. The checksum-list hash is the value recorded in its `manifestSha256` field.

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
(cd "$tmp/assets" && sha256sum -c --strict ASSET-SHA256SUMS)
```

Review the PR scope and exact run. Compare `headSha` with the evidence head above, `event` with `pull_request` and `workflowName` with `Pirate VM final acceptance`. Verify the executed checkout and fixture against the artifact. Hash the returned guest tar and compare it to `RESULT.json.guestEvidenceArchiveSha256`. Then inspect `release-image.json` inside that archive for the product and image used by the guest.

```bash
gh pr diff 100 -R pirate-social-club/pirate-operators --name-only
gh run view 45761666797 -R pirate-social-club/pirate-operators --attempt 1 \
  --json headSha,workflowName,event,status,conclusion,url
gh run download 45761666797 -R pirate-social-club/pirate-operators \
  -n pirate-final-acceptance -D "$tmp/final"
```

## Guest evidence

| Check | Fields to verify |
|---|---|
| Overall result | `RESULT.json.result == "pass"`, `holdCodes == []`. The guest controller records `status == "PASS"` and `childExit == 0`. |
| Installation, publication and playback | `wizard-installed.json` and `wizard-reopened.json` exist. In both `notes-before.json` and `notes-after.json`, `playback.wire.range == 206` and `playback.analysis.ok == true`. Check the original publication proof across both receipts. |
| Restart and replay | `sameStore == true`, `oldAndNewBrowserDecoded == true` and `newEffectsOnReplay == 0` in the result. The restart, reopened-original and replay receipts are present. `resources.json` also reports zero new effects on replay. |
| Guest terminal | `guestTerminal` has one five-element row. Position 0 is the stage (`evidence-sent`), 1 the return code (`"0"`), 2 the cleanup result (`"0"`), 3 the cutoff in milliseconds (exact text of `WORKER-CUTOFF-MS.txt`, trimmed), and 4 the guest UTC terminal timestamp. |
| Host closure and isolation | `independentClosure == true`, `qemuExit == "0"` and `qemuProcessAfterWait == "absent"`. Read `-m 4096` and `-nic none` in `QEMU-IDENTITY.json.argv` and check for the absence of `-netdev` and `-virtfs`. `isolation.json` records `guestUplink == "no-virtual-nic"` and `hostAndBrowserEgress == "denied"`. |
| Identity | Compare `RESULT.json.imageId` and `release-image.json` with the pin. Verify the installation ID, grant ID, attachment digest and post ID in the result. |

## Standalone install-only evidence

Run `45761666749` passed installation, cleanup and isolation. Its host identity records r21. In its guest serial, `PIRATE_SMOKE_INPUTS` names product `34f73d22f794e499a9bf86b22311629dcd2e000a`, tree `94e58bd43806e484d5a85cf3ad144194c3d9f724` and image `sha256:eadd63a378767e660337c2f3b2b594ad0c869ebeebada873a7a06bc9b6194a23`. The four full journeys separately verify installation on the successor. Regenerate the standalone media for `299ebfe` and check identities in the packed inputs and in a passing guest's serial against the full r21 product head, tree and image above. [Standalone install-only run](https://github.com/pirate-social-club/pirate-operators/actions/runs/45761666749)

## Earlier failures

The six historical green install-only workflows returned a held verifier verdict. Those runs were `45491608403`, `45497221664`, `45500341785`, `45500768688`, `45525879298` and `45539180872`. Their guest controllers passed. The verifier rejected ordinary zero-byte logs and the workflow lost its exit status. The repair retained existence and digest checks for every required file and propagated the verifier's exit. The audit preserves all six run IDs, the original receipts and the negative test for a missing file. [Historical audit](./OLD-WORKFLOW-AUDIT.json)

The earlier r13 final run `45541957126` used head `96e95edf38d6add084aea1ebcc4329f68af4e2b3` and ended with a controller timeout and cleanup 1. Later progress markers put the surviving-run stall before the launcher's `close()` entry. Other earlier guests experienced kernel-confirmed restart OOM kills. The recent passes measure the successor's restart window. The install-502 receipt identifies `install-apply` with a running container and an unknown throw site. A race with the 60-second ingress deadline remains a hypothesis. [Historical run-by-run evidence](https://github.com/pirate-social-club/pirate-operators/blob/db1faa1cf0d2664a9d1cf9092816dd9a002174b2/docs/ci-review/CLOUD-REVIEWER-HANDOFF.md#terminal-evidence)

```bash
gh api repos/pirate-social-club/pirate-operators/commits/0240c7c99b090d2dde2edc7dbd49c57af8a215d1 \
  --jq '.sha, .commit.message, (.files[].filename)'
gh run view 45541957126 -R pirate-social-club/pirate-operators \
  --json headSha,workflowName,event,conclusion
gh api 'repos/pirate-social-club/pirate-operators/contents/.github/workflows/pirate-vm-final-acceptance.yml?ref=96e95edf38d6add084aea1ebcc4329f68af4e2b3' \
  -H 'Accept: application/vnd.github.raw+json' | grep -F pirate-v1-staging-vm-fixtures-20261125-r13
```

## PR #99 correction

PR #99 head `8deb8593face31e90dd98031d60c631c7b06fa2f` contained neither VM workflow. CI run `45471920123` has four JUnit files with 680, 758, 695 and 663 direct `<testcase>` elements: 2,796 total, zero failures, zero errors and one skip. Summing `<testsuite>` attributes gives 97 and misses 2,699 direct testcase children.

The skip is intentional and conditional: `test/learning-sign-in-moss.test.ts` skips the hosted-bundle source/hash assertion when `MOSS_BUNDLE_PATH` is unset. No other CI check supplies that bundle or covers that assertion. The normal transcription/pattern tests still run, and `docs/learning-v4-rollout.md` explicitly leaves normal-UI MOSS and real-account ERC-1271 acceptance unqualified. The skip is therefore disclosed environment-gated coverage, not a hidden failure and not a claim of hosted-wallet acceptance.

The two acceptance traces are byte-identical, nine lines each, SHA-256 `eddc4308c3ef483c256e438c00d0dd99e95c2191baac971f39e777cf63e2ebf0`.

## Decision and subsequent updates

At the reviewed head, GitHub reported 15 successful checks and one skipped Proof check. The CI caller passed on attempt 2. Main's ruleset required `release-ready` on a current base. Its aggregate lists seven dependencies. The two VM workflows have their own results. [CI attempt 2](https://github.com/pirate-social-club/pirate-operators/actions/runs/45761666746/attempts/2) · [Workflow exit audit](./WORKFLOW-EXIT-AUDIT.md)

After updating the PR from main, compare the new `.github/ci` tree and both VM workflow blobs with the accepted checkout objects stored in `currentReview.checkoutObjects`. Confirm the full pilot head, tree, image, fixture release and manifest against the accepted guest and run identity. In a clone containing both commits, the following comparison must exit zero. If any input changes or identity cannot be established, rerun final acceptance and record its new identities.

```bash
git diff --exit-code db1faa1cf0d2664a9d1cf9092816dd9a002174b2 "${NEW_HEAD:?set the updated PR commit}" -- \
  .github/ci/ .github/workflows/pirate-vm-final-acceptance.yml .github/workflows/pirate-vm-install-only.yml
```

Reconcile this measured pilot with the release cold-placed on Fluence, run the disposable integrated rehearsal, measure foreground-to-Pair against five minutes and prepare both visit packets. Live arm, invite, registration and publication each require a separate Lane 6 GO.
