# Workflow exit-propagation audit

Scope: the PR #100 candidate working tree, all six historical install-only false-green runs, the close-timeout final run `45541957126`, and the newer final run `45544464948`. The exact candidate SHA is supplied with the reviewer handoff. Historical shared CI identities are `.github/ci` tree `4ba47b4c8b20acc04a3b73ffd81fccdc376df994`, final workflow blob `3604c60f04ac90ad5f5d0b674ba5a268fb5e1afd`, and install-only workflow blob `cf434ef813ca1f6fccbc76fe0e5890db89fcaa29`.

Reproduction commands:

```bash
git grep -n -E 'continue-on-error|\|\| true|\|\| :|set -[[:alnum:]]*e|pipefail|shell:' -- .github/workflows
git grep -n ' | ' -- .github/workflows
```

## Shell defaults

No workflow or job sets `shell:` or `defaults.run.shell`. The existing `defaults:` blocks set `run.working-directory`, not a shell. Ordinary Linux `run` steps therefore use GitHub Actions' default `bash -e`, without implicit `pipefail`. Every pipeline that can hide a producer failure has explicit `pipefail` in the same block.

## Pipefail citations

- `local.yml:52` sets `set -euo pipefail`; checksum pipelines are at `:59`, `:60`, `:62`, and `:64`.
- `web.yml:46` sets `set -euo pipefail`; the reproducibility pipeline is at `:48`.
- `pirate-vm-final-acceptance.yml:60` sets `set -uo pipefail`; the runner/`tee` pipeline is at `:64`, captures `rc`, and exits with it at `:70`.
- `pirate-vm-install-only.yml:57` sets `set -euo pipefail`; the runner/`tee` pipeline is at `:61`, captures `rc`, and exits with it at `:67`.
- Nested test shells use `set -euo pipefail` at `local.yml:74` and `:137`, `karaoke.yml:52`, and `study.yml:37`.

## Other exit paths

- No workflow contains `|| true` or `|| :` around a test, verifier, build, or acceptance command.
- `continue-on-error: true` appears only on first-attempt Foundry installation at `community-wizard.yml:25`, `karaoke.yml:23`, `local.yml:28`, and `local.yml:109`. Each is followed by a retry without `continue-on-error`; a failed retry fails the job.
- `ci.yml:59-60` uses `if: always()` with explicit `needs`; `ci.yml:74-77` requires every dependency result to equal `success`.
- `local.yml:156-157` uses `if: always()` with explicit `needs`; `local.yml:164-166` requires both root tests and offline acceptance to equal `success`.
- The VM artifact uploads are the remaining relevant `if: always()` steps: `pirate-vm-final-acceptance.yml:72` and `pirate-vm-install-only.yml:69`. Other artifact uploads remain at `community-wizard.yml:51`, `karaoke.yml:58`, `local.yml:84` and `:146`, `study.yml:42`, and `web.yml:50`.

The fixture trust check runs before asset verification, host-runner extraction, or guest execution. A manifest digest mismatch exits nonzero. The final verifier test runs against the packaged r17 verifier before preflight. A held final verdict remains nonzero and is propagated through the runner/`tee` pipeline.

Conclusion: no additional unpropagated test or verifier exit was found. The workflow changes add trust and evidence checks; they do not weaken an exit path.
