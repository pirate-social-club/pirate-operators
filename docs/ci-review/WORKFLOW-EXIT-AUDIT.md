# Workflow exit-propagation audit

Scope: every workflow present on PR #100 head `96e95edf38d6add084aea1ebcc4329f68af4e2b3` (nine files), plus every workflow on `main` at `b18e2764b63d56f065ca0fb7d40b8a92bb889796` (seven files).

Reproduction command:

```bash
git grep -n -E 'continue-on-error|\|\| true|\|\| :|set -[[:alnum:]]*e|pipefail|shell:' \
  96e95edf38d6add084aea1ebcc4329f68af4e2b3 -- .github/workflows
git grep -n ' | ' 96e95edf38d6add084aea1ebcc4329f68af4e2b3 -- .github/workflows
```

## Shell defaults

No workflow or job sets `shell:` or `defaults.run.shell` at head `96e95ed`. The only `defaults:` blocks are `community-wizard.yml:11`, `creator-spike.yml:11`, and `web.yml:11`; they set `run.working-directory`, not a shell.

Therefore ordinary Linux `run` steps use GitHub Actions' default `bash -e`, without implicit `pipefail`. Every pipeline that can hide a producer failure has an explicit `set -uo pipefail` or `set -euo pipefail` in the same block.

## Pipefail citations

- `local.yml:52` sets `set -euo pipefail`; checksum pipelines are at `local.yml:59`, `:60`, `:62`, and `:64`.
- `web.yml:46` sets `set -euo pipefail`; the reproducibility pipeline is at `web.yml:48`.
- `pirate-vm-final-acceptance.yml:46` sets `set -uo pipefail`; the runner/`tee` pipeline is at `:50`, captures `rc`, and exits with it at `:56`.
- `pirate-vm-install-only.yml:45` sets `set -euo pipefail`; the runner/`tee` pipeline is at `:49`, captures `rc`, and exits with it at `:55`.
- Nested test shells use `set -euo pipefail` at `local.yml:74` and `:137`, `karaoke.yml:52`, and `study.yml:37`.

## Other exit paths

- No workflow contains `|| true` or `|| :` around a test, verifier, build, or acceptance command.
- `continue-on-error: true` appears only on first-attempt Foundry installation at `community-wizard.yml:25`, `karaoke.yml:23`, `local.yml:28`, and `local.yml:109`. Each is followed by a retry without `continue-on-error`; a failed retry fails the job.
- `ci.yml:59-60` uses `if: always()` with explicit `needs`; `ci.yml:74-77` requires every dependency result to equal `success`.
- `local.yml:156-157` uses `if: always()` with explicit `needs`; `local.yml:164-166` requires both root tests and offline acceptance to equal `success`.
- Remaining `if: always()` steps are artifact uploads: `community-wizard.yml:51`, `karaoke.yml:58`, `local.yml:84` and `:146`, `pirate-vm-final-acceptance.yml:58`, `pirate-vm-install-only.yml:57`, `study.yml:42`, and `web.yml:50`.

Conclusion: no additional unpropagated test or verifier exit was found. No workflow behavior was changed by this audit.
